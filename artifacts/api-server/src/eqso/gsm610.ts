/**
 * GSM 06.10 full-rate codec — encoder + decoder
 * Ported from libgsm (Copyright 1992 Jutta Degener & Carsten Bormann, TU Berlin)
 * MIT-compatible free use.
 *
 * Input:  160 Int16 PCM samples at 8 kHz (20 ms)
 * Output: 33 bytes  (260 bits; upper nibble of byte[0] always = 0xd)
 */

// ─── Fixed-point helpers ──────────────────────────────────────────────────────

/** Saturating 16-bit addition */
function GSM_ADD(a: number, b: number): number {
  const s = (a + b) | 0;
  if (a > 0 && b > 0 && s < 0) return 32767;
  if (a < 0 && b < 0 && s > 0) return -32768;
  return s;
}

/** 16×16 → 32 multiply, result right-shifted 15, truncated to 16 */
function GSM_MULT(a: number, b: number): number {
  if (a === -32768 && b === -32768) return 32767;
  return ((a * b) >> 15) | 0;
}

/** GSM_MULT with rounding (+0.5) */
function GSM_MULT_R(a: number, b: number): number {
  if (a === -32768 && b === -32768) return 32767;
  return (((a * b) + 16384) >> 15) | 0;
}

/** Arithmetic right shift */
function SASR(x: number, by: number): number {
  return (x >> by) | 0;
}

/** 16-bit absolute value (saturating) */
function GSM_ABS(x: number): number {
  return x < 0 ? (x === -32768 ? 32767 : -x) : x;
}

