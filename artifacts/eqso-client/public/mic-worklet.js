/**
 * MicProcessor — AudioWorkletProcessor for real-time mic capture.
 *
 * Runs on the audio thread in 128-sample blocks (2.67 ms at 48 kHz).
 * Downsamples to 8 kHz using a box-filter averager (anti-aliased) and emits
 * 960-sample (120 ms) chunks so the GSM encoder gets audio at real-time rate.
 *
 * Anti-aliasing: nearest-neighbour decimation (taking every 6th sample)
 * causes severe aliasing — frequencies 4–8 kHz fold back into 0–4 kHz and
 * add noise/distortion. A box-filter averager (mean of `ratio` consecutive
 * samples before decimation) acts as a low-pass FIR with cutoff at
 * ≈ 0.443 × Fs/ratio = 0.443 × 48000/6 ≈ 3 540 Hz — exactly the speech
 * intelligibility band needed by GSM 06.10.
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
    this._chunkSamples = chunkSamples;
    this._warmupBlocks = warmupBlocks;
    this._blockCount   = 0;
    this._accum        = new Float32Array(0);
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

    // --- Level tracking -----------------------------------------------------
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

    // --- Anti-aliased downsampling (box-filter averaging + decimation) ------
    // For each output sample, average `ratio` consecutive input samples.
    // This is a FIR low-pass with cutoff ≈ Fs/(2*ratio) = 4 000 Hz (at 48 kHz,
    // ratio=6), preventing aliasing of 4–8 kHz content into the speech band.
    const ratio  = this._ratio;
    const iRatio = Math.round(ratio);          // integer step (6 for 48→8 kHz)
    const outLen = Math.floor(input.length / ratio);
    const ds     = new Float32Array(outLen);

    for (let i = 0; i < outLen; i++) {
      const start = i * iRatio;
      let sum = 0;
      const end = Math.min(start + iRatio, input.length);
      for (let j = start; j < end; j++) sum += input[j];
      ds[i] = sum / (end - start);
    }

    // --- Accumulate ---------------------------------------------------------
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
