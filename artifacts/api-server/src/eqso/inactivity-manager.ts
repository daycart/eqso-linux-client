import { spawn } from "child_process";
import path from "path";
import fs from "fs/promises";
import { existsSync } from "fs";
import { logger } from "../lib/logger";
import { roomManager } from "./room-manager";
import { buildPttStarted, buildPttReleased, buildUserJoined, buildUserLeft, AUDIO_PAYLOAD_SIZE } from "./protocol";
import { db } from "@workspace/db";
import { systemSettingsTable } from "@workspace/db";
import { sql } from "drizzle-orm";

const PACKET_INTERVAL_MS = 120;
const REMOTE_CHUNK_SAMPLES = 960;
const SERVER_CALLSIGN = "SERVIDOR";
const DEFAULT_TIMEOUT_MIN = 10;
const DEFAULT_AUDIO_FILE = path.join(process.cwd(), "audio", "inactivity.wav");

class InactivityManager {
  private lastActivity = new Map<string, number>();
  private enabled = false;
  private timeoutMs = DEFAULT_TIMEOUT_MIN * 60 * 1000;
  private audioFile = process.env.INACTIVITY_AUDIO_FILE ?? DEFAULT_AUDIO_FILE;
  private checkTimer: ReturnType<typeof setInterval> | null = null;
  private playing = new Set<string>();

  // ── Startup: load persisted config from DB ────────────────────────────────

  async init(): Promise<void> {
    try {
      const rows = await db.select().from(systemSettingsTable);
      const map = new Map(rows.map(r => [r.key, r.value]));
      const savedEnabled = map.get("inactivity_enabled");
      const savedTimeout = map.get("inactivity_timeout_min");
      if (savedEnabled !== undefined) {
        this.enabled = savedEnabled === "1";
        if (this.enabled) this.startCheckLoop();
      }
      if (savedTimeout !== undefined) {
        this.timeoutMs = Math.max(1, Number(savedTimeout)) * 60_000;
      }
      logger.info(
        { enabled: this.enabled, timeoutMs: this.timeoutMs },
        "InactivityManager: config loaded from DB"
      );
    } catch (err) {
      logger.warn({ err }, "InactivityManager: could not load config from DB (using defaults)");
    }
  }

  // ── Public config ────────────────────────────────────────────────────────────

  getConfig() {
    return {
      enabled: this.enabled,
      timeoutMinutes: this.timeoutMs / 60_000,
      audioFile: this.audioFile,
      audioExists: existsSync(this.audioFile),
    };
  }

  setEnabled(v: boolean): void {
    this.enabled = v;
    if (v) this.startCheckLoop();
    else this.stopCheckLoop();
    logger.info({ enabled: v }, "Inactivity manager toggled");
    this.persistConfig();
  }

  setTimeoutMinutes(minutes: number): void {
    this.timeoutMs = Math.max(1, minutes) * 60_000;
    logger.info({ minutes }, "Inactivity timeout updated");
    this.persistConfig();
  }

  setAudioFile(filePath: string): void {
    this.audioFile = filePath;
  }

  // ── Activity tracking ────────────────────────────────────────────────────────

  recordActivity(room: string): void {
    this.lastActivity.set(room, Date.now());
  }

  // ── Internal loop ────────────────────────────────────────────────────────────

  private startCheckLoop(): void {
    if (this.checkTimer) return;
    this.checkTimer = setInterval(() => this.checkAllRooms(), 30_000);
    logger.info("Inactivity check loop started");
  }

  private stopCheckLoop(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
  }

  private async checkAllRooms(): Promise<void> {
    if (!this.enabled) return;
    const now = Date.now();

    for (const room of roomManager.getRooms()) {
      if (this.playing.has(room)) continue;

      const members = roomManager.getRoomMembers(room);
      if (members.length === 0) {
        this.lastActivity.delete(room);
        continue;
      }

      if (!this.lastActivity.has(room)) {
        this.lastActivity.set(room, now);
        continue;
      }

      const elapsed = now - (this.lastActivity.get(room) ?? now);
      if (elapsed >= this.timeoutMs) {
        logger.info({ room, elapsedMs: elapsed }, "Inactivity threshold reached — playing announcement");
        this.playForRoom(room).catch((err) =>
          logger.warn({ err, room }, "Inactivity audio playback failed")
        );
      }
    }
  }

