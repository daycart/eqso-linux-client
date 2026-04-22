/**
 * Audio ALSA — captura y reproduccion via arecord / aplay.
 *
 * Captura:  arecord → PCM S16LE 8kHz mono → GsmEncoder → EqsoClient
 * Playback: EqsoClient → GsmDecoder → PCM → aplay
 *
 * El CM108 USB es half-duplex: solo puede capturar O reproducir en el mismo
 * dispositivo ALSA, no simultaneamente. Semi-duplex implementado:
 *   1. Al iniciar RX: kill arecord → esperar cierre ('close') → abrir aplay
 *   2. Al terminar RX: stdin.end() + mover a drainPlayer (300ms → SIGTERM)
 *
 * Estado del player:
 *   this.player      — aplay activo aceptando audio
 *   this.drainPlayer — aplay drenando (stdin cerrado, esperando vaciado buffer)
 *
 * Al abrir nuevo aplay: si drainPlayer sigue vivo → SIGKILL + esperar close real
 * antes de lanzar el nuevo. Evita "Device or resource busy".
 *
 * El PCM recibido durante la espera se acumula en jitterBuf.
 */

import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import { EventEmitter } from "events";
import { AudioConfig } from "./config.js";
import {
  GsmDecoder, GsmEncoder,
  GSM_FRAME_SAMPLES, FRAMES_PER_PACKET, GSM_PACKET_BYTES,
} from "./gsm-codec.js";

const PCM_CHUNK_SAMPLES = GSM_FRAME_SAMPLES * FRAMES_PER_PACKET; // 960 muestras = 1920 bytes

// Jitter buffer para RX: acumula muestras antes de abrir aplay.
const JITTER_PRE_BUFFER_SAMPLES = 960;

