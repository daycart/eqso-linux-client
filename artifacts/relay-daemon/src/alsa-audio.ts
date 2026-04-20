/**
 * Audio ALSA — captura y reproduccion via arecord / aplay.
 *
 * Captura:  arecord → PCM S16LE 8kHz mono → GsmEncoder → EqsoClient
 * Playback: EqsoClient → GsmDecoder → PCM → aplay
 *
 * La captura se inicia siempre (para el VOX).
 * La reproduccion arranca on-demand con cada paquete RX.
 */

import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import { EventEmitter } from "events";
import { AudioConfig } from "./config.js";
import {
  GsmDecoder, GsmEncoder,
  GSM_FRAME_SAMPLES, FRAMES_PER_PACKET, GSM_PACKET_BYTES,
} from "./gsm-codec.js";

const PCM_CHUNK_SAMPLES = GSM_FRAME_SAMPLES * FRAMES_PER_PACKET; // 960 muestras = 1920 bytes

export class AlsaAudio extends EventEmitter {
  private recorder: ChildProcessWithoutNullStreams | null = null;
  private player:   ChildProcessWithoutNullStreams | null = null;
  private encoder = new GsmEncoder();
  private decoder = new GsmDecoder();
  private pcmAccum = new Int16Array(0);

  constructor(private cfg: AudioConfig) {
    super();
  }

  start(): void {
    this.startDecoder();
    this.startEncoder();
    this.startRecorder();
  }

  stop(): void {
    this.stopRecorder();
    this.stopPlayer();
    this.encoder.stop();
    this.decoder.stop();
  }

  /** Reproducir un paquete GSM recibido del servidor eQSO. */
  playGsm(gsm: Buffer): void {
    this.decoder.decode(gsm);
  }

  /**
   * Terminar sesion RX — para el proceso aplay para evitar underruns.
   * Los ultimos 960 samples (120 ms) ya se habian escrito en stdin de aplay
   * antes de que expire el timer de 600 ms, por lo que no se corta audio.
   */
  endRx(): void {
    this.stopPlayer();
  }

  /** Habilitar/deshabilitar envio de audio TX (controlado externamente por VOX o PTT). */
  setTxEnabled(enabled: boolean): void {
    // Se gestiona a nivel de main.ts — aqui solo preparamos el encoder
    if (!enabled) {
      this.pcmAccum = new Int16Array(0); // descartar buffer acumulado
    }
  }

  // ── Encoder (micro → GSM) ─────────────────────────────────────────────────

  private startEncoder(): void {
    this.encoder.start();
    this.encoder.on("gsm", (gsm: Buffer) => {
      this.emit("gsm_tx", gsm);
    });
  }

  /** Alimentar muestras PCM al encoder (llamado desde el recorder). */
  feedPcm(pcm: Int16Array): void {
    // Acumular muestras
    const merged = new Int16Array(this.pcmAccum.length + pcm.length);
    merged.set(this.pcmAccum);
    merged.set(pcm, this.pcmAccum.length);
    this.pcmAccum = merged;

    // Emitir chunks PCM para que el VOX los analice
    this.emit("pcm_chunk", pcm);

    // Enviar al encoder en paquetes de 960 muestras exactas
    while (this.pcmAccum.length >= PCM_CHUNK_SAMPLES) {
      const chunk = this.pcmAccum.slice(0, PCM_CHUNK_SAMPLES);
      this.pcmAccum = this.pcmAccum.slice(PCM_CHUNK_SAMPLES);
      this.encoder.encode(chunk);
    }
  }

  // ── Decoder (GSM → aplay) ────────────────────────────────────────────────

  private startDecoder(): void {
    this.decoder.start();
    this.decoder.on("pcm", (pcm: Int16Array) => {
      this.playPcm(pcm);
    });
  }

