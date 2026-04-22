/**
 * Audio ALSA — captura y reproduccion via arecord / aplay.
 *
 * Captura:  arecord → PCM S16LE 8kHz mono → GsmEncoder → EqsoClient
 * Playback: EqsoClient → GsmDecoder → PCM → aplay
 *
 * El CM108 USB es half-duplex: solo puede capturar O reproducir en el mismo
 * dispositivo ALSA, no simultáneamente. Semi-duplex implementado:
 *   1. Al iniciar RX: kill arecord → esperar cierre (evento 'close') → abrir aplay
 *   2. Al terminar RX: stdin.end() → 300ms drain → SIGTERM aplay → reiniciar arecord
 *
 * El PCM recibido durante la espera del cierre de arecord se acumula en jitterBuf
 * para no perderse. Cuando aplay abre, se vuelca todo de golpe.
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
// 960 = 1 paquete GSM = 120ms. Esperar solo 1 paquete completo antes de abrir
// aplay reduce la latencia inicial ~120ms respecto a esperar 2 paquetes (1280).
const JITTER_PRE_BUFFER_SAMPLES = 960;

export class AlsaAudio extends EventEmitter {
  private recorder: ChildProcessWithoutNullStreams | null = null;
  private player:   ChildProcessWithoutNullStreams | null = null;
  private encoder = new GsmEncoder();
  private decoder = new GsmDecoder();
  private pcmAccum  = new Int16Array(0);
  private jitterBuf = new Int16Array(0); // buffer pre-inicio aplay
  // Semi-duplex state
  private recorderSuspended = false; // true mientras aplay está activo o arecord cerrando
  private playerStarting    = false; // true mientras esperamos que arecord cierre (async)
  // Flag de parada intencional (stop() llamado) — evita reinicios de arecord
  private stopping = false;
  // Métricas de nivel en captura (log periódico)
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
    // Log de nivel cada 5 segundos para calibración
    this.levelTimer = setInterval(() => this.logLevel(), 5000);
  }

  stop(): void {
    this.stopping = true;
    if (this.levelTimer) { clearInterval(this.levelTimer); this.levelTimer = null; }
    this.stopRecorder();
    this.stopPlayer();
    this.encoder.stop();
    this.decoder.stop();
  }

  private rxGsmCount = 0;

  /** Reproducir un paquete GSM recibido del servidor eQSO. */
  playGsm(gsm: Buffer): void {
    this.rxGsmCount++;
    if (this.rxGsmCount <= 3 || this.rxGsmCount % 50 === 0)
      log(`[playGsm] pkt#${this.rxGsmCount} len=${gsm.length} decoder_ready=${this.decoder.ready} player=${this.player ? "running" : "null"} playerStarting=${this.playerStarting}`);
    this.decoder.decode(gsm);
  }

  /**
   * Terminar sesion RX — para el proceso aplay para evitar underruns.
   * Los ultimos 960 samples (120 ms) ya se habian escrito en stdin de aplay
   * antes de que expire el timer de RX_HANG_MS, por lo que no se corta audio.
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

    // Emitir chunks PCM para que el VOX los analise
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

  private pcmChunkCount = 0;

  private playPcm(pcm: Int16Array): void {
    const samples = this.applyGain(pcm);
    this.pcmChunkCount++;

    if (!this.player || this.player.killed) {
      // Acumular en jitter buffer, tanto en la espera pre-inicio como mientras
      // arecord está cerrando (playerStarting=true).
      const merged = new Int16Array(this.jitterBuf.length + samples.length);
      merged.set(this.jitterBuf);
      merged.set(samples, this.jitterBuf.length);
      this.jitterBuf = merged;

      if (this.pcmChunkCount <= 5)
        log(`[playPcm] chunk#${this.pcmChunkCount} → jitterBuf=${this.jitterBuf.length} playerStarting=${this.playerStarting}`);

      // Si tenemos suficiente audio Y no estamos esperando el cierre de arecord,
      // iniciar la secuencia semi-duplex (kill arecord → wait close → open aplay).
      if (this.jitterBuf.length >= JITTER_PRE_BUFFER_SAMPLES && !this.playerStarting) {
        this.startPlayer();
      }
      return;
    }

    // aplay ya está corriendo: escribir directamente
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
      log(`[arecord] Error: ${err.message} — comprueba que ALSA esta disponible`);
      this.emit("error", err);
    });

    this.recorder.on("close", (code) => {
      log(`[arecord] Terminado (code ${code})`);
      this.recorder = null;

      if (this.playerStarting) {
        // El cierre fue desencadenado por startPlayer() — ahora abrir aplay
        log("[audio] arecord cerrado — abriendo aplay");
        this.playerStarting = false;
        this.openPlayer();
        return;
      }

      // Cierre inesperado (crash de arecord): reiniciar con backoff si no
      // estamos en modo suspended (aplay activo) ni en parada intencional.
      if (!this.recorderSuspended && !this.stopping) {
        setTimeout(() => {
          if (!this.recorderSuspended && !this.stopping && this.recorder === null) {
            this.startRecorder();
          }
        }, 2000);
      }
    });

    // PCM 8 kHz S16LE mono → 16000 bytes/seg → chunks de ~20ms = 320 bytes
    this.recorder.stdout.on("data", (chunk: Buffer) => {
      const gain = this.cfg.inputGain;
      const sampleCount = Math.floor(chunk.length / 2);
      const pcm = new Int16Array(sampleCount);
      let sumSq = 0;
      for (let i = 0; i < sampleCount; i++) {
        const raw = chunk.readInt16LE(i * 2);
        // Limitador suave via tanh: amplifica senales debiles sin clipear las fuertes.
        // Normalizar a [-1,+1], aplicar tanh(x*drive)/tanh(drive) y volver a S16.
        // Drive=1.5 => saturacion suave sin distorsion apreciable hasta ~±0.7 FS.
        const drive = 1.5;
        const norm = (raw * gain) / 32768;
        const limited = Math.tanh(norm * drive) / Math.tanh(drive);
        const s = Math.round(limited * 32767);
        pcm[i] = s;
        sumSq += s * s;
        // Con tanh nunca hay clipping duro, pero registramos muestras cerca del limite
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
    if (this.levelSamples === 0) return; // silencio total — no loguear
    const peakDb = this.levelPeakRms > 0
      ? (20 * Math.log10(this.levelPeakRms / 32768)).toFixed(1)
      : "-inf";
    const clipPct = ((this.levelClipCount / this.levelSamples) * 100).toFixed(2);
    const clipping = this.levelClipCount > 0 ? ` SATURACION: ${this.levelClipCount} muestras (${clipPct}%)` : "";
    log(`[nivel] pico RMS=${Math.round(this.levelPeakRms)} (${peakDb} dBFS)  VOXumbral=${this.cfg.voxThresholdRms}  gain=${this.cfg.inputGain}${clipping}`);
    // Reset acumuladores
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
   *
   * El PCM sigue acumulándose en jitterBuf durante la espera (playPcm lo hace).
   * playerStarting=true durante toda la espera para evitar llamadas duplicadas.
   */
  private startPlayer(): void {
    if (this.playerStarting) return; // ya esperando cierre de arecord

    if (this.recorder) {
      log("[audio] Semi-duplex: matando arecord — esperando cierre para abrir aplay");
      this.playerStarting    = true;
      this.recorderSuspended = true;
      const rec = this.recorder;
      this.recorder = null;

      // Watchdog: si SIGTERM no llega en 800ms, SIGKILL
      const watchdog = setTimeout(() => {
        if (this.playerStarting) {
          log("[audio] Watchdog: SIGKILL a arecord (SIGTERM no respondido)");
          try { rec.kill("SIGKILL"); } catch { /* ignore */ }
        }
      }, 800);

      // El evento 'close' del recorder llamará a openPlayer() (ver startRecorder)
      rec.once("close", () => clearTimeout(watchdog));
      try { rec.kill("SIGTERM"); } catch {
        // Si ya murió, el close event ya se habrá emitido o no se emitirá.
        clearTimeout(watchdog);
        this.playerStarting = false;
        this.openPlayer();
      }
    } else {
      // arecord no está corriendo (ya fue parado, o nunca arrancó)
      this.openPlayer();
    }
  }

  /** Abre aplay y vuelca el jitter buffer. Llamado cuando arecord ha cerrado. */
  private openPlayer(): void {
    if (this.stopping) return;

    const args = [
      "-D", this.cfg.playbackDevice,
      "-f", "S16_LE",
      "-r", "8000",
      "-c", "1",
      "-q",
      "--buffer-size=2048",  // 256ms buffer hardware
      "--period-size=256",   // 32ms por periodo — menor latencia de salida
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

    this.player.on("close", (code) => {
      log(`[aplay] Terminado (code ${code})`);
      this.player = null;
    });

    // Volcar jitter buffer acumulado durante la espera
    if (this.jitterBuf.length > 0) {
      const buf = Buffer.from(this.jitterBuf.buffer, this.jitterBuf.byteOffset, this.jitterBuf.byteLength);
      try { this.player.stdin.write(buf); } catch { /* ignore */ }
      this.jitterBuf = new Int16Array(0);
    }
  }

  private stopPlayer(): void {
    // Si hay audio en el jitter buffer sin reproducir, volcarlo antes de parar
    if (this.jitterBuf.length > 0 && this.player && !this.player.killed) {
      const buf = Buffer.from(this.jitterBuf.buffer, this.jitterBuf.byteOffset, this.jitterBuf.byteLength);
      try { this.player.stdin.write(buf); } catch { /* ignore */ }
      this.jitterBuf = new Int16Array(0);
    }

    if (this.player) {
      const p = this.player;
      this.player = null;
      try { p.stdin.end(); } catch { /* ignore */ }
      // Dar 300ms a aplay para reproducir lo que queda en su buffer hardware,
      // luego matar y reanudar arecord (semi-duplex).
      setTimeout(() => {
        try { p.kill("SIGTERM"); } catch { /* ignore */ }
        if (this.recorderSuspended && !this.stopping) {
          this.recorderSuspended = false;
          log("[audio] Semi-duplex: reanudando arecord");
          this.startRecorder();
        }
      }, 300);
    } else if (this.recorderSuspended && !this.stopping && !this.playerStarting) {
      // Player ya cerrado pero arecord sigue suspendido — reanudar
      this.recorderSuspended = false;
      log("[audio] Semi-duplex: reanudando arecord (player ya cerrado)");
      this.startRecorder();
    }
  }
}

function log(msg: string): void { console.log(`[audio] ${new Date().toISOString()} ${msg}`); }
