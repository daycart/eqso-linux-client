/**
 * MicProcessor v14 — AGC + portadora 200 Hz al 5% con clamp a ±1.0.
 *
 * ── Diagnóstico ───────────────────────────────────────────────────────────
 * El micrófono del usuario produce ~0.003 RMS FS (muy silencioso).
 * maxGain=80 amplifica la voz hasta 15-25% RMS FS.
 *
 * ── Por qué la portadora es necesaria ─────────────────────────────────────
 * Sin portadora (v12/v13), durante los silencios entre palabras el nivel de
 * salida cae a ~2-5% FS — por debajo del umbral VOX de ASORAPA — y el
 * transmisor de radio se desactiva. La portadora mantiene un nivel mínimo de
 * señal (~5% FS) en todo momento para que el VOX no se suelte.
 *
 * ── Por qué la portadora causaba ruido en v10 ─────────────────────────────
 * En v10: `ds[i] = Math.tanh(g * ds[i]) + 0.08 * sin(...)`.
 * Con tanh saturado a ~0.97, sumando 0.08 = 1.05 → EXCEDE ±1.0 → hard clip
 * → onda cuadrada → GSM codifica artefactos → ruido audible.
 *
 * ── Solución v14 ──────────────────────────────────────────────────────────
 * `ds[i] = clamp(Math.tanh(g * ds[i]) + 0.05 * sin(...), -1.0, 1.0)`.
 * El clamp garantiza que el total nunca excede ±1.0. La portadora al 5%
 * mantiene el VOX durante silencios. La voz no distorsiona porque el tanh
 * peak típico es 0.85-0.95 → suma 0.05 = 0.90-1.00 → dentro del rango.
 *
 * ── AGC ──────────────────────────────────────────────────────────────────
 * Attack:   10 ms  — baja el gain rápido cuando llega voz fuerte
 * Release: 300 ms  — sube lento para no amplificar pausa->voz
 * Target:  0.22 RMS (22% FS)
 * Max gain:  80    — necesario para micrófonos muy silenciosos (~0.003 RMS)
 * Min gain: 0.3    — atenúa micrófonos muy calientes
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
    const blockMs        = (128 / nativeRate) * 1000;
    this._agcTarget  = 0.22;
    this._agcMaxGain = 80.0;
    this._agcMinGain = 0.3;
    this._agcAttack  = Math.exp(-blockMs / 10);
    this._agcRelease = Math.exp(-blockMs / 300);
    // Arrancar con gain máximo para que el primer frame ya tenga nivel suficiente
    this._agcGain = this._agcMaxGain;
    this._rmsEst  = this._agcTarget / this._agcMaxGain; // = 0.00275

    // ── Carrier 200 Hz ───────────────────────────────────────────────────
    // Mantiene el VOX de ASORAPA activo durante los silencios entre palabras.
    // Amplitud 8% (0.08) — igual que v8 (versión que funcionaba). Con el clamp
    // a ±1.0, la distorsión ocurre SOLO si voz_peak + carrier > 1.0 (en los
    // picos más altos), y queda truncada suavemente — no cuadra onda completa.
    this._carrierAmp   = 0.08;
    this._carrierFreq  = 200; // Hz
    this._carrierPhase = 0;
    this._carrierStep  = (2 * Math.PI * this._carrierFreq) / (nativeRate / this._iRatio);

    // ── Level logging ─────────────────────────────────────────────────────
    this._logEvery  = Math.round(nativeRate / 128);
    this._logCount  = 0;
    this._logPeak   = 0;
    this._logRmsAcc = 0;
    this._logRmsCnt = 0;

    this.port.onmessage = (ev) => {
      if (ev.data?.type === 'emit') {
        if (ev.data.emitting) {
          // Solo limpiar buffers — NO resetear gain ni rmsEst.
          // El AGC mantiene gain=80 durante el silencio pre-PTT; resetearlo
          // causaría 640ms de audio silencioso al inicio de cada TX.
          this._carry = new Float32Array(0);
          this._accum = new Float32Array(0);
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
      this._agcGain = this._agcGain * this._agcAttack + neededGain * (1 - this._agcAttack);
    } else {
      this._agcGain = this._agcGain * this._agcRelease + neededGain * (1 - this._agcRelease);
    }
    this._agcGain = Math.max(this._agcMinGain, Math.min(this._agcMaxGain, this._agcGain));

    // ── Step 3: AGC + tanh + portadora + clamp a ±1.0 ───────────────────
    // Orden de operaciones:
    //   1. tanh(gain × muestra) → soft-clip, rango (-1, 1)
    //   2. + portadora 200 Hz 5% → puede exceder ±1.0 levemente
    //   3. clamp a [-1.0, 1.0]  → evita hard-clip que genera distorsión
    const g    = this._agcGain;
    const amp  = this._carrierAmp;
    const step = this._carrierStep;
    let phase  = this._carrierPhase;
    for (let i = 0; i < outLen; i++) {
      const v = Math.tanh(g * ds[i]) + amp * Math.sin(phase);
      ds[i]   = v > 1.0 ? 1.0 : v < -1.0 ? -1.0 : v;
      phase  += step;
      if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
    }
    this._carrierPhase = phase;

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

registerProcessor('mic-processor-v15', MicProcessor);