  private playPcm(pcm: Int16Array): void {
    if (!this.player || this.player.killed) {
      this.startPlayer();
    }
    const gain = this.cfg.outputGain;
    let buf: Buffer;
    if (gain !== 1.0) {
      const adjusted = new Int16Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) {
        adjusted[i] = Math.max(-32768, Math.min(32767, Math.round(pcm[i] * gain)));
      }
      buf = Buffer.from(adjusted.buffer, adjusted.byteOffset, adjusted.byteLength);
    } else {
      buf = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    }
    try { this.player?.stdin.write(buf); } catch { /* player may have closed */ }
  }

  // ── arecord ───────────────────────────────────────────────────────────────

  private startRecorder(): void {
    // sox: captura a la tasa nativa del hardware y remuestrea a 8 kHz con
    // alta calidad (sinc). Esto evita los artefactos metalicos que produce
    // el remuestreador lineal de ALSA cuando el hardware no soporta 8 kHz.
    const args = [
      "-t", "alsa", this.cfg.captureDevice,  // entrada: ALSA a tasa nativa
      "-t", "raw",                            // salida: PCM crudo por stdout
      "-r", "8000",                           // frecuencia de salida: 8 kHz
      "-e", "signed-integer",
      "-b", "16",
      "-c", "1",
      "-L",                                   // little-endian
      "-",                                    // stdout
    ];

    log(`sox (capture) ${args.join(" ")}`);
    this.recorder = spawn("sox", args, { stdio: ["ignore", "pipe", "pipe"] });

    this.recorder.stderr.on("data", (d: Buffer) => {
      const msg = d.toString().trim();
      if (msg) log(`[arecord] ${msg}`);
    });

    this.recorder.on("error", (err) => {
      log(`[arecord] Error: ${err.message} — comprueba que ALSA esta disponible`);
      this.emit("error", err);
    });

    this.recorder.on("close", (code) => {
      log(`[arecord] Terminado (code ${code})`);
      this.recorder = null;
      // Reintentamos despues de 2 s para no saturar si falla continuamente
      setTimeout(() => { if (this.recorder === null) this.startRecorder(); }, 2000);
    });

    // PCM 8 kHz S16LE mono → 16000 bytes/seg → chunks de ~20ms = 320 bytes
    this.recorder.stdout.on("data", (chunk: Buffer) => {
      const gain = this.cfg.inputGain;
      const sampleCount = Math.floor(chunk.length / 2);
      const pcm = new Int16Array(sampleCount);
      for (let i = 0; i < sampleCount; i++) {
        const raw = chunk.readInt16LE(i * 2);
        pcm[i] = Math.max(-32768, Math.min(32767, Math.round(raw * gain)));
      }
      this.feedPcm(pcm);
    });
  }

  private stopRecorder(): void {
    try { this.recorder?.kill("SIGTERM"); } catch { /* ignore */ }
    this.recorder = null;
  }

  // ── aplay ────────────────────────────────────────────────────────────────

  private startPlayer(): void {
    // sox: recibe PCM a 8 kHz por stdin y reproduce a la tasa nativa del
    // hardware con remuestreo de alta calidad (sinc).
    const args = [
      "-t", "raw",                             // entrada: PCM crudo por stdin
      "-r", "8000",                            // frecuencia de entrada: 8 kHz
      "-e", "signed-integer",
      "-b", "16",
      "-c", "1",
      "-L",                                    // little-endian
      "-",                                     // stdin
      "-t", "alsa", this.cfg.playbackDevice,  // salida: ALSA a tasa nativa
    ];
    log(`sox (playback) ${args.join(" ")}`);
    this.player = spawn("sox", args, { stdio: ["pipe", "ignore", "pipe"] });

    this.player.stderr.on("data", (d: Buffer) => {
      const msg = d.toString().trim();
      if (msg) log(`[aplay] ${msg}`);
    });

    this.player.on("error", (err) => {
      log(`[aplay] Error: ${err.message}`);
    });

    this.player.on("close", () => {
      this.player = null;
    });
  }

  private stopPlayer(): void {
    try { this.player?.stdin.end(); this.player?.kill("SIGTERM"); } catch { /* ignore */ }
    this.player = null;
  }
}

function log(msg: string): void { console.log(`[audio] ${new Date().toISOString()} ${msg}`); }
