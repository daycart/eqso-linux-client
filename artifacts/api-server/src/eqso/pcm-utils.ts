/**
 * Convierte muestras PCM Int16 a Float32 con normalización por pico por paquete.
 *
 * Problema resuelto:
 *   El clamp fijo anterior (±0.45) recortaba duramente los picos del audio CB
 *   (~0.6 float32) causando distorsión severa. La normalización por RMS reducía
 *   el nivel dejándolo demasiado bajo.
 *
 * Algoritmo (normalizador de pico por paquete):
 *   1. Buscar el pico máximo del paquete.
 *   2. Si pico > TARGET_PEAK: escalar todo el paquete para que el pico = TARGET_PEAK.
 *      → mismo nivel que el clamp anterior pero SIN recorte → sin distorsión.
 *   3. Si pico < TARGET_PEAK: amplificar hasta TARGET_PEAK, limitado a MAX_SCALE
 *      para no amplificar el ruido de fondo.
 *   4. MIN_PEAK: umbral de silencio, debajo del cual no se amplifica.
 *
 * Con TARGET_PEAK=0.45 y el GainNode del navegador en ×2:
 *   → Pico de salida = 0.90 FS  (igual al comportamiento anterior, sin distorsión)
 * MAX_SCALE=4.0: amplifica señales débiles (micros web) hasta 4× como máximo.
 * MIN_PEAK=0.005: evita amplificar silencio absoluto / ruido de fondo.
 */
export function pcmToFloat32Normalized(pcm: Int16Array): Float32Array {
  const TARGET_PEAK = 0.45;
  const MAX_SCALE   = 4.0;
  const MIN_PEAK    = 0.005;

  let peak = 0;
  for (let i = 0; i < pcm.length; i++) {
    const abs = Math.abs(pcm[i]) / 32768;
    if (abs > peak) peak = abs;
  }

  const scale = peak > MIN_PEAK ? Math.min(MAX_SCALE, TARGET_PEAK / peak) : 1.0;

  const float32 = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    float32[i] = (pcm[i] / 32768) * scale;
  }
  return float32;
}
