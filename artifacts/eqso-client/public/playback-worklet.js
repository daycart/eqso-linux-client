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

const BUFFER_SAMPLES = 24000;   // capacidad: 3s a 8kHz
const SRC_RATE       = 8000;    // tasa de las muestras entrantes (GSM 06.10)

// Pre-fill: esperar esta cantidad de muestras antes de empezar a reproducir.
// Con 8000 muestras (1s a 8kHz) el buffer puede absorber hasta 1s de jitter
// sin llegar a cero (silencio). El inicio de cada transmision tiene ~1s de latencia.
const PRE_FILL_SAMPLES = 8000;

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
        if (this._available < BUFFER_SAMPLES) {
          this._buf[this._writeIdx] = samples[i];
          this._writeIdx = (this._writeIdx + 1) % BUFFER_SAMPLES;
          this._available++;
        }
        // buffer lleno: descartar (prefiere silencio a acumulacion ilimitada)
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