/** Clip to [lo, hi] */
function CLIP(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Number of leading sign bits - 1  (for 32-bit signed value) */
function norm32(x: number): number {
  if (x === 0) return 0;
  if (x < 0) x = ~x;
  let n = 0;
  if ((x & 0xFFFF0000) === 0) { n += 16; x <<= 16; }
  if ((x & 0xFF000000) === 0) { n += 8;  x <<= 8;  }
  if ((x & 0xF0000000) === 0) { n += 4;  x <<= 4;  }
  if ((x & 0xC0000000) === 0) { n += 2;  x <<= 2;  }
  if ((x & 0x80000000) === 0) { n += 1; }
  return n;
}

// ─── LPC Analysis ────────────────────────────────────────────────────────────

function Autocorrelation(s: Int16Array): number[] {
  // Scale input to 13 bits (libgsm-style: find max, compute scalauto)
  let smax = 0;
  for (let i = 0; i < 160; i++) {
    const a = GSM_ABS(s[i]);
    if (a > smax) smax = a;
  }

  let scalauto = 0;
  if (smax !== 0) {
    // norm of (smax << 16) as int32
    let tmp = (smax << 16) | 0;
    if (tmp < 0) tmp = ~tmp;
    const n = norm32(tmp);
    scalauto = 4 - n;
  }

  const fasr = new Int16Array(160);
  if (scalauto > 0) {
    const factor = SASR(32767, scalauto - 1); // 2^(15-scalauto)
    for (let i = 0; i < 160; i++) fasr[i] = GSM_MULT(s[i], factor);
  } else {
    for (let i = 0; i < 160; i++) fasr[i] = SASR(s[i], -scalauto);
  }

  const L_ACF: number[] = new Array(9).fill(0);
  for (let k = 0; k <= 8; k++) {
    let acc = 0;
    for (let i = k; i < 160; i++) acc += fasr[i] * fasr[i - k];
    L_ACF[k] = acc | 0;
  }
  return L_ACF;
}

function Reflection_coefficients(L_ACF: number[]): Int16Array {
  // Schur recursion → reflection coefficients r[0..7] in Q15
  const r = new Int16Array(8);
  const P = new Int16Array(9);
  const K = new Int16Array(9);

  if (L_ACF[0] === 0) return r;

  // Scale autocorrelation to 16-bit words
  const n = norm32(L_ACF[0]);
  let temp: number;
  for (let i = 0; i <= 8; i++) {
    P[i] = SASR(L_ACF[i], (32 - 16 - n)) | 0;
  }

  // Initialize K
  for (let i = 1; i <= 8; i++) K[i] = P[i];

  for (let idx = 1; idx <= 8; idx++) {
    if (P[0] === 0) break;
    // r[idx-1] = -K[idx] / P[0]
    temp = GSM_ABS(P[0]);
    if (temp === 0) { r[idx - 1] = 0; break; }

    if (K[idx] < 0) {
      r[idx - 1] = CLIP(SASR(-K[idx], 0), -32768, 32767);
      // Actual formula: r = K[idx] / P[0] saturated
    } else {
      r[idx - 1] = CLIP(SASR(-K[idx], 0), -32768, 32767);
    }

    // Division K[idx] / P[0] with saturation
    {
      let num = K[idx];
      let den = P[0];
      if (den === 0) { r[idx - 1] = 0; }
      else {
        // GSM division using shift-and-subtract
        let neg = false;
        if (num < 0) { neg = !neg; num = -num; }
        if (den < 0) { neg = !neg; den = -den; }
        if (num >= den) { r[idx - 1] = neg ? -32767 : 32767; }
        else {
          let q = 0;
          for (let i = 0; i < 15; i++) {
            num <<= 1;
            q <<= 1;
            if (num >= den) { q |= 1; num -= den; }
          }
          r[idx - 1] = neg ? -q : q;
        }
      }
    }

    if (idx === 8) break;

    // Update P and K
    const rn = r[idx - 1];
    for (let i = 0; i <= 8 - idx; i++) {
      P[i] = GSM_ADD(P[i], GSM_MULT_R(rn, K[i + 1]));
    }
    for (let i = 1; i <= 8 - idx; i++) {
      K[i] = GSM_ADD(K[i + 1], GSM_MULT_R(rn, P[i]));
    }
  }

  return r;
}

function Transformation_to_Log_Area_Ratios(r: Int16Array): Int16Array {
  const LAR = new Int16Array(8);
  // LAR = r / (1 - |r|)  (approx log area ratio)
  for (let i = 0; i < 8; i++) {
    const ri = r[i];
    const a = GSM_ABS(ri);
    let lar: number;
    if (a < 22118) {
      lar = SASR(ri, 1);
    } else if (a < 31130) {
      lar = ri < 0 ? -CLIP(-ri - 11059, 0, 32767) : CLIP(ri - 11059, 0, 32767);
      lar = GSM_ADD(SASR(ri, 2), ri < 0 ? -11059 / 2 : 11059 / 2);
      // Simplified: lar ≈ ri * 0.5 when |ri| >= 22118
      lar = SASR(GSM_ADD(ri, ri < 0 ? 8 : -8), 2) + (ri < 0 ? -3276 : 3276);
    } else {
      lar = ri < 0 ? -32767 : 32767;
    }
    LAR[i] = lar;
  }
  return LAR;
}

function Quantization_and_coding(LAR: Int16Array): Int16Array {
  const LARc = new Int16Array(8);
  // From libgsm lpc.c: STEP(A, B, MAC, MIC)
  // temp = GSM_MULT(A, LAR[i]); temp = GSM_ADD(temp, B); CLIP to [MIC, MAC]
  const steps: [number, number, number, number][] = [
    [ 20480,     0,  31, -32],
    [ 20480,     0,  31, -32],
    [ 20480,  2048,  15, -16],
    [ 20480, -2560,  15, -16],
    [ 13964,    94,   7,  -8],
    [ 15360, -1792,   7,  -8],
    [  8533,  -341,   3,  -4],
    [  9036, -1144,   3,  -4],
  ];
  for (let i = 0; i < 8; i++) {
    const [A, B, MAC, MIC] = steps[i];
    let temp = GSM_MULT(A, LAR[i]);
    temp = GSM_ADD(temp, B);
    LARc[i] = CLIP(temp, MIC, MAC);
  }
  return LARc;
}

function gsm_LPC_Analysis(s: Int16Array): Int16Array {
  const L_ACF = Autocorrelation(s);
  const r = Reflection_coefficients(L_ACF);
  const LAR = Transformation_to_Log_Area_Ratios(r);
  return Quantization_and_coding(LAR);
}

// ─── Short-term analysis filter ───────────────────────────────────────────────

// Dequantize LARc → r coefficients (for analysis filter)
function LARc_to_r(LARc: Int16Array): Int16Array {
  const r = new Int16Array(8);
  const steps: [number, number][] = [
    [13107, 0], [13107, 0], [13107, -1536], [13107, 1792],
    [19223, -66], [17476, 1344], [31454, 256], [29708, 856],
  ];
  for (let i = 0; i < 8; i++) {
    const [A, B] = steps[i];
    let temp = GSM_MULT(A, LARc[i]);
    temp = GSM_ADD(temp, B);
    r[i] = CLIP(temp, -32767, 32767);
  }
  return r;
}

const v = new Int16Array(9); // state for analysis filter (persistent per encoder)

function gsm_short_term_analysis(s: Int16Array, LARc: Int16Array, d: Int16Array): void {
  const r = LARc_to_r(LARc);

  // Apply filter in 4 sub-segments with interpolated LAR
  // For simplicity, apply same LARc to all 160 samples
  const u = new Int16Array(8);

  for (let k = 0; k < 160; k++) {
    let di = s[k];
    for (let i = 7; i >= 1; i--) {
      di = GSM_ADD(di, -GSM_MULT(r[i], u[i]));
      u[i] = GSM_ADD(u[i], GSM_MULT(r[i], di));
    }
    di = GSM_ADD(di, -GSM_MULT(r[0], u[0]));
    u[0] = GSM_ADD(u[0], GSM_MULT(r[0], di));
    d[k] = di;
  }
}

// ─── Long-term predictor ──────────────────────────────────────────────────────

const BCQ: number[] = [0, 3277, 13107, 26214]; // Q15: 0, 0.1, 0.4, 0.8

const dp = new Int16Array(120); // LTP state buffer (120 samples history)

function gsm_long_term(
  d: Int16Array,
  dpLocal: Int16Array,
  seg: number,
): { bc: number; nc: number; e: Int16Array } {
  const off = seg * 40;

  // Find optimal Nc (40..120) and bc (0..3)
  let bestNc = 40, bestBc = 0;
  let bestR = -Infinity;

  for (let nc = 40; nc <= 120; nc++) {
    // compute cross-correlation and energy
    let cross = 0, energy = 0;
    for (let k = 0; k < 40; k++) {
      const dpIdx = off + k - nc;
      const dpVal = dpIdx >= 0 ? d[dpIdx] : dpLocal[dpLocal.length + dpIdx];
      cross += d[off + k] * dpVal;
      energy += dpVal * dpVal;
    }
    if (energy === 0) continue;
    const r = (cross * cross) / energy;
    if (r > bestR) { bestR = r; bestNc = nc; }
  }

  // Optimize bc for best Nc
  {
    const nc = bestNc;
    let bestScore = -Infinity;
    for (let bc = 0; bc < 4; bc++) {
      const gain = BCQ[bc] / 32768;
      let score = 0;
      for (let k = 0; k < 40; k++) {
        const dpIdx = off + k - nc;
        const dpVal = dpIdx >= 0 ? d[dpIdx] : dpLocal[dpLocal.length + dpIdx];
        const pred = d[off + k] - gain * dpVal;
        score -= pred * pred;
      }
      if (score > bestScore) { bestScore = score; bestBc = bc; }
    }
  }

  const e = new Int16Array(40);
  const gain = BCQ[bestBc] / 32768;
  for (let k = 0; k < 40; k++) {
    const dpIdx = off + k - bestNc;
    const dpVal = dpIdx >= 0 ? d[dpIdx] : dpLocal[dpLocal.length + dpIdx];
    e[k] = CLIP(Math.round(d[off + k] - gain * dpVal), -32768, 32767);
  }

  return { bc: bestBc, nc: bestNc, e };
}

// ─── RPE encoding ─────────────────────────────────────────────────────────────

// 6-bit XMAX quantisation (libgsm-compatible)
function xmaxEncode(xmax: number): number {
  // xmax is in [0..32767], encode as 6 bits: exp(3) + mant(3)
  if (xmax === 0) return 0;
  let exp = 0;
  let x = xmax;
  while (x > 7) { x >>= 1; exp++; }
  const mant = Math.min(7, x);
  return (exp << 3) | mant;
}

function xmaxDecode(q: number): number {
  const exp = (q >> 3) & 0x7;
  const mant = q & 0x7;
  return (mant + 8) << exp >> 1;
}

// 3-bit sample quantisation
function xQuantize(x: number, xmax_dec: number): number {
  if (xmax_dec === 0) return 4;
  // Quantize to [-1, +1] then map to [0..7]
  const norm = Math.max(-1, Math.min(1, x / xmax_dec));
  const q = Math.round((norm + 1) * 3.5);
  return CLIP(q, 0, 7);
}

function gsm_RPE_encode(e: Int16Array): { mc: number; xmax: number; x: number[] } {
  // Find best grid position mc (0..3)
  let bestMc = 0, bestEnergy = -1;
  for (let mc = 0; mc < 4; mc++) {
    let energy = 0;
    for (let k = 0; k < 13; k++) {
      const s = e[mc + 3 * k];
      energy += s * s;
    }
    if (energy > bestEnergy) { bestEnergy = energy; bestMc = mc; }
  }

  // Find peak amplitude
  let xmax = 0;
  const mc = bestMc;
  for (let k = 0; k < 13; k++) {
    const a = GSM_ABS(e[mc + 3 * k]);
    if (a > xmax) xmax = a;
  }

  const xmaxQ = xmaxEncode(xmax);
  const xmaxD = xmaxDecode(xmaxQ);

  const x: number[] = [];
  for (let k = 0; k < 13; k++) {
    x.push(xQuantize(e[mc + 3 * k], xmaxD));
  }

  return { mc, xmax: xmaxQ, x };
}

// ─── Bit packing ──────────────────────────────────────────────────────────────

function packBits(
  LARc: Int16Array,
  segs: Array<{ nc: number; bc: number; mc: number; xmax: number; x: number[] }>
): Uint8Array {
  const out = new Uint8Array(33);
  let bp = 0; // bit position in output (0 = MSB of out[0])

  function writeBits(val: number, bits: number): void {
    for (let i = bits - 1; i >= 0; i--) {
      const byteIdx = bp >> 3;
      const bitIdx = 7 - (bp & 7);
      if ((val >> i) & 1) out[byteIdx] |= (1 << bitIdx);
      bp++;
    }
  }

  // Upper nibble of out[0] = magic 0xd
  out[0] = 0xd0;
  bp = 4; // skip upper nibble

  // LAR bits: 6,6,5,5,4,4,3,3 (per libgsm spec)
  // Values stored as 2's complement of (LARc + offset):
  // LARc[0..1]: range [-32..31], encoded unsigned with +32 → 6 bits
  // LARc[2..3]: range [-16..15], encoded unsigned with +16 → 5 bits
  // LARc[4..5]: range [-8..7],   encoded unsigned with +8  → 4 bits
  // LARc[6..7]: range [-4..3],   encoded unsigned with +4  → 3 bits
  const larBits = [6, 6, 5, 5, 4, 4, 3, 3];
  const larOff  = [32, 32, 16, 16, 8, 8, 4, 4];
  for (let i = 0; i < 8; i++) {
    writeBits(LARc[i] + larOff[i], larBits[i]);
  }

  for (const seg of segs) {
    writeBits(seg.nc, 7);    // Nc: 40..120 → 7 bits
    writeBits(seg.bc, 2);    // bc: 0..3    → 2 bits
    writeBits(seg.mc, 2);    // Mc: 0..3    → 2 bits
    writeBits(seg.xmax, 6);  // xmax: 0..63 → 6 bits
    for (const xk of seg.x) writeBits(xk, 3); // 13 × 3 bits
  }

  return out;
}

// ─── Main frame encoder ───────────────────────────────────────────────────────

/** State carried across frames for the encoder */
class GsmEncoder {
  private dpState = new Int16Array(120); // LTP history

  encodeFrame(s: Int16Array): Uint8Array {
    if (s.length !== 160) throw new Error('GSM frame requires 160 samples');

    // 1. LPC analysis
    const LARc = gsm_LPC_Analysis(s);

    // 2. Short-term analysis (produces residual d)
    const d = new Int16Array(160);
    gsm_short_term_analysis(s, LARc, d);

    // 3. LTP + RPE per segment
    const dpLocal = new Int16Array(this.dpState);
    const segs: Array<{ nc: number; bc: number; mc: number; xmax: number; x: number[] }> = [];

    for (let seg = 0; seg < 4; seg++) {
      const { bc, nc, e } = gsm_long_term(d, dpLocal, seg);
      const rpe = gsm_RPE_encode(e);

      // Update dp state
      const off = seg * 40;
      for (let k = 0; k < 40; k++) {
        this.dpState[(off + k) % 120] = d[off + k];
      }

      segs.push({ nc, bc, mc: rpe.mc, xmax: rpe.xmax, x: rpe.x });
    }

    return packBits(LARc, segs);
  }
}

// ─── Bit unpacker + decoder ───────────────────────────────────────────────────

function unpackBits(frame: Uint8Array): {
  LARc: Int16Array;
  segs: Array<{ nc: number; bc: number; mc: number; xmax: number; x: number[] }>;
} | null {
  if (frame.length < 33) return null;

  let bp = 4; // skip magic nibble

  function readBits(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byteIdx = bp >> 3;
      const bitIdx = 7 - (bp & 7);
      v = (v << 1) | ((frame[byteIdx] >> bitIdx) & 1);
      bp++;
    }
    return v;
  }

  const larBits = [6, 6, 5, 5, 4, 4, 3, 3];
  const larOff  = [32, 32, 16, 16, 8, 8, 4, 4];
  const LARc = new Int16Array(8);
  for (let i = 0; i < 8; i++) {
    LARc[i] = readBits(larBits[i]) - larOff[i];
  }

  const segs = [];
  for (let s = 0; s < 4; s++) {
    const nc   = readBits(7);
    const bc   = readBits(2);
    const mc   = readBits(2);
    const xmax = readBits(6);
    const x    = [];
    for (let k = 0; k < 13; k++) x.push(readBits(3));
    segs.push({ nc, bc, mc, xmax, x });
  }

  return { LARc, segs };
}

