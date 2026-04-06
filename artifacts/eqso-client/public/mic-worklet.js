/**
 * MicProcessor — AudioWorkletProcessor for real-time mic capture.
 *
 * Signal chain (within this node):
 *   input (48 kHz Float32) → AGC → box-filter decimation (48→8 kHz) → accum → emit chunk
 *
 * ── Automatic Gain Control ────────────────────────────────────────────────────
 * We cannot know the microphone hardware gain in advance: some devices produce
 * 0.003 Float32 peak, others 0.6+.  A fixed gain (×2, ×4, ×8) is always wrong
 * for someone.  Instead we implement a simple one-pole peak follower:
 *
 *   peakEnv[n] = max(|x[n]|, alpha * peakEnv[n-1])
 *
 * where alpha = exp(-1 / (Fs × TC_ATK)) for attack and similarly for release.
 * The desired gain is TARGET_PEAK / peakEnv, clamped to [GAIN_MIN, GAIN_MAX].
 * Gain is smoothed with a slow LPF to avoid rapid level swings between words.
 *
 * TARGET_PEAK = 0.30 Float32 ≈ −10 dBFS: loud enough for GSM and the radio
 * VOX, quiet enough to avoid hard-clipping in the 16-bit PCM conversion that
 * feeds the server encoder.
 *
 * ── Anti-aliased downsampling ─────────────────────────────────────────────────
 * Box-filter averaging (mean of `ratio` consecutive samples) acts as a FIR
 * low-pass at ≈ 0.443 × Fs/ratio ≈ 3 540 Hz, preventing aliasing of 4–8 kHz
 * content into the speech band.
 *
 * ── Carry buffer ─────────────────────────────────────────────────────────────
 * Without a carry buffer, 128 mod 6 = 2 samples are discarded per worklet
 * block, creating a 375 Hz phase discontinuity (audible metallic artefact).
 * The carry buffer prepends unconsumed samples to the next block so that every
 * sample is processed and the output rate is exactly 48000/6 = 8000 Hz.
 */
class MicProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const {
      nativeRate,    // AudioContext sample rate, e.g. 48000
      targetRate,    // GSM rate: 8000
      chunkSamples,  // output chunk size: 960
      warmupBlocks,  // blocks to skip while mic hardware opens
    } = options.processorOptions;

    this._ratio        = nativeRate / targetRate;   // 6.0
    this._iRatio       = Math.round(this._ratio);   // 6
    this._chunkSamples = chunkSamples;
    this._warmupBlocks = warmupBlocks;
    this._blockCount   = 0;
    this._carry        = new Float32Array(0);
    this._accum        = new Float32Array(0);

    // ── AGC state ─────────────────────────────────────────────────────────
    // Peak follower with fast attack, slow release.
    const ATK_TC      = 0.010;   // attack  time constant: 10 ms
    const REL_TC      = 0.300;   // release time constant: 300 ms
    const GAIN_SM_TC  = 0.050;   // gain smoothing:        50 ms
    this._atkAlpha    = Math.exp(-1 / (nativeRate * ATK_TC));
    this._relAlpha    = Math.exp(-1 / (nativeRate * REL_TC));
    this._gsmAlpha    = Math.exp(-1 / (nativeRate * GAIN_SM_TC));
    this._peakEnv     = 0.01;    // start with small non-zero value
    this._agcGain     = 4.0;     // initial gain (will converge within warmup)
    this._targetPeak  = 0.30;    // −10 dBFS: safe for GSM and radio VOX
    this._gainMin     = 0.05;    // avoid division by zero and excessive boost
    this._gainMax     = 40.0;    // max boost for very quiet mics

    // ── Level logging ─────────────────────────────────────────────────────
    this._logEvery    = Math.round(nativeRate / 128);  // ~1 s worth of blocks
    this._logCounter  = 0;
    this._logPeak     = 0;
    this._logRmsAcc   = 0;
    this._logRmsCnt   = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input || input.length === 0) return true;

    this._blockCount++;
    if (this._blockCount <= this._warmupBlocks) return true;

    // ── Apply AGC sample-by-sample ──────────────────────────────────────
    const gained = new Float32Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const raw = input[i];
      const absRaw = Math.abs(raw);

      // Peak envelope follower
      if (absRaw > this._peakEnv) {
        this._peakEnv = absRaw + this._atkAlpha * (this._peakEnv - absRaw);
      } else {
        this._peakEnv = absRaw + this._relAlpha * (this._peakEnv - absRaw);
      }

      // Desired gain to reach target peak
      const desired = Math.min(this._gainMax,
                       Math.max(this._gainMin,
                         this._targetPeak / Math.max(this._peakEnv, 0.0001)));

      // Smooth the gain to prevent rapid zipper noise
      this._agcGain = desired + this._gsmAlpha * (this._agcGain - desired);

      // Apply gain and soft-clip at ±1 using tanh
      const s = this._agcGain * raw;
      gained[i] = Math.tanh(s);   // tanh naturally saturates at ±1
    }

    // ── Level log (post-AGC, pre-downsample, at native rate) ───────────
    for (let i = 0; i < gained.length; i++) {
      const a = Math.abs(gained[i]);
      if (a > this._logPeak) this._logPeak = a;
      this._logRmsAcc += gained[i] * gained[i];
      this._logRmsCnt++;
    }
    this._logCounter++;
    if (this._logCounter >= this._logEvery) {
      const rms  = Math.sqrt(this._logRmsAcc / this._logRmsCnt);
      this.port.postMessage({ type: 'level', rms, peak: this._logPeak, gain: this._agcGain });
      this._logCounter = 0;
      this._logPeak    = 0;
      this._logRmsAcc  = 0;
      this._logRmsCnt  = 0;
    }

    // ── Box-filter downsampling with carry buffer ───────────────────────
    const iRatio   = this._iRatio;
    const combined = new Float32Array(this._carry.length + gained.length);
    combined.set(this._carry);
    combined.set(gained, this._carry.length);

    const outLen = Math.floor(combined.length / iRatio);
    const ds     = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const start = i * iRatio;
      let sum = 0;
      for (let j = start; j < start + iRatio; j++) sum += combined[j];
      ds[i] = sum / iRatio;
    }
    const consumed = outLen * iRatio;
    this._carry    = combined.slice(consumed);

    // ── Accumulate and emit 960-sample chunks ───────────────────────────
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
