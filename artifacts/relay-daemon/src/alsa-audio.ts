/**
 * Audio ALSA — captura y reproduccion via arecord / aplay.
 *
 * Captura:  arecord → PCM S16LE 8kHz mono → GsmEncoder → EqsoClient
 * Playback: EqsoClient → GsmDecoder → PCM → aplay (permanente)
 *
 * aplay arranca al inicio (startPlayerPermanent) y NUNCA se cierra durante
 * operacion normal. Cuando no hay audio RX, escribe silencio via
 * startSilenceInjection. Esto evita el ciclo open/close que en VirtualBox
 * corrompe el estado USB interno del CM108/PCM2902 e impide que arecord
 * vuelva a abrir el device ("Unable to install hw params").
 *
 * Semi-duplex de arecord (evitar realimentacion altavoz→micro):
 *   1. Al iniciar RX: kill arecord (el altavoz esta activo)
 *   2. Al terminar RX: reiniciar arecord (aplay sigue vivo con silencio)
 *
 * rxActive controla si playPcm escribe audio o acumula en jitterBuf (pre-roll).
 */

import { spawn, spawnSync, ChildProcessWithoutNullStreams } from "child_process";
import { EventEmitter } from "events";
import { AudioConfig } from "./config.js";
import {
  GsmDecoder, GsmEncoder,
  GSM_FRAME_SAMPLES, FRAMES_PER_PACKET, GSM_PACKET_BYTES,
} from "./gsm-codec.js";

// Frame GSM de silencio precomputado: se genera UNA vez al cargar el modulo
// codificando 160 muestras PCM nulas a traves de ffmpeg. Se usa en el
// tx-keepalive timer para rellenar gaps del CM108 sin pasar por ffmpeg
// (ffmpeg hace batching interno que impide el flush frame a frame).
function computeGsmSilenceFrame(): Buffer {
  const pcm = Buffer.alloc(GSM_FRAME_SAMPLES * 2, 0); // 320 bytes de silencio PCM S16LE
  try {
    const r = spawnSync("ffmpeg", [
      "-hide_banner", "-loglevel", "quiet",
      "-f", "s16le", "-ar", "8000", "-ac", "1",
      "-i", "pipe:0",
      "-f", "gsm", "-ar", "8000",
      "pipe:1",
    ], { input: pcm, encoding: "buffer", timeout: 5000 });
    if (r.stdout && r.stdout.length >= GSM_PACKET_BYTES) {
      console.log(`[audio] GSM silence precomputado: ${r.stdout.slice(0, GSM_PACKET_BYTES).toString("hex")}`);
      return r.stdout.slice(0, GSM_PACKET_BYTES) as Buffer;
    }
    console.error(`[audio] GSM silence: ffmpeg devolvio ${r.stdout?.length ?? 0} bytes (esperado ${GSM_PACKET_BYTES})`);
  } catch (e) {
    console.error(`[audio] GSM silence: fallo precomputo: ${e}`);
  }
  // Fallback de emergencia: frame vacio (no deberia ocurrir)
  return Buffer.alloc(GSM_PACKET_BYTES, 0);
}
const GSM_SILENCE_FRAME = computeGsmSilenceFrame();

const PCM_CHUNK_SAMPLES = GSM_FRAME_SAMPLES * FRAMES_PER_PACKET; // 160 muestras = 320 bytes (1 frame GSM)

// Jitter buffer para RX: acumula muestras antes de abrir aplay.
// 1920 = 2 paquetes = 240ms. Permite absorber variaciones de timing al arrancar.
const JITTER_PRE_BUFFER_SAMPLES = 1920;

// Silencio inyectado en aplay para mantener el stream USB vivo.
// En VirtualBox el scheduler puede retrasar setInterval hasta 400ms,
// por eso usamos inyecciones grandes y buffer de aplay de 3s.
// Para radio (relay eQSO) una latencia de inicio de RX de ~3s es aceptable.
const SILENCE_THRESHOLD_MS  = 40;   // ms sin audio → inyectar silencio
const SILENCE_INJECT_BYTES  = 8000; // 4000 muestras × 2 bytes = 500ms a 8kHz S16LE

