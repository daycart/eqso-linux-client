/**
 * Convierte muestras PCM Int16 a Float32 con normalización por paquete.
 *
 * Por qué es necesario:
 *   - Los clientes web transmiten a ~-19 dBFS (RMS≈0.04 float32).
 *   - El daemon de radioenlace captura la radio CB a niveles más altos
 *     (~-7 dBFS RMS después de gain). Con el antiguo clamp fijo en ±0.45
 *     se recortaban duramente las cimas → distorsión severa en el navegador.
 *
 * Algoritmo (AGC suave por paquete):
 *   1. Calcular RMS del paquete.
 *   2. Si RMS > MIN_RMS: aplicar escala para alcanzar TARGET_RMS
 *      (limitado a MAX_SCALE para no amplificar el ruido de fondo).
 *   3. Limitar a ±1.0 como red de seguridad.
 *
 * Con TARGET_RMS=0.15 y el GainNode del navegador en ×2:
 *   → RMS de salida = 0.30 ≈ -10 dBFS. Volumen cómodo para escuchar.
 * MAX_SCALE=4.0: limita la amplificación de señales muy débiles.
 * MIN_RMS=0.003: umbral de silencio (no amplificar el suelo de ruido).
 */
export function pcmToFloat32Normalized(pcm: Int16Array): Float32Array {
  const TARGET_RMS = 0.15;
  const MAX_SCALE  = 4.0;
  const MIN_RMS    = 0.003;

  let sumSq = 0;
  for (let i = 0; i < pcm.length; i++) {
    const s = pcm[i] / 32768;
    sumSq += s * s;
  }
  const rms = pcm.length > 0 ? Math.sqrt(sumSq / pcm.length) : 0;
  const scale = rms > MIN_RMS ? Math.min(MAX_SCALE, TARGET_RMS / rms) : 1.0;

  const float32 = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    float32[i] = Math.max(-1, Math.min(1, (pcm[i] / 32768) * scale));
  }
  return float32;
}
