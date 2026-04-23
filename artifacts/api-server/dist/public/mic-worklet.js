/**
 * MicProcessor v24 — Stable output for CB radio linking (RC IRIA compatible).
 *
 * ── Why the level matters ─────────────────────────────────────────────────
 * RC IRIA "Solo radio-enlaces" routes 0R-* audio to the COM-port PTT.
 * The software checks for saturation: if audio peaks above ~15-20 % FS it
 * marks the signal as clipped and does NOT key the radio.
 * Below the "Nivel de silencio" threshold it also ignores it.
 * Target zone: 5-15 % FS peak (first green segment on the VU meter).
 *
 * ── Signal chain ──────────────────────────────────────────────────────────
 *   input (native rate) → box-filter decimation to 8 kHz
 *   → AGC with hold/attack/release (target 0.04 RMS ≈ 12 % FS peak)
 *   → tanh soft clip → clamp ±1.0 → emit
 *
 * ── AGC hold/attack/release ───────────────────────────────────────────────
 * Standard broadcast AGC behaviour:
 *   release  80 ms  — gain drops FAST when the signal gets louder (no overload)
 *   hold    300 ms  — after signal drops, gain is FROZEN for 300 ms
 *                     → prevents gain spikes during natural speech pauses
 *   attack 2000 ms  — after the hold, gain rises very SLOWLY
 *                     → smooth recovery between sentences
 * Max gain 5× limits compression ratio to avoid audible AGC "pumping".
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
    const blockMs = (128 / nativeRate) * 1000;
    this._agcGain    = 1.0;    // safe start: avoids first-PTT saturation spike
    this._agcTarget  = 0.12;   // 12 % RMS → peak ~36 % FS — relay TX needs higher drive
    this._agcMaxGain = 5.0;    // cap: limits compression ratio, avoids AGC pumping
    this._agcMinGain = 0.1;
    this._agcRelease = Math.exp(-blockMs / 80);    // fast drop: 80 ms
    this._agcAttack  = Math.exp(-blockMs / 4000);  // slow rise: 4000 ms (smoother)
    this._rmsEst     = 0.01;

    // AGC hold: gain is frozen for 300 ms after the signal drops
    this._agcHoldMs        = 300;
    this._agcHoldRemaining = 0;  // counts down in ms

    // ── Level logging ─────────────────────────────────────────────────────
    this._logEvery  = Math.round(nativeRate / 128);
    this._logCount  = 0;
    this._logPeak   = 0;
    this._logRmsAcc = 0;
    this._logRmsCnt = 0;

    this.port.onmessage = (ev) => {
      if (ev.data?.type === 'emit') {
        if (ev.data.emitting) {
          // Reset audio buffers but NOT the AGC state.
          // Preserving gain/rmsEst/hold across PTTs prevents the gain from
          // ramping to max during silence and then overshooting on the first word.
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

    // ── Warmup: discard first 80 ms ───────────────────────────────────────
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

    // ── Step 2: AGC with hold/attack/release ──────────────────────────────
    //
    // This block time in ms (at native rate, 128 samples per process() call):
    const blockMs = (128 / sampleRate) * 1000;

    let sumSq = 0;
    for (let i = 0; i < outLen; i++) sumSq += ds[i] * ds[i];
    const blockRms = outLen > 0 ? Math.sqrt(sumSq / outLen) : 0;

    // Track RMS with the fast release constant so we respond quickly to
    // louder signals. This is the INPUT RMS (before gain is applied).
    this._rmsEst = this._rmsEst * this._agcRelease + blockRms * (1 - this._agcRelease);
    if (this._rmsEst < 1e-7) this._rmsEst = 1e-7;

    const neededGain = Math.max(this._agcMinGain,
                         Math.min(this._agcMaxGain,
                           this._agcTarget / this._rmsEst));

    // Gain is only updated while transmitting.  Between PTTs the gain is
    // FROZEN at its last value so that inter-PTT silence cannot ramp it to
    // the maximum and cause an overload spike at the start of the next PTT.
    // rmsEst continues to track the mic regardless, so the first PTT block
    // already has a good estimate of the current mic level.
    if (this._emitting) {
      if (neededGain < this._agcGain) {
        // Signal got LOUDER → drop gain fast (release), reset hold timer
        this._agcHoldRemaining = this._agcHoldMs;
        this._agcGain = this._agcGain * this._agcRelease + neededGain * (1 - this._agcRelease);
      } else {
        // Signal got quieter → honour hold before allowing gain to rise
        if (this._agcHoldRemaining > 0) {
          this._agcHoldRemaining = Math.max(0, this._agcHoldRemaining - blockMs);
          // gain stays where it is during hold
        } else {
          // After hold expires: raise gain very slowly (attack 2000 ms)
          this._agcGain = this._agcGain * this._agcAttack + neededGain * (1 - this._agcAttack);
        }
      }
      this._agcGain = Math.max(this._agcMinGain, Math.min(this._agcMaxGain, this._agcGain));
    }

    // ── Step 3: Apply AGC + tanh soft clip ────────────────────────────────
    const g = this._agcGain;
    for (let i = 0; i < outLen; i++) {
      ds[i] = Math.tanh(g * ds[i]);
    }

    // ── Step 4: Clamp to ±1.0 ─────────────────────────────────────────────
    for (let i = 0; i < outLen; i++) {
      if      (ds[i] >  1) ds[i] =  1;
      else if (ds[i] < -1) ds[i] = -1;
    }

    // ── Level log (once per second) ───────────────────────────────────────
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

    // ── Accumulate and emit ───────────────────────────────────────────────
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

registerProcessor('mic-processor-v8', MicProcessor);
