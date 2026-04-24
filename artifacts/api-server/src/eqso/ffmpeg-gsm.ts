/**
 * FFmpeg-based GSM 06.10 codec — streaming implementation using libgsm via ffmpeg.
 *
 * Spawns long-lived ffmpeg processes to encode/decode GSM in real-time.
 * Each process takes ~400-500 ms to start up; subsequent packets are processed
 * in < 10 ms. Always call start() at connection time so the process is ready
 * by the time the first audio packet arrives.
 *
 * GSM 06.10 packet: 1 frame × 33 bytes = 33 bytes → 160 PCM Int16 samples (320 bytes)
 * Native eQSO frame rate: 50 packets/s = 20 ms per packet.
 */

import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import { EventEmitter } from "events";
import { logger } from "../lib/logger";

export const GSM_FRAME_BYTES    = 33;
export const GSM_FRAME_SAMPLES  = 160;
export const FRAMES_PER_PACKET  = 1;
export const GSM_PACKET_BYTES   = GSM_FRAME_BYTES * FRAMES_PER_PACKET;     // 33
export const PCM_PACKET_BYTES   = GSM_FRAME_SAMPLES * FRAMES_PER_PACKET * 2; // 320

// ---------------------------------------------------------------------------
// FfmpegGsmDecoder: GSM bytes → Int16 PCM samples
// ---------------------------------------------------------------------------

export class FfmpegGsmDecoder extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private accumulator = Buffer.alloc(0);
  private ready = false;

  /** Spawn the ffmpeg decoder process and mark ready after startup delay. */
  start(): void {
    if (this.proc) return;

    this.proc = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "quiet",
      "-probesize", "32", "-analyzeduration", "0",
      "-f", "gsm", "-ar", "8000",
      "-i", "pipe:0",
      "-f", "s16le", "-ar", "8000",
      // -avioflags direct desactiva el buffer de escritura AVIOContext (por defecto 32 KB).
      // Sin esto FFmpeg acumula ~17 paquetes GSM (2 segundos) antes de hacer flush al pipe
      // de Node.js, produciendo rafagas de audio en el navegador en lugar de flujo continuo.
      "-avioflags", "direct",
      "pipe:1",
    ], { stdio: ["pipe", "pipe", "pipe"] });

    this.proc.stderr.on("data", () => {});

    this.proc.on("error", (err) => {
      logger.warn({ err }, "ffmpeg GSM decoder error");
    });

    this.proc.on("close", () => {
      this.proc  = null;
      this.ready = false;
    });

    this.proc.stdout.on("data", (chunk: Buffer) => {
      this.accumulator = Buffer.concat([this.accumulator, chunk]);
      // Emit complete 1920-byte / 960-sample packets to callers
      while (this.accumulator.length >= PCM_PACKET_BYTES) {
        const pcmBuf = this.accumulator.slice(0, PCM_PACKET_BYTES);
        this.accumulator = this.accumulator.slice(PCM_PACKET_BYTES);
        const pcm = new Int16Array(
          pcmBuf.buffer.slice(
            pcmBuf.byteOffset,
            pcmBuf.byteOffset + PCM_PACKET_BYTES
          )
        );
        this.emit("pcm", pcm);
      }
    });

    // Give ffmpeg time to initialise its pipeline before accepting real frames
    setTimeout(() => {
      this.ready = true;
      logger.debug("ffmpeg GSM decoder ready");
    }, 500);
  }

  /** Feed a 198-byte GSM packet. Emits "pcm" event with Int16Array(960) when decoded. */
  decode(gsmPacket: Buffer): void {
    if (!this.proc || !this.ready) {
      logger.warn("ffmpeg GSM decoder not ready, dropping packet");
      return;
    }
    if (gsmPacket.length < GSM_PACKET_BYTES) {
      logger.warn({ len: gsmPacket.length }, "ffmpeg GSM decoder: short packet, skipping");
      return;
    }
    try {
      this.proc.stdin.write(gsmPacket.slice(0, GSM_PACKET_BYTES));
    } catch (err) {
      logger.warn({ err }, "ffmpeg GSM decoder write error");
    }
  }

  stop(): void {
    try {
      this.proc?.stdin.end();
      this.proc?.kill("SIGTERM");
    } catch { /* ignore */ }
    this.proc  = null;
    this.ready = false;
    this.accumulator = Buffer.alloc(0);
  }
}

// ---------------------------------------------------------------------------
// FfmpegGsmEncoder: Int16 PCM samples → GSM bytes
// ---------------------------------------------------------------------------

export class FfmpegGsmEncoder extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private accumulator = Buffer.alloc(0);
  private ready = false;

  /** Spawn the ffmpeg encoder process and mark ready after startup delay. */
  start(): void {
    if (this.proc) return;

    this.proc = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "quiet",
      "-probesize", "32", "-analyzeduration", "0",
      "-f", "s16le", "-ar", "8000", "-ac", "1",
      "-i", "pipe:0",
      // No audio filters — worklet already applies AGC, clip, and bandpass.
      // Filters add hundreds of ms of pipeline latency that delays voice vs PTT.
      "-f", "gsm", "-ar", "8000",
      "pipe:1",
    ], { stdio: ["pipe", "pipe", "pipe"] });

    this.proc.stderr.on("data", () => {});

    this.proc.on("error", (err) => {
      logger.warn({ err }, "ffmpeg GSM encoder error");
    });

    this.proc.on("close", () => {
      this.proc  = null;
      this.ready = false;
    });

    this.proc.stdout.on("data", (chunk: Buffer) => {
      this.accumulator = Buffer.concat([this.accumulator, chunk]);
      // Emit complete 198-byte / 6-frame GSM packets to callers
      while (this.accumulator.length >= GSM_PACKET_BYTES) {
        const gsmBuf = Buffer.from(this.accumulator.slice(0, GSM_PACKET_BYTES));
        this.accumulator = this.accumulator.slice(GSM_PACKET_BYTES);
        this.emit("gsm", gsmBuf);
      }
    });

    // Give ffmpeg time to initialise before accepting real PCM frames
    setTimeout(() => {
      this.ready = true;
      logger.debug("ffmpeg GSM encoder ready");
    }, 500);
  }

  /**
   * Feed a 960-sample (1920-byte) Int16 PCM packet.
   * Emits "gsm" event with Buffer(198) when encoded.
   */
  encode(pcmPacket: Int16Array): void {
    if (!this.proc || !this.ready) {
      logger.warn("ffmpeg GSM encoder not ready, dropping packet");
      return;
    }
    if (pcmPacket.length < GSM_FRAME_SAMPLES * FRAMES_PER_PACKET) {
      logger.warn({ len: pcmPacket.length }, "ffmpeg GSM encoder: short PCM, skipping");
      return;
    }
    try {
      const buf = Buffer.from(
        pcmPacket.buffer.slice(
          pcmPacket.byteOffset,
          pcmPacket.byteOffset + GSM_FRAME_SAMPLES * FRAMES_PER_PACKET * 2
        )
      );
      this.proc.stdin.write(buf);
    } catch (err) {
      logger.warn({ err }, "ffmpeg GSM encoder write error");
    }
  }

  stop(): void {
    try {
      this.proc?.stdin.end();
      this.proc?.kill("SIGTERM");
    } catch { /* ignore */ }
    this.proc  = null;
    this.ready = false;
    this.accumulator = Buffer.alloc(0);
  }
}
