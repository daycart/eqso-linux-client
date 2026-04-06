/**
 * MicProcessor — AudioWorkletProcessor for real-time mic capture.
 *
 * ── Signal chain ──────────────────────────────────────────────────────────
 *   input (48 kHz) → box-filter decimation (48→8 kHz)
 *   → AGC (slow-attack/slow-release, target RMS = 35% FS)
 *   → tanh soft-clip (hard ceiling ±1)
 *   → accumulate 960 samples → emit chunk (when emitting=true)
 *
 * ── Why AGC instead of fixed gain ────────────────────────────────────────
 * With autoGainControl:false the raw mic level depends entirely on
 * hardware sensitivity — can range from 1 % to 30 % FS.  A fixed gain
 * that is good for a loud mic will over-compress a quiet one, and vice
 * versa.  A slow-attack/slow-release AGC gives consistent output while
 * avoiding the "pumping on word gaps" artifact of a fast AGC.
 *
 *   Attack  200 ms — follows rising speech envelope without chasing syllables
 *   Release 4 000 ms — does not pump up gain during short pauses
 *   Max gain × 60 — enough for even very quiet laptop mics
 *   Min gain × 1  — never attenuates (tanh handles peaks)
 *
 * tanh is applied AFTER downsampling (at 8 kHz).  This avoids aliasing:
 * harmonics from tanh clipping are at 8 kHz multiples (above GSM Nyquist).
 *
 * ── Warmup ────────────────────────────────────────────────────────────────
 * The first 80 ms of mic audio is discarded to absorb the hardware startup
 * pop/click and let the AGC settle.
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
    this._targetRate    = targetRate;
    this._chunkSamples  = chunkSamples;
    this._warmupBlocks  = warmupBlocks;
    this._blockCount    = 0;
    this._emitting      = false;
    this._warmupDone    = false;
    this._carry         = new Float32Array(0);
    this._accum         = new Float32Array(0);
    this._pendingEmit   = null;

    // ── AGC state ─────────────────────────────────────────────────────────
    // Target RMS at 8 kHz output (post-AGC, pre-tanh): 35 % FS.
    // GSM 06.10 works well with 20–70 % FS; 35 % gives headroom for peaks.
    this._agcTarget  = 0.35;
    this._agcGain    = 8;           // start at ×8; adapts quickly on first TX
    this._agcRmsEst  = 0;           // exponential RMS envelope
    // Time-constants (in 8 kHz samples)
    this._agcAttackTC  = 0.200 * targetRate; // 200 ms
    this._agcReleaseTC = 4.000 * targetRate; // 4 s

    // Level logging (once per second at 8 kHz)
    this._logEvery  = targetRate;   // samples counted at 8 kHz
    this._logSamples = 0;
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

    // ── Step 2: AGC — track envelope, adjust gain slowly ─────────────────
    // Compute RMS of this small frame at 8 kHz
    let frameRmsSq = 0;
    for (let i = 0; i < outLen; i++) frameRmsSq += ds[i] * ds[i];
    const frameRms = Math.sqrt(frameRmsSq / Math.max(1, outLen));

    // Exponential smoothing (attack faster than release)
    const dtSamples = outLen;
    // alpha = 1 - e^(-dt/TC); for small TC use approximation
    const atkAlpha = 1 - Math.exp(-dtSamples / this._agcAttackTC);
    const relAlpha = 1 - Math.exp(-dtSamples / this._agcReleaseTC);
    const alpha = (frameRms > this._agcRmsEst) ? atkAlpha : relAlpha;
    this._agcRmsEst += alpha * (frameRms - this._agcRmsEst);

    // Desired gain to reach target RMS; clamp to [1, 60]
    const desired = this._agcTarget / Math.max(0.001, this._agcRmsEst);
    const clamped = Math.min(60, Math.max(1, desired));

    // Smooth the gain itself (same attack/release as RMS) to avoid clicks
    const gainAlpha = (clamped < this._agcGain) ? atkAlpha : relAlpha;
    this._agcGain += gainAlpha * (clamped - this._agcGain);

    // ── Step 3: Apply AGC gain + tanh limiter at 8 kHz ───────────────────
    const g = this._agcGain;
    for (let i = 0; i < outLen; i++) {
      ds[i] = Math.tanh(g * ds[i]);
    }

    // ── Level log (once per second, post-AGC+tanh) ────────────────────────
    if (this._emitting) {
      for (let i = 0; i < outLen; i++) {
        const a = Math.abs(ds[i]);
        if (a > this._logPeak) this._logPeak = a;
        this._logRmsAcc += ds[i] * ds[i];
        this._logRmsCnt++;
      }
      this._logSamples += outLen;
      if (this._logSamples >= this._logEvery) {
        this.port.postMessage({
          type:   'level',
          rms:    Math.sqrt(this._logRmsAcc / Math.max(1, this._logRmsCnt)),
          peak:   this._logPeak,
          agcGain: Math.round(this._agcGain * 10) / 10,
        });
        this._logSamples = 0;
        this._logPeak    = 0;
        this._logRmsAcc  = 0;
        this._logRmsCnt  = 0;
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
