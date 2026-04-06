/**
 * MicProcessor — AudioWorkletProcessor for real-time mic capture.
 *
 * Runs on the audio thread in 128-sample blocks (2.67 ms at 48 kHz).
 * Downsamples to 8 kHz using a box-filter averager (anti-aliased) and emits
 * 960-sample (120 ms) chunks so the GSM encoder gets audio at real-time rate.
 *
 * KEY FIX — carry buffer between blocks
 * ──────────────────────────────────────
 * If we naively compute outLen = floor(128 / ratio) and consume outLen*ratio
 * input samples per block, the remaining (128 mod ratio) samples are lost.
 * For ratio=6: 128/6=21.33 → 21 outputs × 6 = 126 consumed, 2 DISCARDED.
 * Discarded samples are replaced by the START of the NEXT block, creating a
 * tiny phase discontinuity every 2.67 ms (375 Hz), which produces an audible
 * artefact at 375 Hz — heard as "metallic / distorted" speech.
 *
 * Fix: maintain a carry buffer (≤ ratio-1 samples) that is prepended to the
 * next block. This way EVERY input sample is used and the downsampled stream
 * is contiguous, producing exactly 48000/ratio = 8000 samples/sec output.
 *
 * Anti-aliasing: box-filter averaging (mean of `ratio` consecutive samples)
 * acts as a FIR low-pass with cutoff ≈ 0.443 × Fs/ratio ≈ 3 540 Hz (for
 * 48 kHz, ratio 6). This prevents aliasing of 4–8 kHz content into the
 * speech band — a known problem with plain nearest-neighbour decimation.
 */
class MicProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const {
      nativeRate,    // AudioContext sample rate, e.g. 48000
      targetRate,    // GSM rate: 8000
      chunkSamples,  // samples per chunk to emit: 960
      warmupBlocks,  // blocks to discard while mic hardware opens
    } = options.processorOptions;

    this._ratio        = nativeRate / targetRate;  // e.g. 6.0
    this._iRatio       = Math.round(this._ratio);  // integer step, e.g. 6
    this._chunkSamples = chunkSamples;
    this._warmupBlocks = warmupBlocks;
    this._blockCount   = 0;
    this._carry        = new Float32Array(0);  // unconsumed samples from prev block
    this._accum        = new Float32Array(0);  // output accumulator (8 kHz samples)
    this._logEvery     = Math.round(nativeRate / 128);  // ~1 s worth of blocks
    this._logCounter   = 0;
    this._peakAccum    = 0;
    this._rmsAccum     = 0;
    this._rmsCount     = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input || input.length === 0) return true;

    this._blockCount++;

    // --- Warmup: discard first N blocks so mic hardware stabilises ----------
    if (this._blockCount <= this._warmupBlocks) return true;

    // --- Level tracking (at 48 kHz, before downsampling) -------------------
    for (let i = 0; i < input.length; i++) {
      const a = Math.abs(input[i]);
      if (a > this._peakAccum) this._peakAccum = a;
      this._rmsAccum += input[i] * input[i];
      this._rmsCount++;
    }
    this._logCounter++;
    if (this._logCounter >= this._logEvery) {
      const rms  = Math.sqrt(this._rmsAccum / this._rmsCount);
      const peak = this._peakAccum;
      this.port.postMessage({ type: 'level', rms, peak });
      this._logCounter = 0;
      this._peakAccum  = 0;
      this._rmsAccum   = 0;
      this._rmsCount   = 0;
    }

    // --- Anti-aliased downsampling with carry buffer ------------------------
    // Prepend leftover samples from the previous block so no sample is lost.
    const iRatio  = this._iRatio;
    const combined = new Float32Array(this._carry.length + input.length);
    combined.set(this._carry);
    combined.set(input, this._carry.length);

    const outLen = Math.floor(combined.length / iRatio);
    const ds     = new Float32Array(outLen);

    for (let i = 0; i < outLen; i++) {
      const start = i * iRatio;
      let sum = 0;
      for (let j = start; j < start + iRatio; j++) sum += combined[j];
      ds[i] = sum / iRatio;
    }

    // Save unconsumed tail for the next block (< iRatio samples)
    const consumed  = outLen * iRatio;
    this._carry     = combined.slice(consumed);

    // --- Accumulate output samples -----------------------------------------
    const merged = new Float32Array(this._accum.length + outLen);
    merged.set(this._accum);
    merged.set(ds, this._accum.length);
    this._accum = merged;

    // --- Emit complete 960-sample chunks (zero-copy transfer) ---------------
    while (this._accum.length >= this._chunkSamples) {
      const chunk = this._accum.slice(0, this._chunkSamples);
      this._accum = this._accum.slice(this._chunkSamples);
      this.port.postMessage({ type: 'chunk', data: chunk }, [chunk.buffer]);
    }

    return true;
  }
}

registerProcessor('mic-processor', MicProcessor);
