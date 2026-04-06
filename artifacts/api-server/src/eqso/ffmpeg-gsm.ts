/**
 * FFmpeg-based GSM 06.10 codec — streaming implementation using libgsm via ffmpeg.
 *
 * Spawns long-lived ffmpeg processes to encode/decode GSM in real-time.
 * Decoder uses ffmpeg-static (always available, decode-only binary).
 * Encoder uses the system ffmpeg from PATH (has libgsm encoder).
 *
 * GSM 06.10 packet: 6 frames × 33 bytes = 198 bytes → 960 PCM Int16 samples (1920 bytes)
 */

import { spawn, ChildProcessWithoutNullStreams, execFileSync } from "child_process";
import { EventEmitter } from "events";
import { logger } from "../lib/logger";
import ffmpegStaticPath from "ffmpeg-static";
import { GsmEncoder } from "./gsm610";

// ---------------------------------------------------------------------------
// Binary selection
// ---------------------------------------------------------------------------

/** Resolve the system ffmpeg from PATH (needed for GSM *encoder*, libgsm). */
function findSystemFfmpeg(): string | null {
  try {
    const p = execFileSync("which", ["ffmpeg"], { encoding: "utf8" }).trim();
    return p || null;
  } catch {
    return null;
  }
}

const SYSTEM_FFMPEG: string | null = findSystemFfmpeg();

/**
 * Use system ffmpeg for encoding (needs libgsm encoder).
 * Fall back to static binary path if system ffmpeg not found.
 */
const ENCODER_BIN: string = SYSTEM_FFMPEG ?? ffmpegStaticPath ?? "ffmpeg";

/**
 * Use ffmpeg-static binary for decoding (GSM decoder is always included).
 * Fall back to system ffmpeg if static binary is unavailable.
 */
const DECODER_BIN: string = ffmpegStaticPath ?? SYSTEM_FFMPEG ?? "ffmpeg";

logger.info({ ENCODER_BIN, DECODER_BIN }, "ffmpeg GSM codec binary paths resolved");

export const GSM_FRAME_BYTES    = 33;
export const GSM_FRAME_SAMPLES  = 160;
// eQSO protocol: [0x01][198 bytes = 6 GSM frames] per audio packet at ~8.3 pkt/s (120ms/packet).
// ASORAPA's parser expects exactly 198 bytes after each 0x01 opcode.
// Sending individual 33-byte frames corrupts ASORAPA's protocol state → ECONNRESET.
export const FRAMES_PER_PACKET  = 6;
export const GSM_PACKET_BYTES   = GSM_FRAME_BYTES * FRAMES_PER_PACKET;     // 198
export const PCM_PACKET_BYTES   = GSM_FRAME_SAMPLES * FRAMES_PER_PACKET * 2; // 1920
export const AUDIO_PAYLOAD_SIZE = 198; // eQSO TCP audio payload size (RX and TX)

// ---------------------------------------------------------------------------
// FfmpegGsmDecoder: GSM bytes → Int16 PCM samples
// ---------------------------------------------------------------------------