  // ── Manual trigger (admin "Probar") ──────────────────────────────────────────

  async trigger(room: string): Promise<void> {
    if (this.playing.has(room)) throw new Error("Ya se está reproduciendo en esa sala");
    await this.playForRoom(room);
  }

  // ── Audio playback ────────────────────────────────────────────────────────────

  private async playForRoom(room: string): Promise<void> {
    if (!existsSync(this.audioFile)) {
      logger.warn({ file: this.audioFile }, "Inactivity audio file not found — skipping");
      return;
    }

    const locked = roomManager.tryLockRoom(room, "_INACTIVITY_");
    if (!locked) {
      logger.info({ room }, "Room locked by active PTT — skipping inactivity audio");
      return;
    }

    const localMembers = roomManager.getRoomMembers(room);
    logger.info({ room, localMembers: localMembers.map(c => `${c.name}(${c.protocol})`) },
      "Inactivity playback starting — local room members");

    const INACT_MSG = "Anuncio del servidor";

    this.playing.add(room);
    try {
      roomManager.broadcastToRoom(room, buildUserJoined(SERVER_CALLSIGN, INACT_MSG));
      roomManager.broadcastJsonToRemoteRoom(room, { type: "user_joined", name: SERVER_CALLSIGN, message: INACT_MSG });

      roomManager.broadcastToRoom(room, buildPttStarted(SERVER_CALLSIGN));
      roomManager.broadcastJsonToRemoteRoom(room, { type: "ptt_started", name: SERVER_CALLSIGN });

      await this.streamAudio(room);

      roomManager.broadcastToRoom(room, buildPttReleased(SERVER_CALLSIGN));
      roomManager.broadcastJsonToRemoteRoom(room, { type: "ptt_released_remote", name: SERVER_CALLSIGN });

      roomManager.broadcastToRoom(room, buildUserLeft(SERVER_CALLSIGN));
      roomManager.broadcastJsonToRemoteRoom(room, { type: "user_left", name: SERVER_CALLSIGN });
    } finally {
      roomManager.unlockRoom(room, "_INACTIVITY_");
      this.playing.delete(room);
      this.lastActivity.set(room, Date.now());
    }
  }

  private async streamAudio(room: string): Promise<void> {
    const packets = await this.convertWavToEqsoPackets(this.audioFile);
    if (packets.length === 0) return;

    const remotePacketsPromise = this.convertWavToFloat32Packets(this.audioFile);

    const localDone = new Promise<void>((resolve) => {
      let i = 0;
      const timer = setInterval(() => {
        if (i >= packets.length) {
          clearInterval(timer);
          resolve();
          return;
        }
        roomManager.broadcastToTcpClientsInRoom(room, packets[i++]!);
      }, PACKET_INTERVAL_MS);
    });

    const wsDone = remotePacketsPromise.then((remotePackets) => new Promise<void>((resolve) => {
      let j = 0;
      const timer = setInterval(() => {
        if (j >= remotePackets.length) {
          clearInterval(timer);
          resolve();
          return;
        }
        const pkt = remotePackets[j++]!;
        roomManager.broadcastBinToLocalWsClients(room, pkt);
        roomManager.broadcastBinToRemoteRoom(room, pkt);
      }, PACKET_INTERVAL_MS);
    }));

    await Promise.all([localDone, wsDone]);
  }

