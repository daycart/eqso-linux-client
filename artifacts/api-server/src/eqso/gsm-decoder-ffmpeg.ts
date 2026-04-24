/**
 * GSM 06.10 decoder via FFmpeg subprocess.
 *
 * El codec JS puro (gsm610.ts) tiene bugs en la predicción de largo plazo (LTP)
 * que destruyen la voz pero dejan pasar tonos simples. Este módulo usa ffmpeg
 * como referencia (igual que el relay-daemon) para garantizar compatibilidad
 * total con el audio codificado por libgsm / ffmpeg en el lado del relay.
 *
 * Uso: instanciar, suscribir al evento "pcm", llamar start() y decode().
 * Emite: "pcm" (Int16Array de 960 muestras) por cada paquete GSM recibido.
 */

import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import { EventEmitter } from "events";

const GSM_FRAME_BYTES   = 33;
const GSM_FRAME_SAMPLES = 160;
const FRAMES_PER_PACKET = 1;
export const GSM_PACKET_BYTES  = GSM_FRAME_BYTES   * FRAMES_PER_PACKET; // 33
export const PCM_PACKET_BYTES  = GSM_FRAME_SAMPLES * FRAMES_PER_PACKET * 2; // 320

export class GsmFfmpegDecoder extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private accum = Buffer.alloc(0);
  private _ready = false;

  get ready(): boolean { return this._ready; }

  start(): void {
    if (this.proc) return;
    // -fflags +flush_packets: fuerza avio_flush() tras cada paquete muxado.
    // Sin esto, el AVIOContext de ffmpeg acumula datos en su buffer interno
    // (32KB) y Node.js recibe paquetes en ráfagas separadas por silencios
    // equidistantes. stdbuf -o0 NO sirve: ffmpeg usa write() directamente
    // (no fwrite/stdio), así que stdbuf no tiene efecto sobre él.
    // Con flush_packets: cada frame PCM decodificado llega al pipe
    // inmediatamente, sin ningún buffer intermedio.
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

    this.proc.on("error", (err) => {
      console.error(`[gsm-dec-ffmpeg] process error: ${err.message}`);
    });

    this.proc.on("close", () => {
      this.proc  = null;
      this._ready = false;
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

    // ffmpeg necesita ~500ms para inicializar el demuxer GSM antes de aceptar datos.
    setTimeout(() => { this._ready = true; }, 500);
  }

  decode(gsm: Buffer): void {
    if (!this.proc || !this._ready) return;
    if (gsm.length < GSM_PACKET_BYTES) return;
    try {
      this.proc.stdin.write(gsm.slice(0, GSM_PACKET_BYTES));
    } catch { /* ignore — proceso cerrado */ }
  }

  stop(): void {
    try {
      this.proc?.stdin.end();
      this.proc?.kill("SIGTERM");
    } catch { /* ignore */ }
    this.proc  = null;
    this._ready = false;
    this.accum  = Buffer.alloc(0);
  }
}
