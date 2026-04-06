/**
 * MicProcessor v12 — AGC sin portadora de confort, maxGain restaurado a 80.
 *
 * ── Diagnóstico ───────────────────────────────────────────────────────────
 * El micrófono del usuario produce ~0.003 RMS FS (muy silencioso).
 * Con maxGain=12 (v11), la salida era solo 3-4% FS — insuficiente para
 * mantener el VOX del enlace radio de ASORAPA activo.
 * Con maxGain=80 (v10), el gain llegaba a 58-67 y el tanh saturaba, pero
 * el PROBLEMA REAL era la portadora de 200 Hz: portadora(8%) + tanh(~96%)
 * superaba 1.0 → hard clip → distorsión de cuadrado → GSM = ruido.
 *
 * ── Solución v12 ─────────────────────────────────────────────────────────
 * maxGain=80, SIN portadora. tanh nunca puede superar ±1.0 (asíntota),
 * así que es IMPOSIBLE el hard clip independientemente del gain aplicado.
 * El VOX del enlace radio recibirá señal de 15-25% RMS FS → se mantiene
 * activo durante toda la transmisión.
 *
 * ── AGC ──────────────────────────────────────────────────────────────────
 * Attack:   10 ms — muy rápido: baja el gain en un frame cuando llega voz
 * Release: 300 ms — sube lento para no dispararse en pausas entre palabras
 * Target:  0.22 RMS (22% FS) — nivel óptimo para VOX y claridad de voz
 * Max gain:  80  — necesario para micrófonos silenciosos (RMS ~ 0.003 FS)
 * Min gain: 0.3  — atenúa micrófonos muy calientes
 *
 * ── Warmup ────────────────────────────────────────────────────────────────
 * Los primeros 80 ms se descartan para absorber el pop/click de inicio.
 */
class MicProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const {
      nativeRate,
      targetRate,
      chunkSamples,
      warmupBlocks,
    } = options.processorOptions;

    this._iRatio        = Math.round(nativeRate / targetRate);
    this._chunkSamples  = chunkSamples;
    this._warmupBlocks  = warmupBlocks;
    this._blockCount    = 0;
    this._emitting      = false;
    this._warmupDone    = false;
    this._carry         = new Float32Array(0);
    this._accum         = new Float32Array(0);
    this._pendingEmit   = null;

    // ── AGC parameters ────────────────────────────────────────────────────
    // blockMs: duration in ms of each AudioWorklet block (128 samples / nativeRate)
    const blockMs        = (128 / nativeRate) * 1000;
    this._agcGain    = 4.0;
    this._agcTarget  = 0.22;
    this._agcMaxGain = 80.0;
    this._agcMinGain = 0.3;
    this._agcAttack  = Math.exp(-blockMs / 10);    // 10 ms attack  (muy rapido — evita saturacion en primeros frames)
    this._agcRelease = Math.exp(-blockMs / 300);   // 300 ms release — sube lentamente para no amplificar pausa->voz
    this._rmsEst     = 0.01;

    // ── Level logging ─────────────────────────────────────────────────────
    this._logEvery  = Math.round(nativeRate / 128);
    this._logCount  = 0;
    this._logPeak   = 0;
    this._logRmsAcc = 0;
    this._logRmsCnt = 0;

    this.port.onmessage = (ev) => {
      if (ev.data?.type === 'emit') {
        if (ev.data.emitting) {
          this._carry  = new Float32Array(0);
          this._accum  = new Float32Array(0);
          this._rmsEst = 0.01;
          this._agcGain = 4.0;
        }
        if (this._warmupDone) {
          this._emitting = ev.data.emitting;
        } else {
          this._pendingEmit = ev.data.emitting;
        }
      }
    };
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input || input.length === 0) return true;

    this._blockCount++;

    // ── Warmup: descartar primeros 80 ms ──────────────────────────────────
    if (this._blockCount <= this._warmupBlocks) {
      if (this._blockCount === this._warmupBlocks) {
        this._warmupDone = true;
        if (this._pendingEmit !== null) {
          this._emitting = this._pendingEmit;
          this._pendingEmit = null;
        }
        this.port.postMessage({ type: 'ready' });
      }
      return true;
    }

    // ── Step 1: Box-filter downsample a 8 kHz ─────────────────────────────
    // Con AudioContext a 8 kHz, iRatio=1 → pass-through, sin decimación.
    const iRatio   = this._iRatio;
    const combined = new Float32Array(this._carry.length + input.length);
    combined.set(this._carry);
    combined.set(input, this._carry.length);

    const outLen = Math.floor(combined.length / iRatio);
    const ds     = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      let sum = 0;
      const start = i * iRatio;
      for (let j = start; j < start + iRatio; j++) sum += combined[j];
      ds[i] = sum / iRatio;
    }
    this._carry = combined.slice(outLen * iRatio);

    // ── Step 2: AGC — estimar RMS del bloque ─────────────────────────────
    let sumSq = 0;
    for (let i = 0; i < outLen; i++) sumSq += ds[i] * ds[i];
    const blockRms = outLen > 0 ? Math.sqrt(sumSq / outLen) : 0;

    this._rmsEst = this._rmsEst * this._agcRelease + blockRms * (1 - this._agcRelease);
    if (this._rmsEst < 1e-7) this._rmsEst = 1e-7;

    const neededGain = this._agcTarget / this._rmsEst;
    if (neededGain < this._agcGain) {
      // Señal más fuerte → bajar gain rápido (attack)
      this._agcGain = this._agcGain * this._agcAttack + neededGain * (1 - this._agcAttack);
    } else {
      // Señal más débil → subir gain lento (release)
      this._agcGain = this._agcGain * this._agcRelease + neededGain * (1 - this._agcRelease);
    }
    this._agcGain = Math.max(this._agcMinGain, Math.min(this._agcMaxGain, this._agcGain));

    // ── Step 3: Aplicar AGC + tanh soft clip ─────────────────────────────
    // Con maxGain=12, tanh nunca produce hard-clip (tanh(12*1.0) = 0.9999).
    // Sin portadora, el output siempre está en (-1.0, 1.0) — nunca se satura.
    const g = this._agcGain;
    for (let i = 0; i < outLen; i++) {
      ds[i] = Math.tanh(g * ds[i]);
    }

    // ── Step 4: Log de nivel (una vez por segundo) ───────────────────────
    if (this._emitting) {
      for (let i = 0; i < outLen; i++) {
        const a = Math.abs(ds[i]);
        if (a > this._logPeak) this._logPeak = a;
        this._logRmsAcc += ds[i] * ds[i];
        this._logRmsCnt++;
      }
      this._logCount++;
      if (this._logCount >= this._logEvery) {
        this.port.postMessage({
          type: 'level',
          rms:  Math.sqrt(this._logRmsAcc / Math.max(1, this._logRmsCnt)),
          peak: this._logPeak,
          gain: this._agcGain,
        });
        this._logCount  = 0;
        this._logPeak   = 0;
        this._logRmsAcc = 0;
        this._logRmsCnt = 0;
      }
    }

    if (!this._emitting) return true;

    // ── Step 5: Acumular y emitir chunks de chunkSamples (Float32) ───────
    // useAudio.ts convierte Float32 → Int16 antes de enviar por WS.
    const merged = new Float32Array(this._accum.length + outLen);
    merged.set(this._accum);
    merged.set(ds, this._accum.length);
    this._accum = merged;

    while (this._accum.length >= this._chunkSamples) {
      const chunk = this._accum.slice(0, this._chunkSamples);
      this._accum = this._accum.slice(this._chunkSamples);
      this.port.postMessage({ type: 'chunk', data: chunk }, [chunk.buffer]);
    }

    return true;
  }
}

registerProcessor('mic-processor-v12', MicProcessor);
