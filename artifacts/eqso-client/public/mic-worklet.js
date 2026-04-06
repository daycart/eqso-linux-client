/**
 * MicProcessor v9 — AGC + Comfort Carrier Tone.
 *
 * ── Signal chain ──────────────────────────────────────────────────────────
 *   input (8 kHz — AudioContext created at GSM_RATE, browser resamples mic
 *   natively from 48 kHz using its polyphase anti-aliasing filter)
 *   → identity pass-through (iRatio=1, box-filter is a no-op copy)
 *   → AGC (adaptive gain, attack 200ms / release 80ms)
 *   → tanh soft clip
 *   → mix comfort carrier (200 Hz, 4 % FS) → emit
 *
 * ── Why a comfort carrier ────────────────────────────────────────────────
 * Inter-word pauses (100–400 ms) cause the radio VOX to release even though
 * PTT is still held.  A pure 200 Hz sine at 4 % FS keeps the VOX keyed
 * without audible noise because GSM 06.10 LPC models a pure tone as a single
 * resonance pole with near-zero residual excitation.  The decoded output is
 * a barely-audible 200 Hz hum — not wideband noise.
 *
 * 4 % FS (−28 dBFS) is inaudible under speech (which is typically −12 dBFS)
 * and just above the VOX threshold of most radio links (~3 % FS RMS).
 *
 * ── AGC ──────────────────────────────────────────────────────────────────
 * Attack: 200 ms (fast enough to fill inter-word gaps)
 * Release: 80 ms (quick gain reduction on loud input to prevent clipping)
 * Target RMS: 0.22 (22 % FS) — well above typical VOX thresholds
 * Max gain: 80   — amplifies very quiet mics sufficiently
 * Min gain: 0.3  — attenuates very hot mics
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
    this._agcTarget  = 0.22;
    this._agcMaxGain = 80.0;
    this._agcMinGain = 0.3;
    this._agcAttack  = Math.exp(-blockMs / 200);   // 200 ms attack
    this._agcRelease = Math.exp(-blockMs / 80);    // 80 ms release
    this._rmsEst     = 0.01;

    // ── Comfort carrier: 200 Hz sine at 4 % FS ────────────────────────────
    // Keeps radio VOX keyed during inter-word pauses without creating noise.
    // A pure sine is the ideal GSM LPC input (single pole, zero residual).
    this._carrierPhase = 0;
    this._carrierFreq  = 200;        // Hz
    this._carrierAmp   = 0.04;       // 4 % FS (−28 dBFS)
    this._carrierStep  = (2 * Math.PI * this._carrierFreq) / targetRate;

    // ── Level logging ─────────────────────────────────────────────────────
    this._logEvery  = Math.round(nativeRate / 128);
    this._logCount  = 0;
    this._logPeak   = 0;
    this._logRmsAcc = 0;
    this._logRmsCnt = 0;

    this.port.onmessage = (ev) => {
      if (ev.data?.type === 'emit') {
        if (ev.data.emitting) {
          this._carry = new Float32Array(0);
          this._accum = new Float32Array(0);
          this._rmsEst = 0.01;
          this._agcGain = 4.0;
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

    // ── Step 4: Mix comfort carrier (200 Hz, 4 % FS) ─────────────────────
    // Added after tanh so it is never clipped.  Its amplitude (0.04) is
    // below typical speech (-12 dBFS average) but above VOX threshold.
    const amp  = this._carrierAmp;
    const step = this._carrierStep;
    let   phi  = this._carrierPhase;
    for (let i = 0; i < outLen; i++) {
      ds[i] += amp * Math.sin(phi);
      phi   += step;
      if (phi > 2 * Math.PI) phi -= 2 * Math.PI;
    }
    this._carrierPhase = phi;

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

registerProcessor('mic-processor-v9', MicProcessor);
