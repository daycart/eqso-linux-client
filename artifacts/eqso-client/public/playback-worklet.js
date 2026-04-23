/**
 * PlaybackProcessor — AudioWorklet para reproducción de audio GSM decodificado.
 *
 * Mantiene un buffer circular de muestras Float32 a 8kHz.
 * El proceso de reproducción lee del buffer a la tasa nativa del AudioContext
 * (normalmente 48kHz) usando interpolación lineal para upsamplear de 8kHz a nativo.
 *
 * Ventaja frente al scheduler (createBufferSource + source.start()):
 *  - Sin "resets" del scheduler: el jitter solo drena el buffer, no causa silencio
 *    salvo que el buffer llegue a cero.
 *  - Pre-fill configurable: con 1 segundo de pre-fill, absorbe hasta 1s de jitter
 *    de red/event-loop sin silencio audible.
 *  - Inmune a pausas del event loop JS: el AudioWorklet corre en un hilo separado
 *    de alta prioridad (audio thread), independiente del main thread.
 */

const BUFFER_SAMPLES = 8000;    // capacidad: 1s a 8kHz
const SRC_RATE       = 8000;    // tasa de las muestras entrantes (GSM 06.10)

// Pre-fill: esperar esta cantidad de muestras antes de empezar a reproducir.
// 2400 muestras = 300ms a 8kHz. Absorbe jitter de hasta ~300ms sin silencio.
// Valor pequeño para minimizar latencia; el buffer protege contra fluctuaciones
// puntuales pero no acumula audio indefinidamente (no hay "cola creciente").
const PRE_FILL_SAMPLES = 2400;

// Limite maximo de buffer. Si hay mas de este numero de muestras acumuladas,
// descartar las nuevas entrantes para evitar que la latencia crezca sin limite.
// 4800 = 600ms: cubre rafagas de 3-4 paquetes seguidos del servidor.
const MAX_BUFFER_SAMPLES = 4800;

class PlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf       = new Float32Array(BUFFER_SAMPLES);
    this._writeIdx  = 0;
    this._readIdx   = 0;
    this._available = 0;   // muestras 8kHz disponibles en el buffer
    this._readFrac  = 0.0; // posicion fraccionaria para interpolacion
    this._starved   = true; // true = esperando pre-fill, output silence

    this.port.onmessage = ({ data }) => {
      if (data.type !== "push") return;
      const samples = new Float32Array(data.buffer);
      for (let i = 0; i < samples.length; i++) {
        if (this._available < MAX_BUFFER_SAMPLES) {
          // Solo aceptar si no hemos superado el maximo (anti-acumulacion).
          // Descartar el resto para que la latencia no crezca indefinidamente.
          this._buf[this._writeIdx] = samples[i];
          this._writeIdx = (this._writeIdx + 1) % BUFFER_SAMPLES;
          this._available++;
        }
      }
      // Salir del modo starved cuando tenemos suficiente pre-fill
      if (this._starved && this._available >= PRE_FILL_SAMPLES) {
        this._starved = false;
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0]?.[0];
    if (!out) return true;

    if (this._starved) {
      // Esperando pre-fill: silencio
      out.fill(0);
      return true;
    }

    // Ratio: cuantas muestras 8kHz consumir por muestra nativa
    const step = SRC_RATE / sampleRate;

    for (let i = 0; i < out.length; i++) {
      if (this._available <= 1) {
        // Underrun: volver a modo starved para re-hacer pre-fill
        out[i] = 0;
        this._starved = true;
        // Rellenar el resto con silencio
        for (let j = i + 1; j < out.length; j++) out[j] = 0;
        break;
      }

      // Interpolacion lineal entre muestra actual y siguiente
      const i0 = this._readIdx;
      const i1 = (this._readIdx + 1) % BUFFER_SAMPLES;
      out[i] = this._buf[i0] + (this._buf[i1] - this._buf[i0]) * this._readFrac;

      // Avanzar posicion fraccionaria
      this._readFrac += step;
      while (this._readFrac >= 1.0) {
        this._readFrac -= 1.0;
        this._readIdx = (this._readIdx + 1) % BUFFER_SAMPLES;
        if (this._available > 0) this._available--;
      }
    }

    return true;
  }
}

registerProcessor("playback-processor-v1", PlaybackProcessor);
