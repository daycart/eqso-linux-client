/**
 * MicProcessor v18 — AGC + Tanh + Comfort Noise.
 *
 * ── Signal chain ──────────────────────────────────────────────────────────
 *   input (native rate) → box-filter decimation to 8 kHz
 *   → AGC (adaptive gain, attack 200ms / release 80ms)
 *   → tanh soft clip
 *   → mix comfort noise (white, 15 % RMS) → clamp ±1.0 → emit
 *
 * ── Why comfort noise instead of a carrier tone ──────────────────────────
 * A pure 200 Hz sine encodes badly through GSM 06.10: the vocoder models it
 * as a pitch-periodic signal and produces audible artifacts (double beep).
 * White noise at low level encodes as broadband background — the radio sounds
 * like normal "air" (carrier up, no modulation), which is natural and
 * expected on FM radio links.  15 % RMS keeps the radio VOX keyed during
 * inter-word pauses without any audible tonal artifact.
 *
 * ── Why tanh instead of hard clip ────────────────────────────────────────
 * Hard clip (brick-wall limiting) creates rectangular wave tops, which GSM
 * decodes as broadband noise.  Tanh smoothly compresses peaks so the output
 * waveform remains speech-like — GSM encodes and decodes it cleanly.
 *
 * ── AGC ──────────────────────────────────────────────────────────────────
 * Attack: 200 ms (fast enough to fill inter-word gaps)
 * Release: 80 ms (quick gain reduction on loud input)
 * Target RMS: 0.30 (30 % FS) — louder than v17 for better speech levels
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
    this._agcTarget  = 0.30;
    this._agcMaxGain = 80.0;
    this._agcMinGain = 0.3;
    this._agcAttack  = Math.exp(-blockMs / 200);   // 200 ms attack
    this._agcRelease = Math.exp(-blockMs / 80);    // 80 ms release
    this._rmsEst     = 0.01;

    // ── Comfort noise amplitude ────────────────────────────────────────────
    // Uniform distribution U(-A, A) has RMS = A / sqrt(3).
    // For RMS = 0.15: A = 0.15 * sqrt(3) ≈ 0.260.
    this._noiseAmp = 0.15 * Math.sqrt(3);          // ~0.260 peak

    // ── Level logging ─────────────────────────────────────────────────────
    this._logEvery  = Math.round(nativeRate / 128);
    this._logCount  = 0;
    this._logPeak   = 0;
    this._logRmsAcc = 0;
    this._logRmsCnt = 0;

    this.port.onmessage = (ev) => {
      if (ev.data?.type === 'emit') {
        if (ev.data.emitting) {
          this._carry   = new Float32Array(0);
          this._accum   = new Float32Array(0);
          this._rmsEst  = 0.01;
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

    // ── Step 4: Add comfort noise (white, 15 % RMS) ───────────────────────
    // White noise encodes through GSM as broadband background — sounds like
    // normal radio "air" on the receiving end.  Keeps radio VOX keyed during
    // inter-word pauses without any tonal artifact.
    const na = this._noiseAmp;
    for (let i = 0; i < outLen; i++) {
      ds[i] += (Math.random() - 0.5) * 2 * na;
    }

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
