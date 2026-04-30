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
export const FRAMES_PER_PACKET = 1;
export const GSM_PACKET_BYTES  = GSM_FRAME_BYTES * FRAMES_PER_PACKET;   // 33
export const PCM_PACKET_BYTES  = GSM_FRAME_SAMPLES * FRAMES_PER_PACKET * 2; // 320

// ─── Decoder: GSM bytes → Int16 PCM ─────────────────────────────────────────

export class GsmDecoder extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private accum = Buffer.alloc(0);
  ready = false;

  start(): void {
    if (this.proc) return;
    // -fflags +flush_packets: fuerza avio_flush() tras cada paquete muxado.
    // stdbuf -o0 NO sirve: ffmpeg usa write() (no fwrite/stdio), sin efecto.
    // El AVIOContext buffer (32KB) se vacía al pipe después de cada frame.
    this.proc = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "quiet",
      "-probesize", "32", "-analyzeduration", "0",
      "-f", "gsm", "-ar", "8000",
      "-i", "pipe:0",
      "-f", "s16le", "-ar", "8000",
      "-fflags", "+flush_packets",
      "pipe:1",
    ], { stdio: ["pipe", "pipe", "pipe"] });

    this.proc.stderr.on("data", () => {});
    // Suppress async EPIPE/ERR_STREAM_DESTROYED when Node writes to the
    // ffmpeg stdin pipe after ffmpeg exits (e.g. during graceful shutdown).
    // Without this handler Node throws an unhandled 'error' event and crashes.
    this.proc.stdin.on("error", () => {});
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
    if (gsm.length < GSM_PACKET_BYTES) return;
    try {
      this.proc.stdin.write(gsm.slice(0, GSM_PACKET_BYTES));
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

  private lastGsmMs = 0;

  start(): void {
    if (this.proc) return;
    // -avioflags direct en el INPUT (antes de -i pipe:0): desactiva el buffer de
    // lectura AVIOContext del input (32KB por defecto). Sin esto ffmpeg intenta
    // rellenar su buffer interno leyendo muchos frames de PCM antes de codificar,
    // produciendo rafagas de audio en lugar de codificacion frame a frame.
    // Colocarlo en el INPUT (igual que el decoder) es la posicion correcta.
    //
    // -fflags +flush_packets en el OUTPUT: fuerza avio_flush() tras cada frame
    // GSM codificado, vaciando el pipe de salida inmediatamente (33 bytes/frame).
    this.proc = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "quiet",
      "-probesize", "32", "-analyzeduration", "0",
      "-avioflags", "direct",
      "-f", "s16le", "-ar", "8000", "-ac", "1",
      "-i", "pipe:0",
      "-f", "gsm", "-ar", "8000",
      "-fflags", "+flush_packets",
      "pipe:1",
    ], { stdio: ["pipe", "pipe", "pipe"] });

    this.proc.stderr.on("data", () => {});
    // Suppress async EPIPE/ERR_STREAM_DESTROYED on ffmpeg stdin during shutdown.
    this.proc.stdin.on("error", () => {});
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
        const now = Date.now();
        if (this.lastGsmMs > 0 && now - this.lastGsmMs > 150) {
          console.log(`[gsm-enc] ${new Date().toISOString()} GAP ${now - this.lastGsmMs}ms entre frames GSM de salida`);
        }
        this.lastGsmMs = now;
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