export class AlsaAudio extends EventEmitter {
  private recorder: ChildProcessWithoutNullStreams | null = null;
  private player:   ChildProcessWithoutNullStreams | null = null;
  private encoder = new GsmEncoder();
  private decoder = new GsmDecoder();
  private pcmAccum  = new Int16Array(0);
  private jitterBuf = new Int16Array(0);
  // Semi-duplex state
  private recorderSuspended = false;
  // rxActive: true cuando estamos en modo reproduccion RX (no silencio).
  // aplay arranca al inicio y NUNCA cierra — escribe silencio cuando no hay
  // audio RX para evitar el ciclo open/close que corrompe el estado USB de
  // VirtualBox. rxActive controla si playPcm escribe audio o sigue en pre-buffer.
  private rxActive = false;
  private stopping = false;
  // Metricas de nivel en captura
  private levelPeakRms   = 0;
  private levelClipCount = 0;
  private levelSamples   = 0;
  private levelTimer: ReturnType<typeof setInterval> | null = null;
  // Inyeccion de silencio: previene underruns de aplay cuando hay gaps de red
  private silenceTimer:      ReturnType<typeof setInterval> | null = null;
  private lastAudioWriteMs = 0;
  // Diagnostico arecord: log tamaño de los primeros chunks (verifica period=160)
  private arecordChunkCount = 0;
  private lastArecordChunkMs = 0;
  // Jitter buffer de captura: absorbe las rafagas periodicas del CM108 USB y
  // entrega PCM al encoder GSM a ritmo constante de 20ms via captureTimer.
  // El CM108 batch-entrega ~750ms de audio cada segundo (firmware USB); sin
  // este buffer el encoder recibe rafagas y produce GSM bursty no transmisible.
  private captureRingBuf: Int16Array = new Int16Array(0);
  private captureTimer: ReturnType<typeof setInterval> | null = null;
  // GSM TX rate limiter: sustituye el antiguo keepalive timer.
  // Problema resuelto: FFmpeg GSM encoder hace batch de 2 frames cada ~40ms
  // (incluso con -avioflags direct). El keepalive anterior (threshold 20ms)
  // insertaba 1 frame de silencio entre cada par → patron S,R,R,S,R,R → 33%
  // silencio → audio cortado e "inaudible" en la sala eQSO.
  //
  // Solucion: cola FIFO + timer de 20ms. El encoder llena la cola con frames
  // reales; el timer saca 1 frame por tick. Si la cola lleva >50ms vacia (gap
  // real de audio, p.ej. pausa entre palabras o CM108 sin datos), se rellena
  // con 1 frame de silencio para mantener la cadencia del protocolo eQSO.
  // Resultado: 0% silencio durante speech, silencios solo en pausas reales.
  private txActive = false;
  private gsmRateLimitQueue: Buffer[] = [];
  private gsmRateLimitTimer: ReturnType<typeof setInterval> | null = null;
  private gsmQueueEmptyMs = 0;

  constructor(private cfg: AudioConfig) {
    super();
  }

  start(): void {
    this.startDecoder();
    this.startEncoder();
    this.startRecorder();
    this.startCaptureTimer();
    this.levelTimer = setInterval(() => this.logLevel(), 5000);
    // Arrancar aplay permanente: escribe silencio hasta que llegue audio RX.
    // NUNCA se cierra durante operacion normal → evita la corrupcion USB VirtualBox
    // que ocurre cada vez que aplay termina y arecord intenta reabrir el device.
    this.startPlayerPermanent();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.captureTimer) { clearInterval(this.captureTimer); this.captureTimer = null; }
    this.captureRingBuf = new Int16Array(0);
    if (this.levelTimer) { clearInterval(this.levelTimer); this.levelTimer = null; }
    this.stopGsmRateLimiter();
    this.gsmRateLimitQueue = [];
    this.stopSilenceInjection();

