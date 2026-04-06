/**
 * MicProcessor — AudioWorkletProcessor for real-time mic capture.
 *
 * Signal chain:
 *   input (48 kHz) → AGC (with warmup calibration) → box-filter decimation
 *   (48→8 kHz) → accumulate 960 samples → emit chunk
 *
 * ── Automatic Gain Control ────────────────────────────────────────────────
 * A one-pole peak follower adjusts gain sample-by-sample:
 *
 *   peakEnv ← max(|x|, α_atk) or min(|x|, α_rel)   (fast attack, slow release)
 *   gain    ← TARGET / peakEnv  (clamped, then smoothed)
 *
 * CRITICAL: the AGC runs DURING THE WARMUP period so that by the time
 * real audio is emitted the gain has already converged for this mic.
 * Without this, every PTT press starts with gain=initial and the first
 * second of audio blasts at full level, then drops — which kills the radio
 * VOX because the level drops below its threshold after the first burst.
 *
 * TARGET_PEAK = 0.55 Float32 ≈ −5 dBFS: matches the level that a typical
 * Windows eQSO client sends, triggering the repeater VOX reliably.
 *
 * ── Anti-aliased downsampling ─────────────────────────────────────────────
 * Box-filter (mean of `ratio` consecutive samples) is a FIR low-pass at
 * ≈ 3 540 Hz for 48→8 kHz, preventing aliasing of 4–8 kHz content.
 *
 * ── Carry buffer ─────────────────────────────────────────────────────────
 * 128 mod 6 = 2 samples would be discarded per block without this buffer,
 * creating a 375 Hz phase discontinuity (metallic artefact).  The carry
 * buffer prepends them to the next block so every sample is used.
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

    this._ratio        = nativeRate / targetRate;
    this._iRatio       = Math.round(this._ratio);
    this._chunkSamples = chunkSamples;
    this._warmupBlocks = warmupBlocks;
    this._blockCount   = 0;
    this._carry        = new Float32Array(0);
    this._accum        = new Float32Array(0);

    // ── AGC parameters ───────────────────────────────────────────────────
    // Fast attack (5 ms) so the envelope catches loud transients quickly.
    // Slow release (400 ms) so the gain doesn't pump between words.
    // Gain smoothing (30 ms) prevents zipper noise on rapid gain changes.
    const ATK_TC     = 0.005;
    const REL_TC     = 0.400;
    const SMOOTH_TC  = 0.030;
    this._atkAlpha   = Math.exp(-1 / (nativeRate * ATK_TC));
    this._relAlpha   = Math.exp(-1 / (nativeRate * REL_TC));
    this._smAlpha    = Math.exp(-1 / (nativeRate * SMOOTH_TC));

    // Target output peak (Float32, post-tanh).
    // 0.55 ≈ -5 dBFS — matches a typical Windows eQSO client level and
    // reliably triggers a CB radio VOX/COS.
    this._target     = 0.55;
    this._gainMin    = 0.05;
    this._gainMax    = 40.0;

    // Start with a conservative envelope so the first desired gain is
    // reasonable (≈ 1) instead of slamming to GAIN_MAX.
    // The gain will rise to the correct value within the warmup period.
    this._peakEnv    = this._target;   // pretend level = target → gain ≈ 1.0
    this._agcGain    = 1.0;

    // ── Level logging ────────────────────────────────────────────────────
    this._logEvery   = Math.round(nativeRate / 128);
    this._logCounter = 0;
    this._logPeak    = 0;
    this._logRmsAcc  = 0;
    this._logRmsCnt  = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input || input.length === 0) return true;

    this._blockCount++;
    const isWarmup = this._blockCount <= this._warmupBlocks;

    // ── AGC (runs even during warmup to pre-calibrate) ──────────────────
    const gained = new Float32Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const raw    = input[i];
      const absRaw = Math.abs(raw);

      // Peak envelope follower
      if (absRaw > this._peakEnv) {
        this._peakEnv = absRaw + this._atkAlpha * (this._peakEnv - absRaw);
      } else {
        this._peakEnv = absRaw + this._relAlpha * (this._peakEnv - absRaw);
      }

      // Desired gain → smooth toward it
      const desired = Math.min(this._gainMax,
                      Math.max(this._gainMin,
                        this._target / Math.max(this._peakEnv, 0.0001)));
      this._agcGain = desired + this._smAlpha * (this._agcGain - desired);

      // Apply gain + tanh soft-clip
      gained[i] = Math.tanh(this._agcGain * raw);
    }

    // During warmup: calibrate AGC but do not emit audio
    if (isWarmup) return true;

    // ── Level log ────────────────────────────────────────────────────────
    for (let i = 0; i < gained.length; i++) {
      const a = Math.abs(gained[i]);
      if (a > this._logPeak) this._logPeak = a;
      this._logRmsAcc += gained[i] * gained[i];
      this._logRmsCnt++;
    }
    this._logCounter++;
    if (this._logCounter >= this._logEvery) {
      const rms = Math.sqrt(this._logRmsAcc / this._logRmsCnt);
      this.port.postMessage({
        type: 'level',
        rms,
        peak: this._logPeak,
        gain: this._agcGain,
      });
      this._logCounter = 0;
      this._logPeak    = 0;
      this._logRmsAcc  = 0;
      this._logRmsCnt  = 0;
    }

    // ── Box-filter downsampling with carry buffer ─────────────────────────
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
    this._carry = combined.slice(outLen * iRatio);

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
