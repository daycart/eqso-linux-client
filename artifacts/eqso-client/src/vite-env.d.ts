/// <reference types="vite/client" />

// Web Serial API — available in Chrome/Edge 89+
interface SerialPortInfo {
  usbVendorId?: number;
  usbProductId?: number;
}
interface SerialOutputSignals {
  requestToSend?: boolean;
  dataTerminalReady?: boolean;
  break?: boolean;
}
interface SerialPort {
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  getInfo(): SerialPortInfo;
  setSignals(signals: SerialOutputSignals): Promise<void>;
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
}
interface SerialPortRequestOptions {
  filters?: { usbVendorId?: number; usbProductId?: number }[];
}
interface Serial {
  requestPort(options?: SerialPortRequestOptions): Promise<SerialPort>;
  getPorts(): Promise<SerialPort[]>;
}
interface Navigator {
  readonly serial: Serial;
}

interface ImportMetaEnv {
  readonly BASE_URL: string;
  /**
   * URL completa del servidor API WebSocket.
   * Se usa en builds de GitHub Pages (o cualquier despliegue externo) para
   * apuntar el cliente a un servidor en otro dominio.
   * Ejemplo: wss://mi-servidor.example.com/ws
   * Se configura como secreto VITE_API_WS_URL en GitHub Actions.
   */
  readonly VITE_API_WS_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