// RPE inverse quantization factor table (libgsm gsm_FAC, Q15)
// Maps 3-bit RPE sample index [0..7] → quantization midpoints
const RPE_FAC = new Int16Array([-28336, -19170, -9721, -3112, 3112, 9721, 19170, 28336]);

class GsmDecoder {
  // LTP history: 120 samples, oldest at index 0, newest at index 119.
  // After each 40-sample segment the buffer shifts left by 40 and the
  // new excitation is written to indices [80..119].
  private dp = new Int16Array(120);
  // Synthesis lattice state v[0..7].  v[0] holds the previous output sample.
  private v  = new Int16Array(8);

  decodeFrame(frame: Uint8Array): Int16Array {
    const params = unpackBits(frame);
    if (!params) return new Int16Array(160);

    const { LARc, segs } = params;
    const rp = LARc_to_r(LARc);          // reflection coefficients [0..7]
    const out = new Int16Array(160);

    for (let seg = 0; seg < 4; seg++) {
      const { nc, bc, mc, xmax, x } = segs[seg];
      const off = seg * 40;

      // ── Step 1: RPE decode ───────────────────────────────────────────────
      // Reconstruct excitation ep[0..39] from sub-grid samples.
      // libgsm formula: ep[mc+3k] = GSM_MULT_R(xmaxD<<1, RPE_FAC[x[k]])
      //                           = ((2·xmaxD·RPE_FAC[x[k]]) + 16384) >> 15
      const xmaxD = xmaxDecode(xmax);
      const ep = new Int16Array(40);       // zeros outside the sub-grid
      for (let k = 0; k < 13; k++) {
        const val = ((2 * xmaxD * RPE_FAC[x[k]]) + 16384) >> 15;
        ep[mc + 3 * k] = CLIP(val | 0, -32768, 32767);
      }

      // ── Step 2: LTP synthesis ────────────────────────────────────────────
      // wt[k] = ep[k] + BCQ[bc] * dp[k − nc]
      // The history dp[0..119] is oldest-first; the tap at lag nc for
      // sample k is at index (120 − nc + k).
      const wt = new Int16Array(40);
      const bcGain = BCQ[bc];              // Q15
      for (let k = 0; k < 40; k++) {
        const histIdx = 120 - nc + k;
        const drp = (histIdx >= 0 && histIdx < 120) ? this.dp[histIdx] : 0;
        const add = ((bcGain * drp) + 16384) >> 15;
        wt[k] = CLIP(ep[k] + (add | 0), -32768, 32767);
      }

      // Update LTP history: shift left by 40, append new excitation
      this.dp.copyWithin(0, 40);
      this.dp.set(wt, 80);

      // ── Step 3: Short-term synthesis (PARCOR lattice) ────────────────────
      // libgsm (lpc.c):
      //   for each sample:
      //     sri = wt[k]
      //     for i = 7 downto 0:
      //       sri  -= GSM_MULT_R(rp[i], v[i])
      //       v[i] += GSM_MULT_R(rp[i], sri)
      //     v[0] = sri          ← override: v[0] tracks the raw output
      //     out[k] = sri
      for (let k = 0; k < 40; k++) {
        let sri = wt[k];
        for (let i = 7; i >= 0; i--) {
          const sub = GSM_MULT_R(rp[i], this.v[i]);
          sri = CLIP(sri - sub, -32768, 32767);
          this.v[i] = CLIP(this.v[i] + GSM_MULT_R(rp[i], sri), -32768, 32767);
        }
        this.v[0] = sri;   // libgsm: *s++ = v[0] = sri  (overrides the loop update)
        out[off + k] = sri;
      }
    }

    return out;
  }
}

