import { spawn } from "child_process";
import path from "path";
import fs from "fs/promises";
import { existsSync } from "fs";
import { logger } from "../lib/logger";
import { roomManager } from "./room-manager";
import { buildPttStarted, buildPttReleased, AUDIO_PAYLOAD_SIZE } from "./protocol";

const PACKET_INTERVAL_MS = 120; // 6 GSM frames × 20ms = 120ms per eQSO audio packet
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

    this.playing.add(room);
    try {
      roomManager.broadcastToRoom(room, buildPttStarted(SERVER_CALLSIGN));
      await this.streamAudio(room);
      roomManager.broadcastToRoom(room, buildPttReleased(SERVER_CALLSIGN));
    } finally {
      roomManager.unlockRoom(room, "_INACTIVITY_");
      this.playing.delete(room);
      this.lastActivity.set(room, Date.now());
    }
  }

  private async streamAudio(room: string): Promise<void> {
    const packets = await this.convertWavToEqsoPackets(this.audioFile);
    if (packets.length === 0) return;

    return new Promise((resolve) => {
      let i = 0;
      const timer = setInterval(() => {
        if (i >= packets.length) {
          clearInterval(timer);
          resolve();
          return;
        }
        roomManager.broadcastToRoom(room, packets[i++]);
      }, PACKET_INTERVAL_MS);
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
