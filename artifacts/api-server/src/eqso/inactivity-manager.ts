import { spawn } from "child_process";
import path from "path";
import fs from "fs/promises";
import { existsSync } from "fs";
import { logger } from "../lib/logger";
import { roomManager } from "./room-manager";
import { buildPttStarted, buildPttReleased, buildUserJoined, buildUserLeft, AUDIO_PAYLOAD_SIZE } from "./protocol";

const PACKET_INTERVAL_MS = 120; // 6 GSM frames × 20ms = 120ms per eQSO audio packet
// Remote WebSocket clients receive Float32 PCM at 8000 Hz.
// 960 samples = 6 GSM frames × 160 samples each (matches eQSO packet timing).
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
  }

  setTimeoutMinutes(minutes: number): void {
    this.timeoutMs = Math.max(1, minutes) * 60_000;
    logger.info({ minutes }, "Inactivity timeout updated");
  }

  setAudioFile(filePath: string): void {
    this.audioFile = filePath;
  }

  // ── Activity tracking ────────────────────────────────────────────────────────

  /** Call this whenever a room has a real PTT event */
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

      // Initialize activity timestamp the first time we see occupied rooms
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
      // Add SERVIDOR as a virtual member so the UI can show VU bar animation
      roomManager.broadcastToRoom(room, buildUserJoined(SERVER_CALLSIGN, INACT_MSG));
      roomManager.broadcastJsonToRemoteRoom(room, { type: "user_joined", name: SERVER_CALLSIGN, message: INACT_MSG });

      // PTT start
      roomManager.broadcastToRoom(room, buildPttStarted(SERVER_CALLSIGN));
      roomManager.broadcastJsonToRemoteRoom(room, { type: "ptt_started", name: SERVER_CALLSIGN });

      await this.streamAudio(room);

      // PTT release
      roomManager.broadcastToRoom(room, buildPttReleased(SERVER_CALLSIGN));
      roomManager.broadcastJsonToRemoteRoom(room, { type: "ptt_released_remote", name: SERVER_CALLSIGN });

      // Remove virtual member
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

    // Also prepare decoded Float32 packets for remote WebSocket clients.
    // Do the PCM conversion in parallel so we don't delay local playback.
    const remotePacketsPromise = this.convertWavToFloat32Packets(this.audioFile);

    // GSM packets → TCP clients only (Windows eQSO clients, radio gateways)
    // Float32 packets → local WS browser clients AND remote WS clients
    // This bypasses the JS GSM decoder which produces too-low amplitude.
    const localDone = new Promise<void>((resolve) => {
      let i = 0;
      const timer = setInterval(() => {
        if (i >= packets.length) {
          clearInterval(timer);
          resolve();
          return;
        }
        roomManager.broadcastToTcpClientsInRoom(room, packets[i++]);
      }, PACKET_INTERVAL_MS);
    });

    // Float32 packets → local WS browser clients + remote WS clients
    const wsDone = remotePacketsPromise.then((remotePackets) => new Promise<void>((resolve) => {
      let j = 0;
      let loggedFirst = false;
      const timer = setInterval(() => {
        if (j >= remotePackets.length) {
          clearInterval(timer);
          resolve();
          return;
        }
        const pkt = remotePackets[j++];
        if (!loggedFirst) {
          loggedFirst = true;
          const f32 = new Float32Array(pkt.buffer, pkt.byteOffset + 1, (pkt.length - 1) / 4);
          let pk = 0; for (let i = 0; i < f32.length; i++) { const a = Math.abs(f32[i]); if (a > pk) pk = a; }
          logger.info({ room, pktSize: pkt.length, floatSamples: f32.length, peak: pk.toFixed(4), opcode: pkt[0].toString(16) }, "Float32 WS audio: first packet");
        }
        roomManager.broadcastBinToLocalWsClients(room, pkt);  // local browser clients
        roomManager.broadcastBinToRemoteRoom(room, pkt);       // ASORAPA-connected clients
      }, PACKET_INTERVAL_MS);
    }));

    await Promise.all([localDone, wsDone]);
  }

  /** Convert WAV → Float32 PCM packets with 0x11 opcode for browser WebSocket clients */
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
        const totalSamples = raw.byteLength / 2; // s16le = 2 bytes per sample
        const packets: Buffer[] = [];
        const bytesPerChunk = REMOTE_CHUNK_SAMPLES * 2;

        for (let off = 0; off + bytesPerChunk <= raw.byteLength; off += bytesPerChunk) {
          const pcm16 = new Int16Array(raw.buffer, raw.byteOffset + off, REMOTE_CHUNK_SAMPLES);
          const float32 = new Float32Array(REMOTE_CHUNK_SAMPLES);
          for (let i = 0; i < REMOTE_CHUNK_SAMPLES; i++) {
            float32[i] = Math.max(-0.85, Math.min(0.85, pcm16[i] / 32768));
          }
          const payload = Buffer.from(float32.buffer);
          const out = Buffer.allocUnsafe(1 + payload.length);
          out[0] = 0x11; // WS_AUDIO_REMOTE opcode
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
      ff.stderr.on("data", () => {}); // suppress ffmpeg stderr

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
        // Pad last partial packet if needed
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

  /** Save a WAV buffer uploaded by the admin */
  async saveAudioFile(data: Buffer): Promise<void> {
    const dir = path.dirname(this.audioFile);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(this.audioFile, data);
    logger.info({ file: this.audioFile, bytes: data.length }, "Inactivity audio file saved");
  }
}

export const inactivityManager = new InactivityManager();
