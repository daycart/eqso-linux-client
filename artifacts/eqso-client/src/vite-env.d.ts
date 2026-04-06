/// <reference types="vite/client" />

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
