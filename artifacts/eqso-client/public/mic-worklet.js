/**
 * MicProcessor — AudioWorkletProcessor for real-time mic capture.
 *
 * The worklet runs CONTINUOUSLY once the mic is open (for the whole session).
 * PTT state is controlled via port messages:
 *   { type: 'emit', emitting: true }  → start posting chunks
 *   { type: 'emit', emitting: false } → stop posting chunks (mic stays open)
 *
 * ── Signal chain ──────────────────────────────────────────────────────────
 *   input (48 kHz) → fixed gain + tanh soft-clip → box-filter decimation
 *   (48→8 kHz) → accumulate 960 samples → emit chunk (when emitting=true)
 *
 * ── Why fixed gain instead of AGC ────────────────────────────────────────
 * An AGC gain follower releases slowly during pauses between words.  After
 * a 300 ms inter-word pause the gain can shoot to ×40 (max clamped).  When
 * the next word starts, tanh(40 × 0.4) = 1.0 — a full-scale transient that
 * the GSM 06.10 predictor cannot track, producing a loud burst artefact and
 * then silence.  A fixed gain avoids this entirely: the codec receives
 * natural speech dynamics with no gain transients.
 *
 * ── Warmup ────────────────────────────────────────────────────────────────
 * The first 80 ms of mic audio is discarded to absorb the hardware startup
 * pop/click.  After warmup the worklet posts { type: 'ready' } and begins
 * honouring PTT start requests.  Any 'emit: true' message received DURING
 * warmup is queued and applied immediately when warmup finishes.
 *
 * ── Anti-aliased downsampling ─────────────────────────────────────────────
 * Box-filter (mean of ratio consecutive samples) is a FIR low-pass at
 * ≈ 3 540 Hz for 48→8 kHz, preventing aliasing of 4–8 kHz content.
 *
 * ── Carry buffer ─────────────────────────────────────────────────────────
 * 128 mod 6 = 2 samples would be discarded per block without this buffer,
 * creating a 375 Hz phase discontinuity.  The carry buffer prepends them to
 * the next block so every sample is used.
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

    // Fixed gain × tanh soft-clip.  autoGainControl=false is used in getUserMedia
    // so the raw mic arrives at hardware sensitivity (no OS boosting).
    // gain=6: good balance for most laptop/headset mics without OS AGC.
    //   Quiet mic  (raw peak ~0.03): tanh(6×0.03)=tanh(0.18)=0.179 →  5 870 Int16 (18%)
    //   Normal mic (raw peak ~0.10): tanh(6×0.10)=tanh(0.60)=0.537 → 17 590 Int16 (54%)
    //   Loud mic   (raw peak ~0.30): tanh(6×0.30)=tanh(1.80)=0.974 → 31 910 Int16 (97%)
    // tanh soft-clips gracefully — no hard clipping artefacts.
    // GSM 06.10 XMAX per-sub-frame normalisation handles 30-100% FS well.
    this._gain = 6;

    // Level logging (posted once per second)
    this._logEvery  = Math.round(nativeRate / 128);
    this._logCount  = 0;
    this._logPeak   = 0;
    this._logRmsAcc = 0;
    this._logRmsCnt = 0;

    this.port.onmessage = (ev) => {
      if (ev.data?.type === 'emit') {
        // When PTT starts, discard any audio accumulated since the last PTT
        // ended.  The worklet runs continuously (mic stays open), so _carry
        // and _accum fill with mic-noise samples between presses.  If we do
        // not flush them the first transmitted packet contains old audio, which
        // can sound like an echo or garbled syllable at the start of each TX.
        if (ev.data.emitting) {
          this._carry = new Float32Array(0);
          this._accum = new Float32Array(0);
        }
        if (this._warmupDone) {
          this._emitting = ev.data.emitting;
        } else {
          // Warmup still running — remember intent, apply after warmup
          this._pendingEmit = ev.data.emitting;
        }
      }
    };
    this._pendingEmit = null;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input || input.length === 0) return true;

    this._blockCount++;

    // ── Warmup: discard audio, absorb mic startup pop ─────────────────────
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

    // ── Apply fixed gain + tanh soft-clip ────────────────────────────────
    const gained = new Float32Array(input.length);
    for (let i = 0; i < input.length; i++) {
      gained[i] = Math.tanh(this._gain * input[i]);
    }

    // ── Level log: track both 48kHz (gained) and 8kHz (ds) peaks per second
    if (this._emitting) {
      for (let i = 0; i < gained.length; i++) {
        const a = Math.abs(gained[i]);
        if (a > this._logPeak) this._logPeak = a;
        this._logRmsAcc += gained[i] * gained[i];
        this._logRmsCnt++;
      }
      this._logCount++;
      if (this._logCount >= this._logEvery) {
        this.port.postMessage({
          type: 'level',
          rms:  Math.sqrt(this._logRmsAcc / this._logRmsCnt),
          peak: this._logPeak,
          peak8k: this._logPeak8k || 0,
          gain: this._gain,
        });
        this._logCount  = 0;
        this._logPeak   = 0;
        this._logPeak8k = 0;
        this._logRmsAcc = 0;
        this._logRmsCnt = 0;
      }
    }

    if (!this._emitting) return true;

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
      // Track 8 kHz peak for level logging (separate from 48 kHz peak)
      const a8 = Math.abs(ds[i]);
      if (a8 > (this._logPeak8k || 0)) this._logPeak8k = a8;
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
