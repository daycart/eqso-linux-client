/**
 * GSM 06.10 codec — implementacion pura en JavaScript (sin FFmpeg).
 * Usa el mismo algoritmo que artifacts/api-server/src/eqso/gsm610.ts,
 * envuelto en la interfaz EventEmitter que espera alsa-audio.ts.
 */

import { EventEmitter } from "events";
import { gsmEncodePacket, gsmDecodePacket } from "./gsm610.js";

export const GSM_FRAME_BYTES   = 33;
export const GSM_FRAME_SAMPLES = 160;
export const FRAMES_PER_PACKET = 6;
export const GSM_PACKET_BYTES  = GSM_FRAME_BYTES * FRAMES_PER_PACKET;   // 198
export const PCM_PACKET_BYTES  = GSM_FRAME_SAMPLES * FRAMES_PER_PACKET * 2; // 1920

// ─── Decoder: GSM bytes → Int16 PCM ─────────────────────────────────────────

export class GsmDecoder extends EventEmitter {
  private started = false;

  start(): void { this.started = true; }

  decode(gsm: Buffer): void {
    if (!this.started) return;
    if (gsm.length < GSM_PACKET_BYTES) return;
    try {
      const input = new Uint8Array(gsm.buffer, gsm.byteOffset, GSM_PACKET_BYTES);
      const pcm = gsmDecodePacket(input); // Int16Array(960)
      this.emit("pcm", pcm);
    } catch { /* ignore codec errors */ }
  }

  stop(): void { this.started = false; }
}

// ─── Encoder: Int16 PCM → GSM bytes ─────────────────────────────────────────

export class GsmEncoder extends EventEmitter {
  private started = false;

  start(): void { this.started = true; }

  encode(pcm: Int16Array): void {
    if (!this.started) return;
    const needed = GSM_FRAME_SAMPLES * FRAMES_PER_PACKET; // 960
    if (pcm.length < needed) return;
    try {
      const chunk = pcm.length === needed ? pcm : pcm.slice(0, needed);
      const gsm = gsmEncodePacket(chunk); // Uint8Array(198)
      this.emit("gsm", Buffer.from(gsm));
    } catch { /* ignore codec errors */ }
  }

  stop(): void { this.started = false; }
}