  private convertWavToFloat32Packets(filePath: string): Promise<Buffer[]> {
    return new Promise((resolve, reject) => {
      const ff = spawn("ffmpeg", [
        "-i", filePath,
        "-ar", "8000",
        "-ac", "1",
        "-f", "s16le",
        "pipe:1",
      ], { stdio: ["ignore", "pipe", "pipe"] });

      const chunks: Buffer[] = [];
      ff.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
      ff.stderr.on("data", () => {});

      ff.on("error", reject);
      ff.on("close", (code) => {
        if (code !== 0 && code !== null) {
          reject(new Error(`ffmpeg s16le exit ${code}`));
          return;
        }
        const raw = Buffer.concat(chunks);
        const totalSamples = raw.byteLength / 2;
        const packets: Buffer[] = [];
        const bytesPerChunk = REMOTE_CHUNK_SAMPLES * 2;

        for (let off = 0; off + bytesPerChunk <= raw.byteLength; off += bytesPerChunk) {
          const pcm16 = new Int16Array(raw.buffer, raw.byteOffset + off, REMOTE_CHUNK_SAMPLES);
          const float32 = new Float32Array(REMOTE_CHUNK_SAMPLES);
          for (let i = 0; i < REMOTE_CHUNK_SAMPLES; i++) {
            float32[i] = Math.max(-0.85, Math.min(0.85, pcm16[i]! / 32768));
          }
          const payload = Buffer.from(float32.buffer);
          const out = Buffer.allocUnsafe(1 + payload.length);
          out[0] = 0x11;
          payload.copy(out, 1);
          packets.push(out);
        }

        logger.info({ filePath, totalSamples, remotePackets: packets.length },
          "WAV converted to Float32 packets for remote WebSocket clients");
        resolve(packets);
      });
    });
  }

  private convertWavToEqsoPackets(filePath: string): Promise<Buffer[]> {
    return new Promise((resolve, reject) => {
      const ff = spawn("ffmpeg", [
        "-i", filePath,
        "-ar", "8000",
        "-ac", "1",
        "-f", "gsm",
        "pipe:1",
      ], { stdio: ["ignore", "pipe", "pipe"] });

      const chunks: Buffer[] = [];
      ff.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
      ff.stderr.on("data", () => {});

      ff.on("error", reject);
      ff.on("close", (code) => {
        if (code !== 0 && code !== null) {
          reject(new Error(`ffmpeg exited with code ${code}`));
          return;
        }
        const raw = Buffer.concat(chunks);
        const packets: Buffer[] = [];
        for (let off = 0; off + AUDIO_PAYLOAD_SIZE <= raw.length; off += AUDIO_PAYLOAD_SIZE) {
          const payload = raw.slice(off, off + AUDIO_PAYLOAD_SIZE);
          packets.push(Buffer.concat([Buffer.from([0x01]), payload]));
        }
        const remaining = raw.length % AUDIO_PAYLOAD_SIZE;
        if (remaining > 0) {
          const padded = Buffer.alloc(AUDIO_PAYLOAD_SIZE, 0);
          raw.slice(raw.length - remaining).copy(padded);
          packets.push(Buffer.concat([Buffer.from([0x01]), padded]));
        }
        logger.info({ filePath, totalPackets: packets.length }, "WAV converted to eQSO GSM packets");
        resolve(packets);
      });
    });
  }

  async saveAudioFile(data: Buffer): Promise<void> {
    const dir = path.dirname(this.audioFile);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(this.audioFile, data);
    logger.info({ file: this.audioFile, bytes: data.length }, "Inactivity audio file saved");
  }

  // ── Private: persist config to DB ────────────────────────────────────────────

  private persistConfig(): void {
    const doSave = async () => {
      await db.insert(systemSettingsTable)
        .values({ key: "inactivity_enabled", value: this.enabled ? "1" : "0" })
        .onConflictDoUpdate({ target: systemSettingsTable.key, set: { value: sql`excluded.value` } });
      await db.insert(systemSettingsTable)
        .values({ key: "inactivity_timeout_min", value: String(this.timeoutMs / 60_000) })
        .onConflictDoUpdate({ target: systemSettingsTable.key, set: { value: sql`excluded.value` } });
    };
    doSave().catch(err => logger.warn({ err }, "InactivityManager: failed to persist config"));
  }
}

export const inactivityManager = new InactivityManager();
