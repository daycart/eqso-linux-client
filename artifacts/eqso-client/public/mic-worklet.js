/**
 * MicProcessor — AudioWorkletProcessor for real-time mic capture.
 *
 * ── Signal chain ──────────────────────────────────────────────────────────
 *   input (48 kHz) → box-filter decimation (48→8 kHz, raw signal)
 *   → fixed gain × tanh soft-clip (at 8 kHz)
 *   → accumulate 960 samples → emit chunk (when emitting=true)
 *
 * ── Why downsample BEFORE tanh ───────────────────────────────────────────
 * tanh applied at 48 kHz generates harmonics above 4 kHz; the box-filter
 * then folds them back into the 0–4 kHz band (aliasing distortion).
 * Downsampling first keeps tanh harmonics above the GSM Nyquist (4 kHz).
 *
 * ── Gain tuning ──────────────────────────────────────────────────────────
 * autoGainControl=true in getUserMedia lets the OS normalise the mic to a
 * consistent level (typically 15–25 % FS for this hardware).  Our fixed
 * gain×3 brings it to 50–96 % FS before GSM encoding.  The tanh soft-clip
 * prevents true saturation and adds mild CB-style compression that improves
 * intelligibility over noise.  Lower gains (<2) leave radio VOX thresholds
 * unsatisfied when the soundcard output at the remote end is uncalibrated.
 *
 *   OS-normalised mic peak ~0.18: tanh(3×0.18)=tanh(0.54)=0.514 → 51 %
 *   OS-normalised mic peak ~0.25: tanh(3×0.25)=tanh(0.75)=0.635 → 64 %
 *   OS-normalised mic peak ~0.40: tanh(3×0.40)=tanh(1.20)=0.834 → 83 %
 *   OS-normalised mic peak ~0.67: tanh(3×0.67)=tanh(2.01)=0.965 → 96 %
 *
 * ── Warmup ────────────────────────────────────────────────────────────────
 * The first 80 ms of mic audio is discarded to absorb the hardware startup
 * pop/click.  After warmup the worklet posts { type: 'ready' }.
 *
 * ── Carry buffer ─────────────────────────────────────────────────────────
 * 128 mod 6 = 2 samples would be discarded per block without this buffer,
 * creating a 375 Hz phase discontinuity.
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

    // gain=3: brings OS-normalised mic (15–25 % FS) to 51–65 % FS, loud voice
    // to 83–96 % FS.  tanh soft-clips peaks without hard distortion.  Levels
    // below ~50 % FS often fail to hold the VOX at remote radio links where
    // the soundcard output is uncalibrated (confirmed with ffmpeg libgsm encoder).
    this._gain = 3;

    // Level logging: once per second at 8 kHz
    this._logEvery  = Math.round(nativeRate / 128); // ~375 process blocks/s
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

    // ── Step 1: Box-filter downsample 48 kHz → 8 kHz (raw signal) ────────
    // Downsample BEFORE applying gain+tanh to avoid aliasing of clip harmonics.
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

    // ── Step 2: Apply fixed gain + tanh at 8 kHz ─────────────────────────
    // tanh(gain·x) compresses loud peaks gently, preserving voice harmonics.
    // Odd-harmonic distortion profile is more intelligible than hard clipping.
    const g = this._gain;
    for (let i = 0; i < outLen; i++) {
      ds[i] = Math.tanh(g * ds[i]);
    }

    // ── Level log (once per second at 48 kHz process-block rate) ─────────
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
          gain: this._gain,
        });
        this._logCount  = 0;
        this._logPeak   = 0;
        this._logRmsAcc = 0;
        this._logRmsCnt = 0;
      }
    }

    if (!this._emitting) return true;

    // ── Accumulate 960-sample chunks and emit ────────────────────────────
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

registerProcessor('mic-processor', MicProcessor);
