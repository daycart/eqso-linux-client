/**
 * GSM 06.10 codec via FFmpeg — igual que en el servidor API pero reutilizado
 * aqui de forma standalone para el demonio de radioenlace.
 */

import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import { EventEmitter } from "events";

export const GSM_FRAME_BYTES   = 33;
export const GSM_FRAME_SAMPLES = 160;
export const FRAMES_PER_PACKET = 6;
export const GSM_PACKET_BYTES  = GSM_FRAME_BYTES * FRAMES_PER_PACKET;   // 198
export const PCM_PACKET_BYTES  = GSM_FRAME_SAMPLES * FRAMES_PER_PACKET * 2; // 1920

function ffmpegBin(): string {
  try {
    // Si ffmpeg-static esta instalado lo usamos
    const ffmpegStatic = require("ffmpeg-static") as string;
    return ffmpegStatic;
  } catch {
    return "ffmpeg"; // fallback al ffmpeg del sistema
  }
}

// ─── Decoder: GSM bytes → Int16 PCM ─────────────────────────────────────────

export class GsmDecoder extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private acc = Buffer.alloc(0);
  private ready = false;

  start(): void {
    if (this.proc) return;
    this.proc = spawn(ffmpegBin(), [
      "-hide_banner", "-loglevel", "quiet",
      "-probesize", "32", "-analyzeduration", "0",
      "-f", "gsm", "-ar", "8000",
      "-i", "pipe:0",
      "-f", "s16le", "-ar", "8000",
      "pipe:1",
    ], { stdio: ["pipe", "pipe", "pipe"] });

    this.proc.stderr.on("data", () => {});
    this.proc.on("error", (err) => log(`[decoder] error ffmpeg: ${err.message}`));
    this.proc.on("close", () => { this.proc = null; this.ready = false; });

    this.proc.stdout.on("data", (chunk: Buffer) => {
      this.acc = Buffer.concat([this.acc, chunk]);
      while (this.acc.length >= PCM_PACKET_BYTES) {
        const pcmBuf = this.acc.slice(0, PCM_PACKET_BYTES);
        this.acc = this.acc.slice(PCM_PACKET_BYTES);
        const pcm = new Int16Array(
          pcmBuf.buffer.slice(pcmBuf.byteOffset, pcmBuf.byteOffset + PCM_PACKET_BYTES)
        );
        this.emit("pcm", pcm);
      }
    });

    setTimeout(() => { this.ready = true; }, 500);
  }

  decode(gsm: Buffer): void {
    if (!this.proc || !this.ready) return;
    if (gsm.length < GSM_PACKET_BYTES) return;
    try { this.proc.stdin.write(gsm.slice(0, GSM_PACKET_BYTES)); } catch { /* ignore */ }
  }

  stop(): void {
    try { this.proc?.stdin.end(); this.proc?.kill("SIGTERM"); } catch { /* ignore */ }
    this.proc = null; this.ready = false; this.acc = Buffer.alloc(0);
  }
}

// ─── Encoder: Int16 PCM → GSM bytes ─────────────────────────────────────────

export class GsmEncoder extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private acc = Buffer.alloc(0);
  private ready = false;

  start(): void {
    if (this.proc) return;
    this.proc = spawn(ffmpegBin(), [
      "-hide_banner", "-loglevel", "quiet",
      "-probesize", "32", "-analyzeduration", "0",
      "-f", "s16le", "-ar", "8000", "-ac", "1",
      "-i", "pipe:0",
      "-f", "gsm", "-ar", "8000",
      "pipe:1",
    ], { stdio: ["pipe", "pipe", "pipe"] });

    this.proc.stderr.on("data", () => {});
    this.proc.on("error", (err) => log(`[encoder] error ffmpeg: ${err.message}`));
    this.proc.on("close", () => { this.proc = null; this.ready = false; });

    this.proc.stdout.on("data", (chunk: Buffer) => {
      this.acc = Buffer.concat([this.acc, chunk]);
      while (this.acc.length >= GSM_PACKET_BYTES) {
        const gsmBuf = Buffer.from(this.acc.slice(0, GSM_PACKET_BYTES));
        this.acc = this.acc.slice(GSM_PACKET_BYTES);
        this.emit("gsm", gsmBuf);
      }
    });

    setTimeout(() => { this.ready = true; }, 500);
  }

  encode(pcm: Int16Array): void {
    if (!this.proc || !this.ready) return;
    const needed = GSM_FRAME_SAMPLES * FRAMES_PER_PACKET;
    if (pcm.length < needed) return;
    try {
      const buf = Buffer.from(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + needed * 2));
      this.proc.stdin.write(buf);
    } catch { /* ignore */ }
  }

  stop(): void {
    try { this.proc?.stdin.end(); this.proc?.kill("SIGTERM"); } catch { /* ignore */ }
    this.proc = null; this.ready = false; this.acc = Buffer.alloc(0);
  }
}

function log(msg: string): void { console.log(`[gsm] ${new Date().toISOString()} ${msg}`); }
