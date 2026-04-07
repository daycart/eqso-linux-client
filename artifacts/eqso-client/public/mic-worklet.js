/**
 * MicProcessor v19 — AGC + Tanh + Sine Comfort Carrier (8 % FS).
 *
 * ── Signal chain ──────────────────────────────────────────────────────────
 *   input (native rate) → box-filter decimation to 8 kHz
 *   → AGC (adaptive gain, attack 200ms / release 80ms)
 *   → tanh soft clip
 *   → mix comfort carrier (200 Hz, 8 % FS) → clamp ±1.0 → emit
 *
 * ── Why sine carrier, not white noise ────────────────────────────────────
 * GSM 06.10 is a speech vocoder: it models signals as filtered excitation
 * through a vocal-tract LPC filter.  White noise is mapped to the residual
 * with very low energy in the decoded output — the radio VOX sees near
 * silence and does not key up.  A 200 Hz sine is modelled as voiced speech
 * (single LPC pole, periodic excitation) and survives the codec with
 * reasonable energy, keeping the VOX keyed between words.
 *
 * ── Why 8 % FS and not 20 % ──────────────────────────────────────────────
 * At 20 % FS the carrier was audible as a "double beep" artefact on the
 * radio receiver (GSM pitch-doubling artefact on a pure tone).  At 8 % the
 * decoded level is below typical background noise on an FM channel and is
 * not objectionable, while still exceeding the VOX threshold of most radio
 * link nodes (~3–5 % FS RMS).
 *
 * ── Why tanh and not hard clip ────────────────────────────────────────────
 * Hard clip creates rectangular peaks (many harmonics) that GSM decodes as
 * broadband noise.  Tanh smoothly compresses peaks so the output remains
 * speech-like and is decoded cleanly.
 *
 * ── AGC ──────────────────────────────────────────────────────────────────
 * Attack: 200 ms · Release: 80 ms · Target RMS: 0.30 · Max gain: 80
 *
 * ── Warmup ────────────────────────────────────────────────────────────────
 * First 80 ms discarded to absorb hardware startup pop/click.
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

    // ── AGC state ─────────────────────────────────────────────────────────
    const blockMs = (128 / nativeRate) * 1000;
    this._agcGain    = 4.0;
    this._agcTarget  = 0.30;
    this._agcMaxGain = 80.0;
    this._agcMinGain = 0.3;
    this._agcAttack  = Math.exp(-blockMs / 200);   // 200 ms attack
    this._agcRelease = Math.exp(-blockMs / 80);    // 80 ms release
    this._rmsEst     = 0.01;

    // ── Comfort carrier: 200 Hz sine at 8 % FS ────────────────────────────
    // Sine survives GSM 06.10 codec (modelled as voiced speech) and keeps
    // the radio VOX keyed between words.  8 % FS is inaudible under speech
    // and does not cause objectionable tonal artefacts at the receiver.
    this._carrierPhase = 0;
    this._carrierStep  = (2 * Math.PI * 200) / targetRate;
    this._carrierAmp   = 0.08;                     // 8 % FS (−22 dBFS)

    // ── Level logging ─────────────────────────────────────────────────────
    this._logEvery  = Math.round(nativeRate / 128);
    this._logCount  = 0;
    this._logPeak   = 0;
    this._logRmsAcc = 0;
    this._logRmsCnt = 0;

    this.port.onmessage = (ev) => {
      if (ev.data?.type === 'emit') {
        if (ev.data.emitting) {
          this._carry        = new Float32Array(0);
          this._accum        = new Float32Array(0);
          this._rmsEst       = 0.01;
          this._agcGain      = 4.0;
          this._carrierPhase = 0;
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

    // ── Warmup: discard first 80 ms ───────────────────────────────────────
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

    // ── Step 1: Box-filter downsample to 8 kHz ────────────────────────────
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

    // ── Step 2: AGC ───────────────────────────────────────────────────────
    let sumSq = 0;
    for (let i = 0; i < outLen; i++) sumSq += ds[i] * ds[i];
    const blockRms = outLen > 0 ? Math.sqrt(sumSq / outLen) : 0;

    this._rmsEst = this._rmsEst * this._agcRelease + blockRms * (1 - this._agcRelease);
    if (this._rmsEst < 1e-7) this._rmsEst = 1e-7;

    const neededGain = this._agcTarget / this._rmsEst;
    if (neededGain < this._agcGain) {
      this._agcGain = this._agcGain * this._agcRelease + neededGain * (1 - this._agcRelease);
    } else {
      this._agcGain = this._agcGain * this._agcAttack + neededGain * (1 - this._agcAttack);
    }
    this._agcGain = Math.max(this._agcMinGain, Math.min(this._agcMaxGain, this._agcGain));

    // ── Step 3: Apply AGC + tanh soft clip ────────────────────────────────
    const g = this._agcGain;
    for (let i = 0; i < outLen; i++) {
      ds[i] = Math.tanh(g * ds[i]);
    }

    // ── Step 4: Mix comfort carrier (200 Hz, 8 % FS) ─────────────────────
    const amp  = this._carrierAmp;
    const step = this._carrierStep;
    let   phi  = this._carrierPhase;
    for (let i = 0; i < outLen; i++) {
      ds[i] += amp * Math.sin(phi);
      phi   += step;
      if (phi > 2 * Math.PI) phi -= 2 * Math.PI;
    }
    this._carrierPhase = phi;

    // ── Step 5: Clamp to ±1.0 ─────────────────────────────────────────────
    for (let i = 0; i < outLen; i++) {
      if      (ds[i] >  1) ds[i] =  1;
      else if (ds[i] < -1) ds[i] = -1;
    }

    // ── Level log (once per second) ───────────────────────────────────────
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

    // ── Accumulate and emit ───────────────────────────────────────────────
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

registerProcessor('mic-processor-v8', MicProcessor);