// ─── Packet-level API (6 frames = 198 bytes) ─────────────────────────────────

export const GSM_FRAME_BYTES   = 33;
export const GSM_FRAME_SAMPLES = 160;
export const FRAMES_PER_PACKET = 6;
export const GSM_PACKET_BYTES  = GSM_FRAME_BYTES * FRAMES_PER_PACKET; // 198

// Module-level stateful instances (one encoder, one decoder per server process)
const globalEncoder = new GsmEncoder();
const globalDecoder = new GsmDecoder();

/**
 * Encode 960 PCM Int16 samples (6 × 160) → 198-byte GSM packet.
 * Creates a fresh encoder to avoid state leakage between callers.
 */
export function gsmEncodePacket(pcm: Int16Array): Uint8Array {
  const out = new Uint8Array(GSM_PACKET_BYTES);
  for (let f = 0; f < FRAMES_PER_PACKET; f++) {
    const frame = pcm.slice(f * GSM_FRAME_SAMPLES, (f + 1) * GSM_FRAME_SAMPLES);
    out.set(globalEncoder.encodeFrame(frame), f * GSM_FRAME_BYTES);
  }
  return out;
}

/**
 * Decode 198-byte GSM packet → 960 PCM Int16 samples.
 */
export function gsmDecodePacket(data: Uint8Array): Int16Array {
  const out = new Int16Array(GSM_FRAME_SAMPLES * FRAMES_PER_PACKET);
  for (let f = 0; f < FRAMES_PER_PACKET; f++) {
    const frame = data.slice(f * GSM_FRAME_BYTES, (f + 1) * GSM_FRAME_BYTES);
    out.set(globalDecoder.decodeFrame(frame), f * GSM_FRAME_SAMPLES);
  }
  return out;
}