export class AlsaAudio extends EventEmitter {
  private recorder: ChildProcessWithoutNullStreams | null = null;
  private player:   ChildProcessWithoutNullStreams | null = null;
  // Player siendo drenado (stdin cerrado, esperando vaciado del buffer ALSA)
  private drainPlayer: ChildProcessWithoutNullStreams | null = null;
  private drainTimer:  ReturnType<typeof setTimeout> | null = null;
  private encoder = new GsmEncoder();
  private decoder = new GsmDecoder();
  private pcmAccum  = new Int16Array(0);
  private jitterBuf = new Int16Array(0);
  // Semi-duplex state
  private recorderSuspended = false;
  private playerStarting    = false; // true mientras esperamos cierre de arecord o drain aplay
  private stopping = false;
  // Metricas de nivel en captura
  private levelPeakRms   = 0;
  private levelClipCount = 0;
  private levelSamples   = 0;
  private levelTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private cfg: AudioConfig) {
    super();
  }

  start(): void {
    this.startDecoder();
    this.startEncoder();
    this.startRecorder();
    this.levelTimer = setInterval(() => this.logLevel(), 5000);
  }

  stop(): void {
    this.stopping = true;
    if (this.levelTimer) { clearInterval(this.levelTimer); this.levelTimer = null; }
    this.stopRecorder();
    // Matar drain player inmediatamente (sin esperar el timer de 300ms)
    this.killDrainPlayerNow();
    if (this.player) {
      try { this.player.kill("SIGTERM"); } catch { /* ignore */ }
      this.player = null;
    }
    this.encoder.stop();
    this.decoder.stop();
  }

  private rxGsmCount = 0;

  playGsm(gsm: Buffer): void {
    this.rxGsmCount++;
    if (this.rxGsmCount <= 3 || this.rxGsmCount % 50 === 0)
      log(`[playGsm] pkt#${this.rxGsmCount} len=${gsm.length} decoder_ready=${this.decoder.ready} player=${this.player ? "running" : "null"} playerStarting=${this.playerStarting}`);
    this.decoder.decode(gsm);
  }

  endRx(): void {
    this.stopPlayer();
  }

  setTxEnabled(enabled: boolean): void {
    if (!enabled) {
      this.pcmAccum = new Int16Array(0);
    }
  }

  // ── Encoder (micro → GSM) ─────────────────────────────────────────────────

  private startEncoder(): void {
    this.encoder.start();
    this.encoder.on("gsm", (gsm: Buffer) => {
      this.emit("gsm_tx", gsm);
    });
  }

  feedPcm(pcm: Int16Array): void {
    const merged = new Int16Array(this.pcmAccum.length + pcm.length);
    merged.set(this.pcmAccum);
    merged.set(pcm, this.pcmAccum.length);
    this.pcmAccum = merged;

    this.emit("pcm_chunk", pcm);

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

  private pcmChunkCount = 0;

  private playPcm(pcm: Int16Array): void {
    const samples = this.applyGain(pcm);
    this.pcmChunkCount++;

    if (!this.player || this.player.killed) {
      const merged = new Int16Array(this.jitterBuf.length + samples.length);
      merged.set(this.jitterBuf);
      merged.set(samples, this.jitterBuf.length);
      this.jitterBuf = merged;

      if (this.pcmChunkCount <= 5)
        log(`[playPcm] chunk#${this.pcmChunkCount} → jitterBuf=${this.jitterBuf.length} playerStarting=${this.playerStarting}`);

      if (this.jitterBuf.length >= JITTER_PRE_BUFFER_SAMPLES && !this.playerStarting) {
        this.startPlayer();
      }
      return;
    }

    if (this.pcmChunkCount <= 5)
      log(`[playPcm] chunk#${this.pcmChunkCount} → escribiendo ${samples.length} muestras a aplay stdin`);
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
      log(`[arecord] Error: ${err.message}`);
      this.emit("error", err);
    });

    this.recorder.on("close", (code) => {
      log(`[arecord] Terminado (code ${code})`);
      this.recorder = null;

      if (this.playerStarting) {
        log("[audio] arecord cerrado — abriendo aplay");
        this.playerStarting = false;
        this.openPlayer();
        return;
      }

      if (!this.recorderSuspended && !this.stopping) {
        setTimeout(() => {
          if (!this.recorderSuspended && !this.stopping && this.recorder === null) {
            this.startRecorder();
          }
        }, 2000);
      }
    });

    this.recorder.stdout.on("data", (chunk: Buffer) => {
      const gain = this.cfg.inputGain;
      const sampleCount = Math.floor(chunk.length / 2);
      const pcm = new Int16Array(sampleCount);
      let sumSq = 0;
      for (let i = 0; i < sampleCount; i++) {
        const raw = chunk.readInt16LE(i * 2);
        const drive = 1.5;
        const norm = (raw * gain) / 32768;
        const limited = Math.tanh(norm * drive) / Math.tanh(drive);
        const s = Math.round(limited * 32767);
        pcm[i] = s;
        sumSq += s * s;
        if (Math.abs(s) > 30000) this.levelClipCount++;
      }
      const rms = Math.sqrt(sumSq / sampleCount);
      if (rms > this.levelPeakRms) this.levelPeakRms = rms;
      this.levelSamples += sampleCount;
      this.feedPcm(pcm);
    });
  }

  private stopRecorder(): void {
    try { this.recorder?.kill("SIGTERM"); } catch { /* ignore */ }
    this.recorder = null;
  }

  private logLevel(): void {
    if (this.levelSamples === 0) return;
    const peakDb = this.levelPeakRms > 0
      ? (20 * Math.log10(this.levelPeakRms / 32768)).toFixed(1)
      : "-inf";
    const clipPct = ((this.levelClipCount / this.levelSamples) * 100).toFixed(2);
    const clipping = this.levelClipCount > 0 ? ` SATURACION: ${this.levelClipCount} muestras (${clipPct}%)` : "";
    log(`[nivel] pico RMS=${Math.round(this.levelPeakRms)} (${peakDb} dBFS)  VOXumbral=${this.cfg.voxThresholdRms}  gain=${this.cfg.inputGain}${clipping}`);
    this.levelPeakRms   = 0;
    this.levelClipCount = 0;
    this.levelSamples   = 0;
  }

  // ── aplay ────────────────────────────────────────────────────────────────

  /**
   * Inicia la secuencia semi-duplex:
   *   1. Si hay arecord corriendo: SIGTERM + esperar 'close' (async)
   *   2. Cuando arecord cierra: openPlayer()
   *   3. Si no hay arecord: openPlayer() directamente
   */
  private startPlayer(): void {
    if (this.playerStarting) return;

    if (this.recorder) {
      log("[audio] Semi-duplex: matando arecord — esperando cierre para abrir aplay");
      this.playerStarting    = true;
      this.recorderSuspended = true;
      const rec = this.recorder;
      this.recorder = null;

      const watchdog = setTimeout(() => {
        if (this.playerStarting) {
          log("[audio] Watchdog: SIGKILL a arecord (SIGTERM no respondido)");
          try { rec.kill("SIGKILL"); } catch { /* ignore */ }
        }
      }, 800);

      rec.once("close", () => clearTimeout(watchdog));
      try { rec.kill("SIGTERM"); } catch {
        clearTimeout(watchdog);
        this.playerStarting = false;
        this.openPlayer();
      }
    } else {
      this.openPlayer();
    }
  }

  /**
   * Comprueba si el drainPlayer todavia esta vivo. Si es asi, lo mata con
   * SIGKILL y espera el cierre real antes de abrir el nuevo aplay.
   * Esto garantiza que el dispositivo ALSA este libre (evita "Device or
   * resource busy").
   */
  private openPlayer(): void {
    if (this.stopping) return;

    if (this.drainPlayer) {
      const old = this.drainPlayer;
      if (this.drainTimer) { clearTimeout(this.drainTimer); this.drainTimer = null; }
      this.drainPlayer   = null;
      this.playerStarting = true; // bloquear llamadas duplicadas mientras esperamos
      log("[audio] openPlayer: SIGKILL a aplay anterior — esperando cierre para liberar ALSA");
      try { old.kill("SIGKILL"); } catch { /* ignore */ }
      old.once("close", () => {
        this.playerStarting = false;
        this.doOpenPlayer();
      });
      return;
    }

    this.doOpenPlayer();
  }

  /** Abre aplay y vuelca el jitter buffer. El dispositivo ALSA debe estar libre. */
  private doOpenPlayer(): void {
    if (this.stopping) return;

    const args = [
      "-D", this.cfg.playbackDevice,
      "-f", "S16_LE",
      "-r", "8000",
      "-c", "1",
      "-q",
      "--buffer-size=2048",
      "--period-size=256",
    ];
    log(`aplay ${args.join(" ")}`);
    this.player = spawn("aplay", args, { stdio: ["pipe", "ignore", "pipe"] });
    const p = this.player;

    p.stderr.on("data", (d: Buffer) => {
      const msg = d.toString().trim();
      if (msg) log(`[aplay] ${msg}`);
    });

    p.on("error", (err) => {
      log(`[aplay] Error: ${err.message}`);
    });

    p.on("close", (code) => {
      log(`[aplay] Terminado (code ${code})`);
      if (this.player === p) {
        this.player = null;
        // Aplay cerrado mientras seguia activo (underrun severo, etc.)
        // Reanudar arecord si corresponde.
        if (this.recorderSuspended && !this.stopping && !this.playerStarting && !this.drainPlayer) {
          this.recorderSuspended = false;
          log("[audio] Semi-duplex: reanudando arecord (aplay cerrado inesperadamente)");
          this.startRecorder();
        }
      }
    });

    if (this.jitterBuf.length > 0) {
      const buf = Buffer.from(this.jitterBuf.buffer, this.jitterBuf.byteOffset, this.jitterBuf.byteLength);
      try { p.stdin.write(buf); } catch { /* ignore */ }
      this.jitterBuf = new Int16Array(0);
    }
  }

  private stopPlayer(): void {
    if (this.jitterBuf.length > 0 && this.player && !this.player.killed) {
      const buf = Buffer.from(this.jitterBuf.buffer, this.jitterBuf.byteOffset, this.jitterBuf.byteLength);
      try { this.player.stdin.write(buf); } catch { /* ignore */ }
      this.jitterBuf = new Int16Array(0);
    }

    if (this.player) {
      const p = this.player;
      this.player = null;

      // Matar cualquier drain player previo (no puede haber dos aplay abiertos)
      this.killDrainPlayerNow();

      // Mover player actual a estado "drenando"
      this.drainPlayer = p;
      try { p.stdin.end(); } catch { /* ignore */ }

      // 300ms para que aplay vacie su buffer hardware, luego SIGTERM
      this.drainTimer = setTimeout(() => {
        this.drainTimer = null;
        if (this.drainPlayer === p) {
          try { p.kill("SIGTERM"); } catch { /* ignore */ }
        }
      }, 300);

      // Cuando el proceso termina: limpiar estado y reanudar arecord
      p.once("close", () => {
        if (this.drainTimer && this.drainPlayer === p) {
          clearTimeout(this.drainTimer);
          this.drainTimer = null;
        }
        if (this.drainPlayer === p) {
          this.drainPlayer = null;
          if (this.recorderSuspended && !this.stopping && !this.player && !this.playerStarting) {
            this.recorderSuspended = false;
            log("[audio] Semi-duplex: reanudando arecord");
            this.startRecorder();
          }
        }
      });

    } else if (this.recorderSuspended && !this.stopping && !this.playerStarting && !this.drainPlayer) {
      this.recorderSuspended = false;
      log("[audio] Semi-duplex: reanudando arecord (player ya cerrado)");
      this.startRecorder();
    }
  }

  /** Mata el drainPlayer inmediatamente (SIGKILL) sin esperar. */
  private killDrainPlayerNow(): void {
    if (this.drainPlayer) {
      if (this.drainTimer) { clearTimeout(this.drainTimer); this.drainTimer = null; }
      const p = this.drainPlayer;
      this.drainPlayer = null;
      try { p.kill("SIGKILL"); } catch { /* ignore */ }
    }
  }
}

function log(msg: string): void { console.log(`[audio] ${new Date().toISOString()} ${msg}`); }
