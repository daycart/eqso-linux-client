/**
 * VOX — Voice Operated eXchange
 *
 * Analiza el nivel RMS del audio capturado y emite eventos "ptt_start" / "ptt_end"
 * para abrir/cerrar el canal de transmision automaticamente.
 *
 * Parametros configurables:
 *  - thresholdRms: nivel minimo de señal para activar (0–32767, defecto 800)
 *  - hangMs:       tiempo que espera en silencio antes de desactivar (defecto 1000 ms)
 */

import { EventEmitter } from "events";

export class Vox extends EventEmitter {
  private active = false;
  private hangTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly thresholdRms: number,
    private readonly hangMs: number,
  ) {
    super();
  }

  /** Alimentar muestras PCM — llamado por AlsaAudio en cada chunk. */
  processPcm(pcm: Int16Array): void {
    const rms = calcRms(pcm);

    if (rms >= this.thresholdRms) {
      // Señal detectada: cancela el temporizador de hang si estaba activo
      if (this.hangTimer) { clearTimeout(this.hangTimer); this.hangTimer = null; }
      if (!this.active) {
        this.active = true;
        this.emit("ptt_start");
      }
    } else if (this.active && !this.hangTimer) {
      // Silencio — iniciar temporizador de hang
      this.hangTimer = setTimeout(() => {
        this.hangTimer = null;
        this.active = false;
        this.emit("ptt_end");
      }, this.hangMs);
    }
  }

  /** Forzar PTT activo (control manual desde HTTP). */
  forcePttStart(): void {
    if (this.hangTimer) { clearTimeout(this.hangTimer); this.hangTimer = null; }
    if (!this.active) { this.active = true; this.emit("ptt_start"); }
  }

  /** Forzar PTT inactivo (control manual desde HTTP). */
  forcePttEnd(): void {
    if (this.hangTimer) { clearTimeout(this.hangTimer); this.hangTimer = null; }
    if (this.active) { this.active = false; this.emit("ptt_end"); }
  }

  get isActive(): boolean { return this.active; }
}

function calcRms(pcm: Int16Array): number {
  if (pcm.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) { sum += pcm[i] * pcm[i]; }
  return Math.sqrt(sum / pcm.length);
}
