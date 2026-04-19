/**
 * relay-manager.ts
 * Manages persistent TCP connections to remote eQSO servers (ASORAPA, etc.).
 * Each relay stays connected independently of any browser session.
 * Audio received from the remote server is forwarded to local WebSocket browsers.
 */

import { randomUUID } from "crypto";
import { logger } from "../lib/logger";
import { db, relayConnectionsTable } from "@workspace/db";
import { EqsoProxy, ProxyEvent } from "./eqso-proxy";
import { FfmpegGsmDecoder, GSM_PACKET_BYTES } from "./ffmpeg-gsm";
import { AUDIO_PAYLOAD_SIZE } from "./protocol";
import { roomManager } from "./room-manager";
import { eq } from "drizzle-orm";

const WS_AUDIO_REMOTE = 0x11;

const MIN_RECONNECT_MS = 3_000;
const MAX_RECONNECT_MS = 60_000;

export interface RelayStatus {
  id: number;
  label: string;
  callsign: string;
  server: string;
  port: number;
  room: string;
  localRoom: string;
  enabled: boolean;
  status: "connecting" | "connected" | "disconnected" | "stopped";
  connectedAt: number | null;
  rxPackets: number;
  usersInRoom: string[];
}

interface ManagedRelay {
  dbId: number;
  label: string;
  callsign: string;
  server: string;
  port: number;
  room: string;
  password: string;
  message: string;
  localRoom: string;
  status: "connecting" | "connected" | "disconnected" | "stopped";
  connectedAt: number | null;
  rxPackets: number;
  usersInRoom: string[];
  proxy: EqsoProxy | null;
  decoder: FfmpegGsmDecoder | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  reconnectDelay: number;
  stopped: boolean;
}

class RelayManager {
  private relays = new Map<number, ManagedRelay>();

  async loadAndStart(): Promise<void> {
    try {
      const rows = await db.select().from(relayConnectionsTable);
      for (const row of rows) {
        if (row.enabled) {
          this.startRelay(row);
        } else {
          this.relays.set(row.id, this.makeStoppedRelay(row));
        }
      }
      logger.info({ count: rows.length }, "Relay manager: loaded relay configs");
    } catch (err) {
      logger.warn({ err }, "Relay manager: failed to load relays (non-fatal)");
    }
  }

  private makeStoppedRelay(cfg: {
    id: number; label: string; callsign: string; server: string; port: number;
    room: string; password: string; message: string; localRoom: string;
  }): ManagedRelay {
    return {
      dbId: cfg.id,
      label: cfg.label,
      callsign: cfg.callsign,
      server: cfg.server,
      port: cfg.port,
      room: cfg.room,
      password: cfg.password,
      message: cfg.message,
      localRoom: cfg.localRoom || cfg.room,
      status: "stopped",
      connectedAt: null,
      rxPackets: 0,
      usersInRoom: [],
      proxy: null,
      decoder: null,
      reconnectTimer: null,
      reconnectDelay: MIN_RECONNECT_MS,
      stopped: true,
    };
  }

  private startRelay(cfg: {
    id: number; label: string; callsign: string; server: string; port: number;
    room: string; password: string; message: string; localRoom: string;
  }): void {
    const existing = this.relays.get(cfg.id);
    if (existing && !existing.stopped) return;

    const relay: ManagedRelay = {
      dbId: cfg.id,
      label: cfg.label,
      callsign: cfg.callsign,
      server: cfg.server,
      port: cfg.port,
      room: cfg.room,
      password: cfg.password,
      message: cfg.message,
      localRoom: cfg.localRoom || cfg.room,
      status: "connecting",
      connectedAt: null,
      rxPackets: 0,
      usersInRoom: [],
      proxy: null,
      decoder: null,
      reconnectTimer: null,
      reconnectDelay: MIN_RECONNECT_MS,
      stopped: false,
    };
    this.relays.set(cfg.id, relay);
    this.connect(relay);
  }

  private resolvedCallsign(callsign: string): string {
    const cs = callsign.toUpperCase().trim();
    if (cs.startsWith("0R-")) return cs.slice(0, 13);
    return `0R-${cs}`.slice(0, 13);
  }

  private connect(relay: ManagedRelay): void {
    if (relay.stopped) return;

    const callsign = this.resolvedCallsign(relay.callsign);
    const proxy = new EqsoProxy(relay.server, relay.port);
    relay.proxy = proxy;
    relay.status = "connecting";
    relay.usersInRoom = [];

    const decoder = new FfmpegGsmDecoder();
    relay.decoder = decoder;
    decoder.start();

    decoder.on("pcm", (pcm: Int16Array) => {
      const float32 = new Float32Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) {
        float32[i] = Math.max(-0.85, Math.min(0.85, pcm[i] / 32768));
      }
      const payload = Buffer.from(float32.buffer);
      const pkt = Buffer.allocUnsafe(1 + payload.length);
      pkt[0] = WS_AUDIO_REMOTE;
      payload.copy(pkt, 1);
      roomManager.broadcastBinToLocalWsClients(relay.localRoom, pkt);
    });

