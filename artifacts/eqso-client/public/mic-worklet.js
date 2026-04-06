/**
 * MicProcessor — AudioWorkletProcessor for real-time mic capture.
 *
 * ── Signal chain ──────────────────────────────────────────────────────────
 *   input (48 kHz) → box-filter decimation (48→8 kHz, raw signal)
 *   → gain×3 + soft-knee limiter (at 8 kHz)
 *   → accumulate 960 samples → emit chunk (when emitting=true)
 *
 * ── Why downsample BEFORE limiting ───────────────────────────────────────
 * Applying nonlinear limiting at 48 kHz generates harmonics above 4 kHz;
 * the box-filter then folds them back into the 0–4 kHz band (aliasing).
 * Downsampling first confines any limiter harmonics above GSM Nyquist (4 kHz).
 *
 * ── Gain + soft-knee limiter ─────────────────────────────────────────────
 * autoGainControl=true normalises the mic to ~15–25 % FS.  gain×3 brings
 * it to 45–75 % FS — ideal for GSM 06.10 and for activating radio VOX gates.
 *
 * The soft-knee limiter is LINEAR below 0.50 FS (no distortion at all) and
 * compresses smoothly above 0.50 FS, asymptotically approaching 0.90 FS.
 * Normal speech stays in the linear zone; loud speech reaches 84–88 % FS,
 * enough to activate the physical radio VOX gate (threshold ~85 % FS).
 *
 *   knee = 0.50, cap = 0.90, range = 0.40
 *   output = sign × (0.50 + 0.40 × (1 − exp(−(|gain·x|−0.50)/0.40)))
 *                          for |gain·x| > 0.50
 *
 *   normal speech  (gain·raw ≈ 0.54): output ≈ 0.54 (linear, no distortion)
 *   loud speech    (gain·raw ≈ 1.30): output ≈ 0.85 (VOX activates ✓)
 *   very loud      (gain·raw ≥ 2.00): output → 0.90 asymptote
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

    // gain=3: brings OS-normalised mic (15–25 % FS) to 45–75 % FS.
    // The soft-knee limiter below keeps the output below 0.90 FS even at
    // very loud speech. Loud speech reaches ~85 % FS → activates radio VOX.
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

    // ── Step 2: Apply gain×3 + soft-knee limiter at 8 kHz ────────────────
    // Linear zone: |gain·x| ≤ knee  → output = gain·x  (no distortion)
    // Knee zone:   |gain·x| >  knee → output = sign×(knee + range×(1−e^(−excess/range)))
    //              asymptote at knee+range = 0.90 FS
    const g     = this._gain;
    const knee  = 0.50;
    const range = 0.40;   // cap = knee + range = 0.90
    for (let i = 0; i < outLen; i++) {
      const s   = g * ds[i];
      const abs = Math.abs(s);
      if (abs <= knee) {
        ds[i] = s;
      } else {
        const sign = s < 0 ? -1 : 1;
        ds[i] = sign * (knee + range * (1 - Math.exp(-(abs - knee) / range)));
      }
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