    // Esperar a que arecord muera de verdad antes de salir.
    // Sin este await, node hace process.exit() mientras arecord sigue corriendo
    // y el proceso queda huerfano (ppid=1) bloqueando el dispositivo ALSA en
    // el siguiente arranque del servicio ("Device or resource busy").
    if (this.recorder) {
      const rec = this.recorder;
      this.recorder = null;
      await new Promise<void>((resolve) => {
        const sigkill = setTimeout(() => {
          try { rec.kill("SIGKILL"); } catch { /* ignore */ }
        }, 800);
        const timeout = setTimeout(resolve, 1500);
        rec.once("close", () => {
          clearTimeout(sigkill);
          clearTimeout(timeout);
          resolve();
        });
        try { rec.kill("SIGTERM"); } catch { resolve(); }
      });
    }

    if (this.player) {
      const p = this.player;
      this.player = null;
      // Shutdown graceful de aplay:
      //   1. Cerrar stdin → aplay vacia su buffer DMA y sale limpiamente
      //   2. Tras 500ms, SIGTERM si aun sigue vivo
      //   3. Tras 1500ms, continuar de todas formas (timeout de seguridad)
      // Esto evita el D-state: el D-state ocurre cuando SIGKILL interrumpe una
      // escritura DMA USB a mitad. Si esperamos a que aplay termine la escritura
      // por si mismo (cerrando stdin), no hay D-state.
      await new Promise<void>((resolve) => {
        const sigterm = setTimeout(() => {
          try { p.kill("SIGTERM"); } catch { /* ignore */ }
        }, 500);
        const timeout = setTimeout(resolve, 1500);
        p.once("close", () => {
          clearTimeout(sigterm);
          clearTimeout(timeout);
          resolve();
        });
        try { p.stdin.end(); } catch { /* ignore */ }
      });
    }