export class FfmpegGsmDecoder extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private accumulator = Buffer.alloc(0);

  /** Spawn the ffmpeg decoder process. */
  start(): void {
    if (this.proc) return;

    this.proc = spawn(DECODER_BIN, [
      "-hide_banner", "-loglevel", "quiet",
      "-probesize", "32", "-analyzeduration", "0",
      "-f", "gsm", "-ar", "8000",
      "-i", "pipe:0",
      "-f", "s16le", "-ar", "8000",
      "pipe:1",
    ], { stdio: ["pipe", "pipe", "pipe"] });

    this.proc.stderr.on("data", (d: Buffer) => {
      const msg = d.toString().trim();
      if (msg) logger.warn({ msg }, "ffmpeg GSM decoder stderr");
    });

    this.proc.on("error", (err) => {
      logger.warn({ err }, "ffmpeg GSM decoder spawn error");
    });

    this.proc.on("close", (code) => {
      logger.warn({ code }, "ffmpeg GSM decoder closed");
      this.proc = null;
    });

    this.proc.stdout.on("data", (chunk: Buffer) => {
      this.accumulator = Buffer.concat([this.accumulator, chunk]);
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

    logger.debug({ bin: DECODER_BIN }, "ffmpeg GSM decoder started");
  }

  /**
   * Feed a GSM payload from the eQSO server (typically 198 bytes = 6 frames,
   * but we accept any multiple of 33 bytes).
   * Emits "pcm" events with Int16Array(160) per decoded frame.
   */
  decode(gsmPayload: Buffer): void {
    if (!this.proc) {
      logger.warn("ffmpeg GSM decoder not running, dropping packet");
      return;
    }
    if (gsmPayload.length < GSM_FRAME_BYTES) {
      logger.warn({ len: gsmPayload.length }, "ffmpeg GSM decoder: payload too short, skipping");
      return;
    }
    try {
      // Feed all bytes — the frame accumulator in stdout handler handles any chunk size
      this.proc.stdin.write(gsmPayload);
    } catch (err) {
      logger.warn({ err }, "ffmpeg GSM decoder write error");
    }
  }

  stop(): void {
    try {
      this.proc?.stdin.end();
      this.proc?.kill("SIGTERM");
    } catch { /* ignore */ }
    this.proc = null;
    this.accumulator = Buffer.alloc(0);
  }
}

// ---------------------------------------------------------------------------
// FfmpegGsmEncoder: Int16 PCM samples → GSM bytes
// ---------------------------------------------------------------------------

export class FfmpegGsmEncoder extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private accumulator = Buffer.alloc(0);
  private stopped = false;

  /** Spawn the ffmpeg encoder process. Auto-restarts on unexpected exit. */
  start(): void {
    if (this.proc || this.stopped) return;

    // stdbuf -o0: disable stdio output buffering so each GSM frame is written
    // to the pipe immediately (no OS-level block buffering).
    // -flush_packets 1: force ffmpeg to flush the output muxer after every packet.
    // -probesize 32 -analyzeduration 0: skip unnecessary input probing
    // (format is fully specified by -f s16le -ar 8000 -ac 1).
    const stdbufBin = "stdbuf";
    this.proc = spawn(stdbufBin, [
      "-o0",
      ENCODER_BIN,
      "-hide_banner", "-loglevel", "quiet",
      "-probesize", "32", "-analyzeduration", "0",
      "-f", "s16le", "-ar", "8000", "-ac", "1",
      "-i", "pipe:0",
      "-acodec", "libgsm",
      "-f", "gsm", "-ar", "8000",
      "-flush_packets", "1",
      "pipe:1",
    ], { stdio: ["pipe", "pipe", "pipe"] });

    // No silence priming: with stdbuf -o0 + -flush_packets 1, ffmpeg emits
    // each GSM frame immediately.  Priming produced buffered silence frames
    // that arrived mixed with real speech, causing distorted audio at the radio.

    this.proc.stderr.on("data", (d: Buffer) => {
      const msg = d.toString().trim();
      if (msg) logger.warn({ msg }, "ffmpeg GSM encoder stderr");
    });

    this.proc.on("error", (err) => {
      logger.warn({ err }, "ffmpeg GSM encoder spawn error");
      this.proc = null;
      // retry after 1 second
      if (!this.stopped) setTimeout(() => this.start(), 1000);
    });

    this.proc.on("close", (code) => {
      logger.warn({ code }, "ffmpeg GSM encoder closed — will restart");
      this.proc = null;
      if (!this.stopped) setTimeout(() => this.start(), 500);
    });

    this.proc.stdout.on("data", (chunk: Buffer) => {
      this.accumulator = Buffer.concat([this.accumulator, chunk]);
      let emitted = 0;
      while (this.accumulator.length >= GSM_PACKET_BYTES) {
        const gsmBuf = Buffer.from(this.accumulator.slice(0, GSM_PACKET_BYTES));
        this.accumulator = this.accumulator.slice(GSM_PACKET_BYTES);
        this.emit("gsm", gsmBuf);
        emitted++;
      }
      if (emitted > 1) {
        logger.debug({ emitted, chunkBytes: chunk.length }, "ffmpeg GSM encoder: burst (expected with pipeline buffering)");
      }
    });

    logger.debug({ bin: ENCODER_BIN }, "ffmpeg GSM encoder started");
  }

  /**
   * Feed a 960-sample (1920-byte) Int16 PCM packet.
   * Emits "gsm" event with Buffer(198) when encoded.
   */
  encode(pcmPacket: Int16Array): void {
    if (!this.proc) {
      logger.warn("ffmpeg GSM encoder not running, dropping packet");
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
    this.stopped = true;
    try {
      this.proc?.stdin.end();
      this.proc?.kill("SIGTERM");
    } catch { /* ignore */ }
    this.proc = null;
    this.accumulator = Buffer.alloc(0);
  }
}

// ---------------------------------------------------------------------------
// TsGsmEncoder: pure TypeScript GSM 06.10 encoder (synchronous, no buffering)
// ---------------------------------------------------------------------------

/**
 * Synchronous GSM 06.10 encoder using the pure-TS implementation.
 * Produces output immediately — no ffmpeg process, no pipe buffering.
 * Each encode() call emits "gsm" synchronously with the 198-byte packet.
 */
export class TsGsmEncoder extends EventEmitter {
  private encoder: GsmEncoder | null = null;

  start(): void {
    if (this.encoder) return;
    this.encoder = new GsmEncoder();
    logger.debug("TS GSM encoder started");
  }

  /**
   * Encode a 960-sample (1920-byte) Int16 PCM packet.
   * Emits "gsm" synchronously with Buffer(198).
   */
  encode(pcmPacket: Int16Array): void {
    if (!this.encoder) {
      logger.warn("TS GSM encoder not running, dropping packet");
      return;
    }
    if (pcmPacket.length < GSM_FRAME_SAMPLES * FRAMES_PER_PACKET) {
      logger.warn({ len: pcmPacket.length }, "TS GSM encoder: short PCM, skipping");
      return;
    }
    try {
      const out = new Uint8Array(GSM_PACKET_BYTES);
      for (let f = 0; f < FRAMES_PER_PACKET; f++) {
        const frame = pcmPacket.slice(
          f * GSM_FRAME_SAMPLES,
          (f + 1) * GSM_FRAME_SAMPLES
        );
        out.set(this.encoder.encodeFrame(frame), f * GSM_FRAME_BYTES);
      }
      this.emit("gsm", Buffer.from(out));
    } catch (err) {
      logger.warn({ err }, "TS GSM encoder error");
    }
  }

  stop(): void {
    this.encoder = null;
    logger.debug("TS GSM encoder stopped");
  }
}
