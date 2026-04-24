/**
 * VOX — Voice Operated eXchange
 *
 * Analiza el nivel RMS del audio capturado y emite eventos "ptt_start" / "ptt_end"
 * para abrir/cerrar el canal de transmision automaticamente.
 *
 * Parametros configurables:
 *  - thresholdRms:   nivel minimo de señal para activar (0–32767, defecto 600)
 *  - hangMs:         tiempo que espera en silencio antes de desactivar (defecto 2500ms)
 *  - debounceChunks: chunks CONSECUTIVOS sobre umbral antes de emitir ptt_start
 *                    (1 chunk = 60ms a period=480/8kHz; defecto 5 = 300ms)
 *
 * Por que debounce:
 *   Sin debounce, un click de squelch (~60ms, RMS=12000) dispara ptt_start
 *   igual que 30 segundos de voz. Ese click se manda a la red eQSO como
 *   "transmision" y el receptor lo oye como eco o ruido.
 *   Con debounce=5 (300ms), un click de 60ms se filtra. La voz sostenida
 *   (> 300ms) activa PTT normalmente.
 */

import { EventEmitter } from "events";

export class Vox extends EventEmitter {
  private active = false;
  private hangTimer: ReturnType<typeof setTimeout> | null = null;
  private consecutiveAbove = 0; // chunks consecutivos sobre umbral

  constructor(
    private readonly thresholdRms: number,
    private readonly hangMs: number,
    private readonly debounceChunks: number = 1, // 1 = sin debounce efectivo (ver nota)
  ) {
    super();
  }

  /** Alimentar muestras PCM — llamado por AlsaAudio en cada chunk. */
  processPcm(pcm: Int16Array): void {
    const rms = calcRms(pcm);

    if (rms >= this.thresholdRms) {
      // Señal detectada: cancela el temporizador de hang si estaba activo
      if (this.hangTimer) { clearTimeout(this.hangTimer); this.hangTimer = null; }
      this.consecutiveAbove++;

      if (!this.active && this.consecutiveAbove >= this.debounceChunks) {
        // N chunks consecutivos sobre umbral → activar PTT
        this.active = true;
        this.consecutiveAbove = 0;
        this.emit("ptt_start");
      }
    } else {
      // Señal bajo umbral: resetear contador de debounce
      this.consecutiveAbove = 0;

      if (this.active && !this.hangTimer) {
        // Iniciar temporizador de hang
        this.hangTimer = setTimeout(() => {
          this.hangTimer = null;
          this.active = false;
          this.emit("ptt_end");
        }, this.hangMs);
      }
    }
  }

  /** Forzar PTT activo (control manual desde HTTP). */
  forcePttStart(): void {
    if (this.hangTimer) { clearTimeout(this.hangTimer); this.hangTimer = null; }
    this.consecutiveAbove = 0;
    if (!this.active) { this.active = true; this.emit("ptt_start"); }
  }

  /** Forzar PTT inactivo (control manual desde HTTP). */
  forcePttEnd(): void {
    if (this.hangTimer) { clearTimeout(this.hangTimer); this.hangTimer = null; }
    this.consecutiveAbove = 0;
    if (this.active) { this.active = false; this.emit("ptt_end"); }
  }

  /**
   * Resetear estado interno del VOX sin emitir ptt_end.
   * Usar cuando queremos cancelar un ciclo de activacion bloqueado.
   */
  resetState(): void {
    if (this.hangTimer) { clearTimeout(this.hangTimer); this.hangTimer = null; }
    this.consecutiveAbove = 0;
    this.active = false;
  }

  get isActive(): boolean { return this.active; }
}

function calcRms(pcm: Int16Array): number {
  if (pcm.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) { sum += pcm[i] * pcm[i]; }
  return Math.sqrt(sum / pcm.length);
}