    this.encoder.stop();
    this.decoder.stop();
  }

  private rxGsmCount = 0;

  playGsm(gsm: Buffer): void {
    this.rxGsmCount++;
    if (this.rxGsmCount <= 3 || this.rxGsmCount % 50 === 0)
      log(`[playGsm] pkt#${this.rxGsmCount} len=${gsm.length} decoder_ready=${this.decoder.ready} player=${this.player ? "running" : "null"} rxActive=${this.rxActive}`);
    this.decoder.decode(gsm);
  }

  endRx(): void {
    this.stopPlayer();
  }

  setTxEnabled(enabled: boolean): void {
    this.txActive = enabled;
    if (enabled) {
      // Vaciar la cola y arrancar el rate limiter.
      this.gsmRateLimitQueue = [];
      this.gsmQueueEmptyMs = Date.now();
      this.startGsmRateLimiter();
    } else {
      this.stopGsmRateLimiter();
      this.gsmRateLimitQueue = [];
      this.pcmAccum    = new Int16Array(0);
      // Descartar audio pendiente: la TX ha terminado, no enviar mas silencio
      this.captureRingBuf = new Int16Array(0);
    }
  }

  // GSM TX rate limiter: consume 1 frame de la cola cada 20ms.
  // Si la cola lleva >50ms vacia (pausa real de voz o gap de CM108), inyecta
  // 1 frame de silencio para mantener la cadencia eQSO. Esto elimina los
  // silencios "espurios" del antiguo keepalive (threshold 20ms) que se colaban
  // entre cada par de frames reales que FFmpeg emite en batch (cada ~40ms),
  // causando el patron S,R,R que degradaba el audio en la sala.
  private startGsmRateLimiter(): void {
    if (this.gsmRateLimitTimer) return;
    this.gsmRateLimitTimer = setInterval(() => {
      if (!this.txActive) return;
      const frame = this.gsmRateLimitQueue.shift();
      if (frame) {
        // Frame real de audio: reset del contador de cola vacia
        this.gsmQueueEmptyMs = 0;
        this.emit("gsm_tx", frame);
      } else {
        // Cola vacia: anotar cuando empezo el silencio
        if (this.gsmQueueEmptyMs === 0) this.gsmQueueEmptyMs = Date.now();
        // Solo rellenar con silencio si hay un gap genuino >50ms
        // (no 20ms, para no interferir con el batch de 2 frames de FFmpeg)
        if (Date.now() - this.gsmQueueEmptyMs >= 50) {
          this.gsmQueueEmptyMs = Date.now();
          this.emit("gsm_tx", GSM_SILENCE_FRAME);
        }
      }
    }, 20);
  }

  private stopGsmRateLimiter(): void {
    if (this.gsmRateLimitTimer) {
      clearInterval(this.gsmRateLimitTimer);
      this.gsmRateLimitTimer = null;
    }
  }

  // ── Encoder (micro → GSM) ─────────────────────────────────────────────────

  private startEncoder(): void {
    this.encoder.start();
    this.encoder.on("gsm", (gsm: Buffer) => {
      // Meter el frame real en la cola del rate limiter.
      // El timer de 20ms lo sacara en su proximo tick → entrega espaciada.
      // NO emitir directamente: eso crearia rafagas de 2 frames (batch FFmpeg)
      // que el antiguo keepalive rellenaba con silencio causando S,R,R,S,...
      if (this.txActive) {
        this.gsmRateLimitQueue.push(Buffer.from(gsm));
      }
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

    if (!this.rxActive) {
      // Pre-buffer phase: aplay corre con silencio, acumulamos audio hasta tener
      // suficiente pre-roll antes de activar modo RX para evitar glitches iniciales.
      const merged = new Int16Array(this.jitterBuf.length + samples.length);
      merged.set(this.jitterBuf);
      merged.set(samples, this.jitterBuf.length);
      this.jitterBuf = merged;

      if (this.pcmChunkCount <= 5)
        log(`[playPcm] chunk#${this.pcmChunkCount} → jitterBuf=${this.jitterBuf.length} rxActive=false`);

      if (this.jitterBuf.length >= JITTER_PRE_BUFFER_SAMPLES) {
        this.startPlayer();
      }
      return;
    }

    if (this.pcmChunkCount <= 5)
      log(`[playPcm] chunk#${this.pcmChunkCount} → escribiendo ${samples.length} muestras a aplay stdin`);
    const buf = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
    try {
      this.player?.stdin.write(buf);
      this.lastAudioWriteMs = Date.now();
    } catch { /* player may have closed */ }
  }

  // ── Jitter buffer de captura ─────────────────────────────────────────────

  /**
   * Timer que consume el captureRingBuf a ritmo constante (20ms = 160 muestras).
   * El CM108 USB entrega audio en rafagas periodicas (~750ms); este timer
   * distribuye las rafagas uniformemente antes de entregarlas al encoder GSM.
   * Resultado: encoder recibe 1 frame cada 20ms → GSM output sin gaps.
   *
   * Latencia adicional introducida: hasta ~750ms (tamano maximo de la rafaga).
   * Aceptable para radio PTT donde la latencia total ya supera 1-2 segundos.
   *
   * Log de diagnostico: si el ring buffer supera 3200 muestras (400ms de audio
   * acumulado) se registra un aviso para detectar deriva del timer.
   */
  private startCaptureTimer(): void {
    if (this.captureTimer) clearInterval(this.captureTimer);

    // Cap duro: evitar OOM si el ring buffer crece sin control.
    // En VirtualBox el scheduler puede ralentizar el timer; si supera 2s de
    // audio acumulado (16000 muestras) se descarta el audio más antiguo.
    const MAX_CAPTURE_SAMPLES = 16000; // 2s a 8kHz
    // Log de deriva: solo cada 30s para no saturar el journal.
    let lastWarnMs = 0;

    let lastDrainMs = Date.now();

    this.captureTimer = setInterval(() => {
      // ── Cap duro: descartar muestras antiguas si el buffer crece demasiado ──
      if (this.captureRingBuf.length > MAX_CAPTURE_SAMPLES) {
        const now2 = Date.now();
        if (now2 - lastWarnMs > 30_000) {
          log(`[captureTimer] WARN: ring buffer ${this.captureRingBuf.length} muestras — descartando exceso (deriva de timer)`);
          lastWarnMs = now2;
        }
        // Conservar solo el ultimo segundo de audio (8000 muestras)
        this.captureRingBuf = this.captureRingBuf.slice(this.captureRingBuf.length - 8000);
        lastDrainMs = Date.now();
      }

      // ── Catch-up: drena tantos frames como indique el tiempo real transcurrido ──
      // Si el timer se retrasó (VirtualBox scheduler), drena múltiples frames
      // para que el ring buffer no crezca indefinidamente.
      const now = Date.now();
      const elapsed = now - lastDrainMs;
      // Minimo 1 frame, maximo 8 frames (160ms) para no saturar el encoder
      const framesToDrain = Math.max(1, Math.min(Math.round(elapsed / 20), 8));
      let drained = 0;
      while (drained < framesToDrain && this.captureRingBuf.length >= PCM_CHUNK_SAMPLES) {
        const chunk = this.captureRingBuf.slice(0, PCM_CHUNK_SAMPLES);
        this.captureRingBuf = this.captureRingBuf.slice(PCM_CHUNK_SAMPLES);
        this.feedPcm(chunk);
        drained++;
      }
      if (drained > 0) lastDrainMs += drained * 20;
    }, 20); // 20ms nominal; catch-up compensa la deriva del scheduler de VM
  }

  // ── arecord ───────────────────────────────────────────────────────────────

  // ── USB audio reset (CM108 VirtualBox) ──────────────────────────────────
  /**
   * Recarga el driver snd_usb_audio para recuperar el CM108 tras aplay.
   * En VirtualBox, cerrar aplay corrompe el estado USB interno del driver,
   * haciendo que arecord falle con 'Unable to install hw params'. El reload
   * resetea el estado y permite reiniciar arecord correctamente.
   * El servicio corre como root (sin User= en .service) → modprobe directo.
   */
  private resetUsbAudio(): Promise<void> {
    return new Promise<void>((resolve) => {
      log('[audio] USB reset: modprobe -r snd_usb_audio...');
      const unload = spawn('modprobe', ['-r', 'snd_usb_audio']);
      unload.on('error', (e: Error) => {
        log('[audio] USB reset: error en modprobe -r: ' + e.message + ' — saliendo para que systemd reinicie limpio');
        process.exit(1);
      });
      unload.on('close', (code: number | null) => {
        if (code !== 0) {
          // modprobe -r falla porque VirtualBox retiene el device USB mientras el
          // proceso está vivo. La única forma de liberarlo es que el daemon muera.
          // systemd lo reiniciará; en el ExecStartPre el modprobe -r sí funcionará
          // (nada retiene el módulo) y el device arrancará limpio.
          log('[audio] USB reset: modprobe -r falló (code ' + code + ') — saliendo para reinicio limpio via systemd');
          process.exit(1);
        }
        log('[audio] USB reset: descargado OK, recargando...');
        const load = spawn('modprobe', ['snd_usb_audio']);
        load.on('error', (e: Error) => {
          log('[audio] USB reset: error en modprobe load: ' + e.message);
          resolve();
        });
        load.on('close', (code2: number | null) => {
          log('[audio] USB reset: cargado (code ' + code2 + '), esperando 1.5s...');
          setTimeout(resolve, 1500);
        });
      });
    });
  }


  private startRecorder(): void {
    // ─── ESTRATEGIA DE CAPTURA: 48kHz nativo + decimación ×6 en Node.js ───────
    //
    // El CM108 opera nativamente a 48kHz. Si se pide 8kHz a plughw:, el plugin
    // de rate conversion de ALSA acumula muestras a 48kHz y las entrega en
    // bloques grandes → GAP de ~750ms irremediable desde user-space.
    //
    // Solución: capturar a 48kHz (tasa nativa del CM108, sin pasar por el rate
    // plugin) con period=960 muestras (20ms). ALSA entrega chunks cada 20ms
    // reales. Node.js decima ×6 aplicando un filtro FIR box de 6 coeficientes
    // (promedio) como anti-aliasing antes de entregar 8kHz al codificador GSM.
    //
    // Comparativa de estrategias probadas:
    //   1. plughw: + arecord a 8kHz    → GAP 750ms (rate-plugin batching)
    //   2. plughw: + ffmpeg a 8kHz     → GAP 750ms (misma capa)
    //   3. hw: + arecord a 48kHz -c2   → error "Channels count non available"
    //   4. hw: + arecord a 48kHz -c1   → GAP 2300ms + crashes I/O
    //   5. hw: + arecord a 8kHz  -c1   → GAP 750ms + crashes I/O
    //   6. plughw: + arecord a 48kHz + buffer=3840 (4×period) → chunks ~20ms ← ACTUAL
    //
    // nrpacks=1 no disponible en este kernel (confirmado: no expone el parámetro).
    // ──────────────────────────────────────────────────────────────────────────
    const captureDevice = this.cfg.captureDevice;   // plughw:1,0 / plughw:Device,0
    const CAPTURE_RATE = 48000;    // tasa nativa del CM108 → sin rate-plugin ALSA
    const CAPTURE_CHANNELS = 1;
    const PERIOD_FRAMES = 960;     // 20ms a 48kHz = 160 muestras a 8kHz tras decimación
    const BUFFER_FRAMES = 48000;   // 1s — necesario para absorber xruns del CM108 en VirtualBox sin crash
    const DECIMATE = 6;            // 48kHz ÷ 6 = 8kHz (para GSM)

    const args = [
      "-D", captureDevice,
      "-f", "S16_LE",
      "-r", String(CAPTURE_RATE),
      "-c", String(CAPTURE_CHANNELS),
      "-q",
      `--period-size=${PERIOD_FRAMES}`,
      `--buffer-size=${BUFFER_FRAMES}`,
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

      if (!this.recorderSuspended && !this.stopping) {
        setTimeout(() => {
          if (!this.recorderSuspended && !this.stopping && this.recorder === null) {
            this.emit("recorder_restarted");
            this.startRecorder();
          }
        }, 2000);
      }
    });

    // Buffer acumulador para decimación entre chunks de pipe (chunk puede partir un frame estéreo)
    let accumBuf = Buffer.alloc(0);

    this.recorder.stdout.on("data", (rawChunk: Buffer) => {
      // Acumular datos hasta tener frames completos alineados a DECIMATE×channels
      accumBuf = Buffer.concat([accumBuf, rawChunk]);

      // Cada frame mono = 1 canal × 2 bytes = 2 bytes
      // Cada grupo de DECIMATE frames = 2 × DECIMATE = 12 bytes → produce 1 muestra mono 8kHz
      const BYTES_PER_STEREO_FRAME = CAPTURE_CHANNELS * 2;
      const BYTES_PER_DECIMATE_GROUP = BYTES_PER_STEREO_FRAME * DECIMATE; // 12 bytes (mono)

      const numOutputSamples = Math.floor(accumBuf.length / BYTES_PER_DECIMATE_GROUP);
      if (numOutputSamples === 0) return;

      const consumedBytes = numOutputSamples * BYTES_PER_DECIMATE_GROUP;

      this.arecordChunkCount++;
      const now = Date.now();
      const gain = this.cfg.inputGain;

      // Diagnóstico primeros 8 chunks: confirmar period=960@48kHz → ~1920 bytes → 160 muestras@8kHz
      if (this.arecordChunkCount <= 8)
        log(`[arecord] chunk#${this.arecordChunkCount}: ${rawChunk.length} bytes brutos → ${numOutputSamples} muestras 8kHz (decimate×${DECIMATE})`);

      const gapMs = this.lastArecordChunkMs > 0 ? now - this.lastArecordChunkMs : 0;
      if (gapMs > 50)
        log(`[arecord] GAP ${gapMs}ms (chunk#${this.arecordChunkCount}, ${numOutputSamples} muestras)`);
      this.lastArecordChunkMs = now;

      // Ganancia + FIR box anti-aliasing + soft-clip
      // FIR box: promedia DECIMATE muestras antes de decimar → evita aliasing.
      // Para DECIMATE=1 (compatibilidad) el bucle interno corre 1 vez = sin overhead.
      const pcm = new Int16Array(numOutputSamples);
      let sumSq = 0;
      const drive = 1.5;
      const BYTES_PER_SAMPLE = CAPTURE_CHANNELS * 2; // 2 bytes mono
      for (let i = 0; i < numOutputSamples; i++) {
        const base = i * BYTES_PER_DECIMATE_GROUP;
        // Promedio de DECIMATE muestras (FIR box)
        let sum = 0;
        for (let d = 0; d < DECIMATE; d++) {
          sum += accumBuf.readInt16LE(base + d * BYTES_PER_SAMPLE);
        }
        const mono = sum / DECIMATE;
        const norm = (mono * gain) / 32768;
        const limited = Math.tanh(norm * drive) / Math.tanh(drive);
        const s = Math.round(limited * 32767);
        pcm[i] = s;
        sumSq += s * s;
        if (Math.abs(s) > 30000) this.levelClipCount++;
      }

      // Conservar bytes no consumidos para el siguiente chunk
      accumBuf = accumBuf.subarray(consumedBytes);

      // Metricas de nivel (se calculan aqui sobre audio crudo, antes del jitter buffer)
      const rms = Math.sqrt(sumSq / numOutputSamples);
      if (rms > this.levelPeakRms) this.levelPeakRms = rms;
      this.levelSamples += numOutputSamples;

      // Encolar en el jitter buffer de captura en lugar de llamar feedPcm directamente.
      // El captureTimer consumira el ring buffer a ritmo constante de 20ms,
      // distribuyendo uniformemente las rafagas periodicas del CM108.
      const merged = new Int16Array(this.captureRingBuf.length + pcm.length);
      merged.set(this.captureRingBuf);
      merged.set(pcm, this.captureRingBuf.length);
      this.captureRingBuf = merged;
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
   * Activa modo RX (reproduccion): aplay ya esta corriendo con silencio.
   * Vuelca el jitter pre-buffer y activa rxActive para que playPcm escriba
   * audio directamente en lugar de seguir acumulando en el jitter buffer.
   * Semi-duplex: mata arecord para evitar realimentacion altavoz→microfono.
   */
  private startPlayer(): void {
    if (this.rxActive) return;
    this.rxActive = true;

    // aplay ya esta corriendo — volcar jitter pre-buffer inmediatamente
    this.stopSilenceInjection();
    if (this.jitterBuf.length > 0 && this.player && !this.player.killed) {
      const buf = Buffer.from(this.jitterBuf.buffer, this.jitterBuf.byteOffset, this.jitterBuf.byteLength);
      try { this.player.stdin.write(buf); } catch { /* ignore */ }
      this.jitterBuf = new Int16Array(0);
    }
    this.startSilenceInjection(); // se callara cuando llegue audio (lastAudioWriteMs)

    // Semi-duplex: matar arecord para evitar que el altavoz se realimente al micro
    if (this.recorder) {
      log("[audio] Semi-duplex: matando arecord — evitar realimentacion altavoz→micro");
      this.recorderSuspended = true;
      this.captureRingBuf = new Int16Array(0);
      const rec = this.recorder;
      this.recorder = null;
      const watchdog = setTimeout(() => {
        try { rec.kill("SIGKILL"); } catch { /* ignore */ }
      }, 800);
      rec.once("close", () => clearTimeout(watchdog));
      try { rec.kill("SIGTERM"); } catch { clearTimeout(watchdog); }
    }
  }

  /**
   * Arranca aplay de forma permanente (al inicio del daemon y tras caidas).
   * aplay lee de su stdin y NUNCA se cierra voluntariamente durante operacion
   * normal. La inyeccion de silencio mantiene el stream USB activo entre RX.
   * Esto evita el ciclo open/close que corrompe el device USB en VirtualBox.
   */
  private startPlayerPermanent(): void {
    if (this.stopping) return;

    const args = [
      "-D", this.cfg.playbackDevice,
      "-f", "S16_LE",
      "-r", "8000",
      "-c", "1",
      "-q",
      "--buffer-size=24000",   // 3s a 8kHz — absorbe jitter del scheduler VirtualBox
      "--period-size=800",    // 100ms por periodo
    ];
    log(`aplay ${args.join(" ")}`);
    this.player = spawn("aplay", args, { stdio: ["pipe", "ignore", "pipe"] });
    const p = this.player;

    // Suppress EPIPE/ERR_STREAM_DESTROYED when aplay dies and we still try to write.
    // Without this Node throws an unhandled 'error' event and crashes the process.
    p.stdin.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EPIPE" || err.code === "ERR_STREAM_DESTROYED") return;
      log(`[aplay] stdin error: ${err.message}`);
    });

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
        this.rxActive = false;
        this.stopSilenceInjection();
        if (!this.stopping) {
          // Reanudar arecord si estaba suspendido
          if (this.recorderSuspended) {
            this.recorderSuspended = false;
            this.emit("playback_ended");
            this.startRecorder();
          }
          // Reiniciar aplay tras breve pausa
          log("[aplay] Caida inesperada — reiniciando en 2s...");
          setTimeout(() => {
            if (!this.stopping && !this.player) this.startPlayerPermanent();
          }, 2000);
        }
      }
    });

    // Inyeccion de silencio inmediata: mantiene el stream USB vivo
    this.startSilenceInjection();
  }

  private stopPlayer(): void {
    if (!this.rxActive && !this.recorderSuspended) return;
    this.rxActive = false;

    // Flush jitter buffer restante a aplay
    if (this.jitterBuf.length > 0 && this.player && !this.player.killed) {
      const buf = Buffer.from(this.jitterBuf.buffer, this.jitterBuf.byteOffset, this.jitterBuf.byteLength);
      try { this.player.stdin.write(buf); } catch { /* ignore */ }
      this.jitterBuf = new Int16Array(0);
    }

    // NO cerramos aplay — sigue vivo con silencio.
    // El ciclo open/close es la causa de la corrupcion USB en VirtualBox.
    this.stopSilenceInjection();
    this.startSilenceInjection();

    // Reanudar arecord (semi-duplex: estaba parado durante la reproduccion)
    if (this.recorderSuspended && !this.stopping) {
      this.recorderSuspended = false;
      this.emit("playback_ended");
      log("[audio] RX terminado — reanudando arecord (aplay sigue activo con silencio)");
      this.startRecorder();
    }
  }

  // ── Inyeccion de silencio ─────────────────────────────────────────────────

  /**
   * Arranca un timer que, si no llega audio real en SILENCE_THRESHOLD_MS ms,
   * escribe silencio en aplay stdin para mantener el buffer DMA lleno.
   * Esto previene los underruns causados por jitter de red o gaps entre
   * transmisiones, que se manifestaban como silencios de hasta 2s audibles.
   */
  private startSilenceInjection(): void {
    this.stopSilenceInjection();
    this.lastAudioWriteMs = Date.now();
    this.silenceTimer = setInterval(() => {
      if (!this.player || this.player.killed) {
        this.stopSilenceInjection();
        return;
      }
      const gap = Date.now() - this.lastAudioWriteMs;
      if (gap >= SILENCE_THRESHOLD_MS) {
        const silence = Buffer.alloc(SILENCE_INJECT_BYTES, 0);
        try {
          this.player.stdin.write(silence);
          this.lastAudioWriteMs = Date.now();
        } catch {
          this.stopSilenceInjection();
        }
      }
    }, 60);
  }

  private stopSilenceInjection(): void {
    if (this.silenceTimer) {
      clearInterval(this.silenceTimer);
      this.silenceTimer = null;
    }
  }

}


function log(msg: string): void { console.log(`[audio] ${new Date().toISOString()} ${msg}`); }
