/**
 * GSM 06.10 codec via FFmpeg — encoder + decoder
 *
 * Usa ffmpeg como proceso hijo (igual que api-server modo remoto) para
 * garantizar compatibilidad con el codec de referencia libgsm.
 * El codec JS puro tenía bugs en la predicción de largo plazo (LTP) que
 * destruían la voz pero dejaban pasar tonos simples (pitidos de cortesía).
 */

import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import { EventEmitter } from "events";

export const GSM_FRAME_BYTES   = 33;
export const GSM_FRAME_SAMPLES = 160;
export const FRAMES_PER_PACKET = 6;
export const GSM_PACKET_BYTES  = GSM_FRAME_BYTES * FRAMES_PER_PACKET;   // 198
export const PCM_PACKET_BYTES  = GSM_FRAME_SAMPLES * FRAMES_PER_PACKET * 2; // 1920

// ─── Decoder: GSM bytes → Int16 PCM ─────────────────────────────────────────

export class GsmDecoder extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private accum = Buffer.alloc(0);
  ready = false;

  start(): void {
    if (this.proc) return;
    this.proc = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "quiet",
      "-probesize", "32", "-analyzeduration", "0",
      "-f", "gsm", "-ar", "8000",
      "-i", "pipe:0",
      "-f", "s16le", "-ar", "8000",
      "-avioflags", "direct",   // sin buffer AVIOContext — flush inmediato tras cada paquete
      "pipe:1",
    ], { stdio: ["pipe", "pipe", "pipe"] });

    this.proc.stderr.on("data", () => {});
    this.proc.on("error", (err) => {
      console.error(`[gsm-dec] ffmpeg error: ${err.message}`);
    });
    this.proc.on("close", () => {
      this.proc  = null;
      this.ready = false;
    });
    this.proc.stdout.on("data", (chunk: Buffer) => {
      this.accum = Buffer.concat([this.accum, chunk]);
      while (this.accum.length >= PCM_PACKET_BYTES) {
        const pcmBuf = this.accum.slice(0, PCM_PACKET_BYTES);
        this.accum   = this.accum.slice(PCM_PACKET_BYTES);
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
    if (gsm.length < GSM_FRAME_BYTES) return;
    const usable = gsm.length - (gsm.length % GSM_FRAME_BYTES);
    try {
      this.proc.stdin.write(gsm.slice(0, usable));
    } catch { /* ignore */ }
  }

  stop(): void {
    try { this.proc?.stdin.end(); this.proc?.kill("SIGTERM"); } catch { /* ignore */ }
    this.proc  = null;
    this.ready = false;
    this.accum = Buffer.alloc(0);
  }
}

// ─── Encoder: Int16 PCM → GSM bytes ─────────────────────────────────────────

export class GsmEncoder extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private accum = Buffer.alloc(0);
  private ready = false;

  start(): void {
    if (this.proc) return;
    this.proc = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "quiet",
      "-probesize", "32", "-analyzeduration", "0",
      "-f", "s16le", "-ar", "8000", "-ac", "1",
      "-i", "pipe:0",
      "-f", "gsm", "-ar", "8000",
      "-avioflags", "direct",   // sin buffer AVIOContext — flush inmediato tras cada paquete
      "pipe:1",
    ], { stdio: ["pipe", "pipe", "pipe"] });

    this.proc.stderr.on("data", () => {});
    this.proc.on("error", (err) => {
      console.error(`[gsm-enc] ffmpeg error: ${err.message}`);
    });
    this.proc.on("close", () => {
      this.proc  = null;
      this.ready = false;
    });
    this.proc.stdout.on("data", (chunk: Buffer) => {
      this.accum = Buffer.concat([this.accum, chunk]);
      while (this.accum.length >= GSM_PACKET_BYTES) {
        const gsmBuf = Buffer.from(this.accum.slice(0, GSM_PACKET_BYTES));
        this.accum   = this.accum.slice(GSM_PACKET_BYTES);
        this.emit("gsm", gsmBuf);
      }
    });

    setTimeout(() => { this.ready = true; }, 500);
  }

  encode(pcm: Int16Array): void {
    if (!this.proc || !this.ready) return;
    const needed = GSM_FRAME_SAMPLES * FRAMES_PER_PACKET; // 960
    if (pcm.length < needed) return;
    try {
      const chunk = pcm.length === needed ? pcm : pcm.slice(0, needed);
      const buf = Buffer.from(chunk.buffer, chunk.byteOffset, needed * 2);
      this.proc.stdin.write(buf);
    } catch { /* ignore */ }
  }

  stop(): void {
    try { this.proc?.stdin.end(); this.proc?.kill("SIGTERM"); } catch { /* ignore */ }
    this.proc  = null;
    this.ready = false;
    this.accum = Buffer.alloc(0);
  }
}
