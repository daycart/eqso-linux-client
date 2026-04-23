import { logger } from "../lib/logger";
import { db, relayConnectionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { EqsoProxy, type ProxyEvent } from "./eqso-proxy";
import { roomManager } from "./room-manager";
import { AUDIO_PAYLOAD_SIZE } from "./protocol";
import { buildPttStarted, buildPttReleased, buildUserJoined, buildUserLeft } from "./protocol";
import { GsmDecoder } from "./gsm610";

interface RelayConfig {
  id: number;
  label: string;
  callsign: string;
  server: string;
  port: number;
  localRoom: string;
  remoteRoom: string;
  password: string;
  enabled: boolean;
}

interface RelayState {
  config: RelayConfig;
  proxy: EqsoProxy | null;
  status: "connecting" | "connected" | "disconnected";
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  pttTimeout: ReturnType<typeof setTimeout> | null;
  reconnectAttempts: number;
  rxPackets: number;
  txPackets: number;
  remoteUsers: string[];
  transmitting: boolean;
  decoder: GsmDecoder;
}

const MAX_RECONNECT_DELAY_MS = 10_000;
const PTT_INACTIVITY_TIMEOUT_MS = 5_000;

class RelayManager {
  private relays = new Map<number, RelayState>();

  async init(): Promise<void> {
    try {
      const rows = await db.select().from(relayConnectionsTable);
      for (const row of rows) {
        const config: RelayConfig = {
          id: row.id,
          label: row.label,
          callsign: row.callsign,
          server: row.server,
          port: row.port,
          localRoom: row.localRoom,
          remoteRoom: row.remoteRoom,
          password: row.password,
          enabled: row.enabled,
        };
        if (row.enabled) {
          this.startRelay(config);
        } else {
          this.relays.set(row.id, this.makeState(config));
        }
      }
      logger.info({ count: rows.length }, "RelayManager: loaded relay configurations");
    } catch (err) {
      logger.warn({ err }, "RelayManager: failed to load relay configurations (non-fatal)");
    }
  }

  private makeState(config: RelayConfig): RelayState {
    return {
      config,
      proxy: null,
      status: "disconnected",
      reconnectTimer: null,
      pttTimeout: null,
      reconnectAttempts: 0,
      rxPackets: 0,
      txPackets: 0,
      remoteUsers: [],
      transmitting: false,
      decoder: new GsmDecoder(),
    };
  }

  startRelay(config: RelayConfig): void {
    const existing = this.relays.get(config.id);
    if (existing) {
      this.stopRelay(config.id, false);
    }

    const state = this.makeState(config);
    this.relays.set(config.id, state);

    const listenerId = `relay-${config.id}`;

    // Subscribe to local room: forward local audio/PTT to remote server
    roomManager.addRoomListener(listenerId, [config.localRoom], (_room, data, senderId) => {
      if (senderId === listenerId) return; // prevent echo of own inbound broadcasts
      if (!state.proxy || state.status !== "connected") return;

      // 0x16 PTT start / PTT release packet
      if (data[0] === 0x16 && data.length >= 10 && data[1] === 0x01) {
        const action = data[5];
        if (action === 0x02) {
          state.proxy.startTransmitting();
          state.transmitting = true;
        } else if (action === 0x03) {
          if (state.transmitting) {
            state.proxy.sendPttEnd();
            state.transmitting = false;
          }
          if (state.pttTimeout) { clearTimeout(state.pttTimeout); state.pttTimeout = null; }
        }
        return;
      }

      // [0x01][198 bytes GSM] audio from a local client → forward to remote server
      if (data[0] === 0x01 && data.length === 1 + AUDIO_PAYLOAD_SIZE) {
        state.proxy.sendAudio(data.slice(1));
        state.txPackets++;

        // Safety timeout: if no more audio arrives within PTT_INACTIVITY_TIMEOUT_MS, release PTT
        if (state.pttTimeout) clearTimeout(state.pttTimeout);
        state.pttTimeout = setTimeout(() => {
          state.pttTimeout = null;
          if (state.transmitting && state.proxy) {
            state.proxy.sendPttEnd();
            state.transmitting = false;
            logger.warn({ relay: config.label }, "RelayManager: PTT auto-released (inactivity timeout)");
          }
        }, PTT_INACTIVITY_TIMEOUT_MS);
      }
    });

    this.connectProxy(state, listenerId);
  }

  private connectProxy(state: RelayState, listenerId: string): void {
    const { config } = state;
    state.status = "connecting";
    state.remoteUsers = [];

    const proxy = new EqsoProxy(config.server, config.port);
    state.proxy = proxy;

    proxy.on("event", (event: ProxyEvent) => {
      switch (event.type) {
        case "connected":
          state.status = "connected";
          state.reconnectAttempts = 0;
          proxy.sendJoin(config.callsign, config.remoteRoom, "", config.password);
          logger.info({ relay: config.label, server: config.server, room: config.remoteRoom }, "RelayManager: relay connected");
          break;

        case "disconnected":
        case "error":
          state.status = "disconnected";
          state.remoteUsers = [];
          state.proxy = null;
          if (state.transmitting) {
            state.transmitting = false;
            if (state.pttTimeout) { clearTimeout(state.pttTimeout); state.pttTimeout = null; }
          }
          if (config.enabled) this.scheduleReconnect(state, listenerId);
          break;

        case "audio": {
          const audioPkt = event.data as Buffer; // [0x01][198 bytes GSM]
          // Send raw GSM packet to TCP eQSO clients and other relay listeners
          roomManager.broadcastToTcpAndRelays(config.localRoom, audioPkt, listenerId);
          // Decode GSM → Float32 and send to WS browser clients
          if (audioPkt.length >= 1 + AUDIO_PAYLOAD_SIZE) {
            const gsmPayload = new Uint8Array(audioPkt.buffer, audioPkt.byteOffset + 1, AUDIO_PAYLOAD_SIZE);
            const pcm = state.decoder.decodePacket(gsmPayload);
            const float32 = new Float32Array(pcm.length);
            for (let i = 0; i < pcm.length; i++) {
              float32[i] = Math.max(-0.45, Math.min(0.45, pcm[i] / 32768.0));
            }
            const wsPkt = Buffer.concat([Buffer.from([0x11]), Buffer.from(float32.buffer)]);
            roomManager.broadcastBinToLocalWsClients(config.localRoom, wsPkt, listenerId);
          }
          state.rxPackets++;
          break;
        }

        case "ptt_started": {
          const d = event.data as { name: string };
          roomManager.broadcastToRoom(config.localRoom, buildPttStarted(d.name), listenerId);
          break;
        }

        case "ptt_released": {
          const d = event.data as { name: string };
          roomManager.broadcastToRoom(config.localRoom, buildPttReleased(d.name), listenerId);
          break;
        }

        case "user_joined": {
          const d = event.data as { name: string; message: string };
          if (!state.remoteUsers.includes(d.name)) state.remoteUsers.push(d.name);
          roomManager.broadcastToRoom(config.localRoom, buildUserJoined(d.name, d.message ?? ""), listenerId);
          break;
        }

        case "user_left": {
          const d = event.data as { name: string };
          state.remoteUsers = state.remoteUsers.filter(n => n !== d.name);
          roomManager.broadcastToRoom(config.localRoom, buildUserLeft(d.name), listenerId);
          break;
        }

        case "members": {
          const members = event.data as { name: string }[];
          if (Array.isArray(members)) {
            state.remoteUsers = members.map(m => m.name);
          }
          break;
        }

        default:
          break;
      }
    });

    proxy.connect();
  }

  private scheduleReconnect(state: RelayState, listenerId: string): void {
    if (state.reconnectTimer) return;
    const delay = Math.min(MAX_RECONNECT_DELAY_MS, 1000 * Math.pow(2, state.reconnectAttempts));
    state.reconnectAttempts++;
    logger.info({ relay: state.config.label, delay, attempt: state.reconnectAttempts }, "RelayManager: scheduling reconnect");
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      this.connectProxy(state, listenerId);
    }, delay);
  }

  stopRelay(configId: number, removeListener = true): void {
    const state = this.relays.get(configId);
    if (!state) return;

    if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
    if (state.pttTimeout) { clearTimeout(state.pttTimeout); state.pttTimeout = null; }

    if (state.transmitting && state.proxy) {
      try { state.proxy.sendPttEnd(); } catch {}
      state.transmitting = false;
    }

    state.proxy?.disconnect();
    state.proxy = null;
    state.status = "disconnected";
    state.remoteUsers = [];

    if (removeListener) roomManager.removeRoomListener(`relay-${configId}`);

    logger.info({ relay: state.config.label }, "RelayManager: relay stopped");
  }

  /** Reload config from DB and restart a single relay. */
  async reloadRelay(configId: number): Promise<void> {
    try {
      const [row] = await db.select().from(relayConnectionsTable).where(eq(relayConnectionsTable.id, configId));
      if (!row) {
        this.stopRelay(configId);
        this.relays.delete(configId);
        return;
      }
      const config: RelayConfig = {
        id: row.id,
        label: row.label,
        callsign: row.callsign,
        server: row.server,
        port: row.port,
        localRoom: row.localRoom,
        remoteRoom: row.remoteRoom,
        password: row.password,
        enabled: row.enabled,
      };
      if (row.enabled) {
        this.startRelay(config);
      } else {
        this.stopRelay(configId);
        this.relays.set(configId, this.makeState(config));
      }
    } catch (err) {
      logger.warn({ err, configId }, "RelayManager.reloadRelay: error");
    }
  }

  deleteRelay(configId: number): void {
    this.stopRelay(configId);
    this.relays.delete(configId);
  }

  getStatus(): {
    id: number; label: string; callsign: string; server: string; port: number;
    localRoom: string; remoteRoom: string; enabled: boolean;
    status: "connecting" | "connected" | "disconnected";
    remoteUsers: string[]; rxPackets: number; txPackets: number;
  }[] {
    return Array.from(this.relays.values()).map(s => ({
      id:          s.config.id,
      label:       s.config.label,
      callsign:    s.config.callsign,
      server:      s.config.server,
      port:        s.config.port,
      localRoom:   s.config.localRoom,
      remoteRoom:  s.config.remoteRoom,
      enabled:     s.config.enabled,
      status:      s.status,
      remoteUsers: s.remoteUsers,
      rxPackets:   s.rxPackets,
      txPackets:   s.txPackets,
    }));
  }
}

export const relayManager = new RelayManager();