    proxy.on("event", (ev: ProxyEvent) => {
      switch (ev.type) {
        case "connected":
          relay.status = "connected";
          relay.connectedAt = Date.now();
          relay.reconnectDelay = MIN_RECONNECT_MS;
          logger.info({ id: relay.dbId, label: relay.label, callsign }, "Relay: connected to remote server");
          proxy.sendJoin(callsign, relay.room, relay.message, relay.password);
          break;

        case "members":
          relay.usersInRoom = Array.isArray(ev.data)
            ? (ev.data as { name: string }[]).map(m => m.name)
            : [];
          break;

        case "user_joined": {
          const u = ev.data as { name: string };
          if (!relay.usersInRoom.includes(u.name)) relay.usersInRoom.push(u.name);
          break;
        }

        case "user_left": {
          const u = ev.data as { name: string };
          relay.usersInRoom = relay.usersInRoom.filter(n => n !== u.name);
          break;
        }

        case "audio": {
          const pkt = ev.data as Buffer;
          if (pkt.length < 1 + AUDIO_PAYLOAD_SIZE) break;
          relay.rxPackets++;
          const gsmBuf = Buffer.from(
            pkt.buffer,
            pkt.byteOffset + 1,
            Math.min(AUDIO_PAYLOAD_SIZE, GSM_PACKET_BYTES)
          );
          decoder.decode(gsmBuf);
          break;
        }

        case "disconnected":
        case "error":
          relay.status = "disconnected";
          relay.connectedAt = null;
          relay.usersInRoom = [];
          try { decoder.stop(); } catch { /* ignore */ }
          relay.decoder = null;
          if (!relay.stopped) {
            logger.warn({ id: relay.dbId, label: relay.label, delay: relay.reconnectDelay }, "Relay: disconnected — scheduling reconnect");
            relay.reconnectTimer = setTimeout(() => {
              relay.reconnectDelay = Math.min(relay.reconnectDelay * 2, MAX_RECONNECT_MS);
              this.connect(relay);
            }, relay.reconnectDelay);
          }
          break;
      }
    });

    proxy.connect();
  }

  private doStop(relay: ManagedRelay): void {
    relay.stopped = true;
    relay.status = "stopped";
    if (relay.reconnectTimer) {
      clearTimeout(relay.reconnectTimer);
      relay.reconnectTimer = null;
    }
    if (relay.proxy) {
      try { relay.proxy.disconnect(); } catch { /* ignore */ }
      relay.proxy = null;
    }
    if (relay.decoder) {
      try { relay.decoder.stop(); } catch { /* ignore */ }
      relay.decoder = null;
    }
    relay.usersInRoom = [];
    relay.connectedAt = null;
  }

  getStatus(): RelayStatus[] {
    return Array.from(this.relays.values()).map(r => ({
      id: r.dbId,
      label: r.label,
      callsign: r.callsign,
      server: r.server,
      port: r.port,
      room: r.room,
      localRoom: r.localRoom,
      enabled: !r.stopped,
      status: r.status,
      connectedAt: r.connectedAt,
      rxPackets: r.rxPackets,
      usersInRoom: r.usersInRoom,
    }));
  }

  async enableRelay(id: number): Promise<void> {
    await db.update(relayConnectionsTable).set({ enabled: true }).where(eq(relayConnectionsTable.id, id));
    const rows = await db.select().from(relayConnectionsTable).where(eq(relayConnectionsTable.id, id));
    if (rows[0]) {
      const existing = this.relays.get(id);
      if (existing) this.doStop(existing);
      this.startRelay(rows[0]);
    }
  }

  async disableRelay(id: number): Promise<void> {
    await db.update(relayConnectionsTable).set({ enabled: false }).where(eq(relayConnectionsTable.id, id));
    const relay = this.relays.get(id);
    if (relay) {
      this.doStop(relay);
      relay.stopped = true;
      relay.status = "stopped";
    }
  }

  async deleteRelay(id: number): Promise<void> {
    const relay = this.relays.get(id);
    if (relay) this.doStop(relay);
    this.relays.delete(id);
    await db.delete(relayConnectionsTable).where(eq(relayConnectionsTable.id, id));
  }

  async createRelay(data: {
    label: string; callsign: string; server: string; port: number;
    room: string; password: string; message: string; localRoom: string; enabled: boolean;
  }): Promise<number> {
    const [row] = await db.insert(relayConnectionsTable).values({
      label: data.label, callsign: data.callsign, server: data.server,
      port: data.port, room: data.room, password: data.password,
      message: data.message, localRoom: data.localRoom, enabled: data.enabled,
    }).returning({ id: relayConnectionsTable.id });

    if (!row) throw new Error("No se pudo crear el radioenlace");

    const rows = await db.select().from(relayConnectionsTable).where(eq(relayConnectionsTable.id, row.id));
    if (rows[0]) {
      if (data.enabled) {
        this.startRelay(rows[0]);
      } else {
        this.relays.set(row.id, this.makeStoppedRelay(rows[0]));
      }
    }
    return row.id;
  }

  async updateRelay(id: number, data: {
    label: string; callsign: string; server: string; port: number;
    room: string; password: string; message: string; localRoom: string; enabled: boolean;
  }): Promise<void> {
    const existing = this.relays.get(id);
    if (existing) this.doStop(existing);
    this.relays.delete(id);

    await db.update(relayConnectionsTable).set({
      label: data.label, callsign: data.callsign, server: data.server,
      port: data.port, room: data.room, password: data.password,
      message: data.message, localRoom: data.localRoom, enabled: data.enabled,
    }).where(eq(relayConnectionsTable.id, id));

    const rows = await db.select().from(relayConnectionsTable).where(eq(relayConnectionsTable.id, id));
    if (rows[0]) {
      if (data.enabled) {
        this.startRelay(rows[0]);
      } else {
        this.relays.set(id, this.makeStoppedRelay(rows[0]));
      }
    }
  }
}

export const relayManager = new RelayManager();
