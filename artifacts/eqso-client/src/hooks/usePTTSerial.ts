/**
 * usePTTSerial — Web Serial API hook for PTT keying via RTS/DTR.
 *
 * Supports:
 *   - Puerto COM (Web Serial API — Chrome/Edge on Linux)
 *   - VOX mode (no serial, PTT is purely audio-triggered)
 *   - Pin: RTS or DTR
 *   - Invertir voltaje (inverted logic)
 *
 * Settings are persisted in localStorage under "ptt_config".
 */

import { useState, useCallback, useRef, useEffect } from "react";

export type PTTMethod = "COM" | "VOX";
export type PTTPin = "RTS" | "DTR";

export interface PTTConfig {
  method: PTTMethod;
  pin: PTTPin;
  invertVoltage: boolean;
  /** Human-readable port label stored after the user selects a port */
  portLabel: string;
}

const STORAGE_KEY = "ptt_config";

const DEFAULT_CONFIG: PTTConfig = {
  method: "VOX",
  pin: "RTS",
  invertVoltage: false,
  portLabel: "",
};

function loadConfig(): PTTConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_CONFIG };
}

function saveConfig(cfg: PTTConfig) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
}

export function usePTTSerial() {
  const [config, setConfigState] = useState<PTTConfig>(loadConfig);
  const [portOpen, setPortOpen] = useState(false);
  const [portError, setPortError] = useState<string | null>(null);
  const portRef = useRef<SerialPort | null>(null);
  const isSupported = "serial" in navigator;

  const setConfig = useCallback((cfg: PTTConfig) => {
    setConfigState(cfg);
    saveConfig(cfg);
  }, []);

  /* Close any open port on unmount */
  useEffect(() => {
    return () => {
      portRef.current?.close().catch(() => {});
    };
  }, []);

  /**
   * Ask the browser to pick a serial port and open it.
   * Returns true on success, false on failure.
   */
  const requestPort = useCallback(async (): Promise<boolean> => {
    if (!isSupported) {
      setPortError("Web Serial API no disponible (usa Chrome o Edge)");
      return false;
    }
    try {
      const port = await navigator.serial.requestPort();
      await portRef.current?.close().catch(() => {});
      await port.open({ baudRate: 9600 });
      portRef.current = port;
      setPortOpen(true);
      setPortError(null);

      const info = port.getInfo();
      const label =
        info.usbVendorId
          ? `Puerto USB (vid:${info.usbVendorId.toString(16)})`
          : "Puerto serie seleccionado";
      return true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("No port selected")) {
        setPortError(`Error al abrir puerto: ${msg}`);
      }
      setPortOpen(false);
      return false;
    }
  }, [isSupported]);

  /**
   * Close the open port.
   */
  const closePort = useCallback(async () => {
    if (portRef.current) {
      await portRef.current.close().catch(() => {});
      portRef.current = null;
      setPortOpen(false);
    }
  }, []);

  /**
   * Key the transmitter DOWN (PTT active).
   */
  const keyDown = useCallback(async () => {
    if (config.method !== "COM" || !portRef.current) return;
    const active = !config.invertVoltage;
    try {
      if (config.pin === "RTS") {
        await portRef.current.setSignals({ requestToSend: active });
      } else {
        await portRef.current.setSignals({ dataTerminalReady: active });
      }
    } catch {
      /* port may have been disconnected */
    }
  }, [config]);

  /**
   * Release the transmitter (PTT off).
   */
  const keyUp = useCallback(async () => {
    if (config.method !== "COM" || !portRef.current) return;
    const idle = config.invertVoltage;
    try {
      if (config.pin === "RTS") {
        await portRef.current.setSignals({ requestToSend: idle });
      } else {
        await portRef.current.setSignals({ dataTerminalReady: idle });
      }
    } catch {
      /* port may have been disconnected */
    }
  }, [config]);

  return {
    config,
    setConfig,
    isSupported,
    portOpen,
    portError,
    requestPort,
    closePort,
    keyDown,
    keyUp,
  };
}
