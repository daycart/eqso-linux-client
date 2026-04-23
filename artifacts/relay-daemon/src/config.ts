import fs from "fs";
import path from "path";

export interface AudioConfig {
  captureDevice: string;
  playbackDevice: string;
  vox: boolean;
  voxThresholdRms: number;
  voxHangMs: number;
  /** Gate de TX: RMS mínimo para enviar un paquete durante el VOX hang.
   *  0 = sin gate (envía todo durante VOX active). Por defecto 50 (elimina
   *  silencio absoluto sin cortar voz suave). */
  txGateRms: number;
  inputGain: number;
  outputGain: number;
}

export interface ControlConfig {
  enabled: boolean;
  port: number;
  host: string;
}

export interface PttSerialConfig {
  device:   string;          // "/dev/ttyACM0" o "" para deshabilitar
  method:   "rts" | "dtr";  // pin que controla el PTT de la radio
  inverted: boolean;         // true si el circuito invierte la logica
}

export interface RelayConfig {
  callsign: string;
  room: string;
  password: string;
  message: string;
  server: string;
  port: number;
  reconnectMinMs: number;
  reconnectMaxMs: number;
  audio: AudioConfig;
  control: ControlConfig;
  ptt: PttSerialConfig;
}

const DEFAULTS: RelayConfig = {
  callsign: "0R-IN70WN",
  room: "CB",
  password: "",
  message: "Radio Enlace",
  server: "127.0.0.1",
  port: 2171,
  reconnectMinMs: 2000,
  reconnectMaxMs: 60000,
  audio: {
    captureDevice: "plughw:1,0",
    playbackDevice: "plughw:1,0",
    vox: true,
    voxThresholdRms: 600,
    voxHangMs: 2500,
    txGateRms: 50,
    inputGain: 1.0,
    outputGain: 3.0,
  },
  control: {
    enabled: true,
    port: 8009,
    host: "127.0.0.1",
  },
  ptt: {
    device:   "/dev/ttyACM0",
    method:   "rts",
    inverted: false,
  },
};

function deepMerge<T>(base: T, override: Partial<T>): T {
  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const key of Object.keys(override as Record<string, unknown>)) {
    const val = (override as Record<string, unknown>)[key];
    const baseVal = (base as Record<string, unknown>)[key];
    if (val !== null && typeof val === "object" && !Array.isArray(val) &&
        baseVal !== null && typeof baseVal === "object") {
      result[key] = deepMerge(baseVal, val as Partial<unknown>);
    } else if (val !== undefined) {
      result[key] = val;
    }
  }
  return result as T;
}

export function loadConfig(): RelayConfig {
  const instance = process.env["RELAY_INSTANCE"] || "CB";
  const configFile =
    process.env["CONFIG_FILE"] ??
    `/etc/eqso-relay/${instance}.json`;

  let fromFile: Partial<RelayConfig> = {};
  if (fs.existsSync(configFile)) {
    try {
      fromFile = JSON.parse(fs.readFileSync(configFile, "utf8")) as Partial<RelayConfig>;
      console.log(`[config] Cargado: ${configFile}`);
    } catch (err) {
      console.error(`[config] Error al leer ${configFile}:`, err);
    }
  } else {
    console.warn(`[config] Archivo no encontrado: ${configFile} — usando valores por defecto`);
  }

  const merged = deepMerge<RelayConfig>(DEFAULTS, fromFile);

  // Env var overrides (useful for Docker / CI)
  if (process.env["RELAY_CALLSIGN"]) merged.callsign = process.env["RELAY_CALLSIGN"];
  if (process.env["RELAY_ROOM"])     merged.room     = process.env["RELAY_ROOM"];
  if (process.env["RELAY_PASSWORD"]) merged.password = process.env["RELAY_PASSWORD"];
  if (process.env["RELAY_SERVER"])   merged.server   = process.env["RELAY_SERVER"];
  if (process.env["RELAY_PORT"])     merged.port     = parseInt(process.env["RELAY_PORT"], 10);
  if (process.env["CONTROL_PORT"])   merged.control.port = parseInt(process.env["CONTROL_PORT"], 10);

  console.log("[config] Configuracion activa:", JSON.stringify(merged, null, 2));
  return merged;
}
