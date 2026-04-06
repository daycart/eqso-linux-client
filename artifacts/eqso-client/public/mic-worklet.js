/**
 * MicProcessor v7 — AudioWorkletProcessor with Automatic Gain Control (AGC).
 *
 * ── Signal chain ──────────────────────────────────────────────────────────
 *   input (native rate) → box-filter decimation to 8 kHz
 *   → AGC (adaptive gain, attack 800ms / release 80ms)
 *   → soft clip at tanh
 *   → accumulate chunks → emit (when emitting=true)
 *
 * ── Why AGC ───────────────────────────────────────────────────────────────
 * Fixed gain fails because microphone sensitivity varies enormously between
 * users and devices (factor of 30× observed in tests):
 *   - gain=2  → rms8k=0.012 → too quiet for radio VOX (threshold ~5%)
 *   - gain=6  → rms8k=0.37  → hard clipping → square wave → GSM noise
 * AGC keeps output RMS at a target level regardless of mic sensitivity.
 * tanh prevents hard clipping even if AGC momentarily overshoots.
 *
 * ── AGC parameters ────────────────────────────────────────────────────────
 * Target RMS output: 0.22 (22% FS) — well above typical VOX thresholds
 * Attack:  800 ms — slow gain increase avoids amplifying breath/pops
 * Release: 80  ms — fast gain decrease protects against clipping on loud input
 * Max gain: 80  — for very quiet mics (0.003 FS raw → 0.22 FS output)
 * Min gain: 0.3 — for very loud mics (headset close to mouth)
 *
 * ── Warmup ────────────────────────────────────────────────────────────────
 * The first 80 ms of mic audio is discarded to absorb the hardware startup
 * pop/click.  After warmup the worklet posts { type: 'ready' }.
 *
 * ── Carry buffer ─────────────────────────────────────────────────────────
 * 128 mod 6 = 2 samples would be discarded per block without this buffer,
 * creating a 375 Hz phase discontinuity at 48 kHz.
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
    // Process() runs every 128/nativeRate seconds (≈2.67 ms at 48 kHz).
    // Time constants are expressed as per-block exponential decay coefficients.
    const blockMs = (128 / nativeRate) * 1000;
    this._agcGain    = 4.0;                             // start at moderate gain
    this._agcTarget  = 0.22;                            // target RMS output level
    this._agcMaxGain = 80.0;
    this._agcMinGain = 0.3;
    this._agcAttack  = Math.exp(-blockMs / 800);        // 800 ms attack
    this._agcRelease = Math.exp(-blockMs / 80);         // 80 ms release
    this._rmsEst     = 0.01;                            // running RMS estimate

    // Level logging: once per second
    this._logEvery  = Math.round(nativeRate / 128);
    this._logCount  = 0;
    this._logPeak   = 0;
    this._logRmsAcc = 0;
    this._logRmsCnt = 0;

    this.port.onmessage = (ev) => {
      if (ev.data?.type === 'emit') {
        if (ev.data.emitting) {
          // Flush stale audio accumulated while PTT was off
          this._carry = new Float32Array(0);
          this._accum = new Float32Array(0);
          // Reset RMS estimate so AGC starts fresh each PTT press
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

    // ── Warmup: discard first 80 ms (mic startup pop) ─────────────────────
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

    // ── Step 2: AGC — measure block RMS and adjust gain ───────────────────
    let sumSq = 0;
    for (let i = 0; i < outLen; i++) sumSq += ds[i] * ds[i];
    const blockRms = outLen > 0 ? Math.sqrt(sumSq / outLen) : 0;

    // Smooth RMS estimate with release time constant to track signal envelope
    this._rmsEst = this._rmsEst * this._agcRelease + blockRms * (1 - this._agcRelease);
    if (this._rmsEst < 1e-7) this._rmsEst = 1e-7; // avoid divide-by-zero

    const neededGain = this._agcTarget / this._rmsEst;

    if (neededGain < this._agcGain) {
      // Signal is louder than target → release (fast): decrease gain
      this._agcGain = this._agcGain * this._agcRelease + neededGain * (1 - this._agcRelease);
    } else {
      // Signal is quieter than target → attack (slow): increase gain
      this._agcGain = this._agcGain * this._agcAttack + neededGain * (1 - this._agcAttack);
    }
    this._agcGain = Math.max(this._agcMinGain, Math.min(this._agcMaxGain, this._agcGain));

    // ── Step 3: Apply AGC gain + tanh soft clip ───────────────────────────
    const g = this._agcGain;
    for (let i = 0; i < outLen; i++) {
      ds[i] = Math.tanh(g * ds[i]);
    }

    // ── Level log (once per second at the native process-block rate) ──────
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

    // ── Accumulate chunks and emit ────────────────────────────────────────
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

registerProcessor('mic-processor-v7', MicProcessor);
