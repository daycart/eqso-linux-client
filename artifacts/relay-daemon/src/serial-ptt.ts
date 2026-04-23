/**
 * PTT serial via proceso Python3 persistente.
 *
 * Abre /dev/ttyACM0 (u otro dispositivo) y escribe "1\n" / "0\n" en el
 * stdin del helper Python para activar/desactivar el pin RTS (o DTR).
 * No requiere paquetes npm nativos — solo Python 3 stdlib.
 *
 * Si el dispositivo esta vacio o Python3 no esta disponible, opera en
 * modo no-op (solo advertencia en log).
 */

import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import { EventEmitter } from "events";
import { fileURLToPath } from "url";
import path from "path";

export interface SerialPttConfig {
  device:   string;           // "/dev/ttyACM0" o "" para deshabilitar
  method:   "rts" | "dtr";   // que pin controla PTT
  inverted: boolean;          // true si el circuito invierte la logica
}

export class SerialPtt extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private ready       = false;
  private enabled     = false;
  private pendingCmd: "0" | "1" | null = null;

  constructor(private cfg: SerialPttConfig) {
    super();
    this.enabled = Boolean(cfg.device);
  }

  start(): void {
    if (!this.enabled || this.proc) return;

    // El helper Python esta junto al .mjs en dist/
    const helperPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "ptt-helper.py"
    );

    log(`Iniciando PTT serial: ${this.cfg.device} (${this.cfg.method})`);

    this.proc = spawn("python3", [
      helperPath,
      this.cfg.device,
      this.cfg.method,
      String(this.cfg.inverted),
    ], { stdio: ["pipe", "pipe", "pipe"] });

    this.proc.stdout.on("data", (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg === "ready") {
        this.ready = true;
        log(`PTT serial listo (${this.cfg.device}, ${this.cfg.method})`);
        if (this.pendingCmd !== null) {
          this._write(this.pendingCmd);
          this.pendingCmd = null;
        }
      }
    });

    this.proc.stderr.on("data", (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) log(`[ptt-helper] ${msg}`);
    });

    this.proc.on("error", (err) => {
      log(`PTT serial: no se pudo iniciar python3 — ${err.message}. PTT serial deshabilitado.`);
      this.proc  = null;
      this.ready = false;
    });

    this.proc.on("close", (code) => {
      log(`PTT serial: proceso terminado (code ${code})`);
      this.proc  = null;
      this.ready = false;
    });
  }

  /** Activar (true) o desactivar (false) el PTT. */
  set(active: boolean): void {
    const cmd = active ? "1" : "0";
    if (!this.enabled) {
      log(`PTT set(${active}) ignorado — PTT serial deshabilitado (device vacio en config)`);
      return;
    }
    if (!this.ready) {
      log(`PTT set(${active}) → pendingCmd=${cmd} (helper no listo aun)`);
      this.pendingCmd = cmd;
      return;
    }
    log(`PTT set(${active}) → escribiendo "${cmd}" al helper`);
    this._write(cmd);
  }

  stop(): void {
    if (this.proc) {
      try { this._write("0"); } catch { /* ignore */ }
      try { this.proc.stdin.end(); this.proc.kill("SIGTERM"); } catch { /* ignore */ }
    }
    this.proc  = null;
    this.ready = false;
  }

  private _write(cmd: string): void {
    try { this.proc?.stdin.write(cmd + "\n"); } catch { /* ignore */ }
  }
}

function log(msg: string): void {
  console.log(`[ptt] ${new Date().toISOString()} ${msg}`);
}
