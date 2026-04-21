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

// Jitter buffer para RX: acumula muestras antes de abrir aplay
// 160 ms × 8000 Hz = 1280 muestras — absorbe jitter sin cortar mensajes cortos
const JITTER_PRE_BUFFER_SAMPLES = 1280;

export class AlsaAudio extends EventEmitter {
  private recorder: ChildProcessWithoutNullStreams | null = null;
  private player:   ChildProcessWithoutNullStreams | null = null;
  private encoder = new GsmEncoder();
  private decoder = new GsmDecoder();
  private pcmAccum  = new Int16Array(0);
  private jitterBuf = new Int16Array(0); // buffer pre-inicio aplay

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

  private applyGain(pcm: Int16Array): Int16Array {
    const gain = this.cfg.outputGain;
    if (gain === 1.0) return pcm;
    const out = new Int16Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) {
      out[i] = Math.max(-32768, Math.min(32767, Math.round(pcm[i] * gain)));
    }
    return out;
  }

  private playPcm(pcm: Int16Array): void {
    const samples = this.applyGain(pcm);

    if (!this.player || this.player.killed) {
      // Acumular en jitter buffer hasta tener suficiente audio pre-cargado
      const merged = new Int16Array(this.jitterBuf.length + samples.length);
      merged.set(this.jitterBuf);
      merged.set(samples, this.jitterBuf.length);
      this.jitterBuf = merged;

      if (this.jitterBuf.length >= JITTER_PRE_BUFFER_SAMPLES) {
        // Buffer lleno: abrir aplay y volcar todo de golpe
        this.startPlayer();
        const buf = Buffer.from(this.jitterBuf.buffer, this.jitterBuf.byteOffset, this.jitterBuf.byteLength);
        try { this.player?.stdin.write(buf); } catch { /* ignore */ }
        this.jitterBuf = new Int16Array(0);
      }
      return;
    }

    // aplay ya está corriendo: escribir directamente
    const buf = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
    try { this.player?.stdin.write(buf); } catch { /* player may have closed */ }
  }

  // ── arecord ───────────────────────────────────────────────────────────────

  private startRecorder(): void {
    const args = [
      "-D", this.cfg.captureDevice,
      "-f", "S16_LE",
      "-r", "8000",
      "-c", "1",
      "-q",
      "--buffer-size=1024",
    ];

    log(`arecord ${args.join(" ")}`);
    this.recorder = spawn("arecord", args, { stdio: ["ignore", "pipe", "pipe"] });

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
    const args = [
      "-D", this.cfg.playbackDevice,
      "-f", "S16_LE",
      "-r", "8000",
      "-c", "1",
      "-q",
      "--buffer-size=16384",  // 2s de buffer hardware — absorbe jitter de red
      "--period-size=2048",   // periodos de 256ms — menos interrupciones
    ];
    log(`aplay ${args.join(" ")}`);
    this.player = spawn("aplay", args, { stdio: ["pipe", "ignore", "pipe"] });

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
    // Si hay audio en el jitter buffer sin reproducir, volcarlo antes de parar
    if (this.jitterBuf.length > 0) {
      if (!this.player || this.player.killed) this.startPlayer();
      const buf = Buffer.from(this.jitterBuf.buffer, this.jitterBuf.byteOffset, this.jitterBuf.byteLength);
      try { this.player?.stdin.write(buf); } catch { /* ignore */ }
      this.jitterBuf = new Int16Array(0);
    }
    if (this.player) {
      const p = this.player;
      this.player = null;
      try { p.stdin.end(); } catch { /* ignore */ }
      // Dar 400ms a aplay para reproducir lo que queda en su buffer hardware
      setTimeout(() => { try { p.kill("SIGTERM"); } catch { /* ignore */ } }, 400);
    }
  }
}

function log(msg: string): void { console.log(`[audio] ${new Date().toISOString()} ${msg}`); }
