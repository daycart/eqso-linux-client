/**
 * MicProcessor — AudioWorkletProcessor for real-time mic capture.
 *
 * Runs on the audio thread in 128-sample blocks (2.67 ms at 48 kHz).
 * Downsamples to 8 kHz and emits 960-sample (120 ms) chunks so the
 * GSM encoder on the server receives audio at real-time rate.
 *
 * Replaces the deprecated ScriptProcessorNode which fired every ~255–340 ms
 * (3–4 callbacks of 85 ms each), delivering audio at only ~40 % real-time
 * speed and causing ASORAPA's audio buffer to run dry after ~2 s.
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

    this._ratio        = nativeRate / targetRate;
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

    // --- Level tracking (for debug log sent back to main thread) ------------
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

    // --- Downsample: nearest-neighbour decimation ---------------------------
    const ratio  = this._ratio;
    const outLen = Math.floor(input.length / ratio);
    const ds     = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      ds[i] = input[Math.round(i * ratio)];
    }

    // --- Accumulate ---------------------------------------------------------
    const merged = new Float32Array(this._accum.length + outLen);
    merged.set(this._accum);
    merged.set(ds, this._accum.length);
    this._accum = merged;

    // --- Emit complete 960-sample chunks ------------------------------------
    while (this._accum.length >= this._chunkSamples) {
      const chunk = this._accum.slice(0, this._chunkSamples);
      this._accum = this._accum.slice(this._chunkSamples);
      // Transfer the buffer (zero-copy) to the main thread
      this.port.postMessage({ type: 'chunk', data: chunk }, [chunk.buffer]);
    }

    return true;
  }
}

registerProcessor('mic-processor', MicProcessor);
