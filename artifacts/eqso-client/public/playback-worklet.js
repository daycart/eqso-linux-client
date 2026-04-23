/**
 * PlaybackProcessor — AudioWorklet para reproduccion de audio GSM decodificado.
 *
 * Maquina de estados: IDLE → FILL → PLAY → IDLE
 *
 * IDLE   : sin actividad, esperando inicio de transmision.
 * FILL   : acumulando FILL_THRESHOLD muestras antes de empezar a reproducir
 *           (pre-fill al comienzo de cada transmision).
 * PLAY   : reproduciendo del buffer circular. Un underrun (buffer vacio) produce
 *           silencio PROPORCIONAL al gap real, NO vuelve a modo FILL.
 *           Tras IDLE_TIMEOUT_FRAMES de silencio continuo, regresa a IDLE para
 *           detectar el inicio de la siguiente transmision.
 *
 * Por que este diseno:
 *   - El worklet anterior (starved flag) re-entraba en modo FILL en cada underrun.
 *     Gap de 350ms → 350ms de silencio + 300ms de re-fill = 650ms total. Peor que
 *     el scheduler original con 500ms de jitter buffer.
 *   - Con la nueva maquina de estados: gap de 350ms → 350ms de silencio → reanuda
 *     inmediatamente cuando llega el siguiente paquete. El pre-fill solo se aplica
 *     una vez al comienzo de cada transmision.
 *   - IDLE_TIMEOUT_FRAMES de silencio (≈1.5s) distingue "fin de transmision" de
 *     "jitter mid-TX". Si el gap es < 1.5s, el modo PLAY se mantiene y el proximo
 *     paquete se reproduce sin overhead. Si el gap es > 1.5s, volvemos a IDLE para
 *     aplicar el pre-fill correctamente en la siguiente transmision.
 */

const BUFFER_CAPACITY  = 8000;   // 1s a 8kHz: capacidad maxima circular
const SRC_RATE         = 8000;   // tasa de muestras entrantes (GSM 06.10)
const FILL_THRESHOLD   = 2400;   // 300ms a 8kHz: pre-fill al inicio de TX
const MAX_BUFFER       = 4800;   // 600ms: limite anti-acumulacion (descarta entrantes si excede)

// Timeout de silencio continuo para regresar a IDLE.
// A 48000 Hz, cada process() call = 128 muestras = ~2.67ms.
// 1500ms / 2.67ms ≈ 562 frames. Usamos 560.
// A 44100 Hz: 560 × 128/44100 ≈ 1624ms. Suficiente.
const IDLE_TIMEOUT_FRAMES = 560; // ~1.5s de silencio continuo

class PlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf          = new Float32Array(BUFFER_CAPACITY);
    this._writeIdx     = 0;
    this._readIdx      = 0;
    this._available    = 0;
    this._readFrac     = 0.0;
    this._state        = "idle";   // "idle" | "fill" | "play"
    this._silentFrames = 0;        // frames consecutivos con underrun en modo play

    this.port.onmessage = ({ data }) => {
      if (data.type !== "push") return;
      const samples = new Float32Array(data.buffer);
      for (let i = 0; i < samples.length; i++) {
        if (this._available < MAX_BUFFER) {
          this._buf[this._writeIdx] = samples[i];
          this._writeIdx = (this._writeIdx + 1) % BUFFER_CAPACITY;
          this._available++;
        }
        // Si el buffer supera MAX_BUFFER: descartar para evitar latencia creciente
      }

      // Transicion de estado al recibir datos
      if (this._state === "idle") {
        this._state = "fill";
      }
      // En modo play: resetear contador de silencio (ha llegado audio nuevo)
      this._silentFrames = 0;
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0]?.[0];
    if (!out) return true;

    // ── IDLE: sin transmision activa ──────────────────────────────────────────
    if (this._state === "idle") {
      out.fill(0);
      return true;
    }

    // ── FILL: acumulando pre-fill inicial ─────────────────────────────────────
    if (this._state === "fill") {
      if (this._available < FILL_THRESHOLD) {
        out.fill(0);
        return true;
      }
      // Pre-fill completo → empezar a reproducir
      this._state = "play";
    }

    // ── PLAY: reproducir del buffer, silencio proporcional en underrun ────────
    const step = SRC_RATE / sampleRate; // muestras 8kHz por muestra nativa
    let underrun = false;

    for (let i = 0; i < out.length; i++) {
      if (this._available <= 1) {
        // Buffer vacio: silencio. No volver a FILL; reanudar en cuanto lleguen datos.
        for (let j = i; j < out.length; j++) out[j] = 0;
        underrun = true;
        break;
      }

      // Interpolacion lineal entre muestra actual y siguiente
      const i0 = this._readIdx;
      const i1 = (this._readIdx + 1) % BUFFER_CAPACITY;
      out[i] = this._buf[i0] + (this._buf[i1] - this._buf[i0]) * this._readFrac;

      this._readFrac += step;
      while (this._readFrac >= 1.0) {
        this._readFrac -= 1.0;
        this._readIdx = (this._readIdx + 1) % BUFFER_CAPACITY;
        if (this._available > 0) this._available--;
      }
    }

    if (underrun) {
      this._silentFrames++;
      // Si llevamos ~1.5s de silencio continuo: fin de transmision → volver a IDLE
      if (this._silentFrames >= IDLE_TIMEOUT_FRAMES) {
        this._state = "idle";
        this._silentFrames = 0;
        this._available = 0;
        this._writeIdx = 0;
        this._readIdx = 0;
        this._readFrac = 0.0;
      }
    } else {
      this._silentFrames = 0;
    }

    return true;
  }
}

registerProcessor("playback-processor-v1", PlaybackProcessor);
