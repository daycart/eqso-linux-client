const LS_KEY = "home_server_url";

/**
 * Returns the stored home server URL (stripped of trailing slash),
 * or null if using the same-host default.
 */
export function getStoredHomeServerUrl(): string | null {
  try {
    const v = localStorage.getItem(LS_KEY);
    return v ? v.replace(/\/$/, "") : null;
  } catch {
    return null;
  }
}

export function setHomeServerUrl(url: string): void {
  try {
    localStorage.setItem(LS_KEY, url.replace(/\/$/, ""));
  } catch { /* ignore */ }
}

export function clearHomeServerUrl(): void {
  try {
    localStorage.removeItem(LS_KEY);
  } catch { /* ignore */ }
}

/**
 * HTTP base for API calls — e.g. https://servidor.example.com
 * Respects VITE_API_WS_URL build var, then localStorage, then same-host default.
 */
export function getApiBase(): string {
  const pathBase = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

  // 1. Build-time override
  if (import.meta.env.VITE_API_WS_URL) {
    const wsUrl = new URL(import.meta.env.VITE_API_WS_URL);
    const proto = wsUrl.protocol === "wss:" ? "https:" : "http:";
    return `${proto}//${wsUrl.host}${pathBase}`;
  }

  // 2. Runtime localStorage config
  const stored = getStoredHomeServerUrl();
  if (stored) {
    return stored; // already includes any path prefix the user typed
  }

  // 3. Same-host default
  return `${window.location.protocol}//${window.location.host}${pathBase}`;
}

/**
 * WebSocket URL — e.g. wss://servidor.example.com/ws
 */
export function getWsUrl(): string {
  const pathBase = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

  // 1. Build-time override
  if (import.meta.env.VITE_API_WS_URL) {
    return import.meta.env.VITE_API_WS_URL as string;
  }

  // 2. Runtime localStorage config
  const stored = getStoredHomeServerUrl();
  if (stored) {
    const u = new URL(stored);
    const wsp = u.protocol === "https:" ? "wss:" : "ws:";
    return `${wsp}//${u.host}${u.pathname.replace(/\/$/, "")}${pathBase}/ws`;
  }

  // 3. Same-host default
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}${pathBase}/ws`;
}

/**
 * Human-readable label for the current home server.
 */
export function getHomeServerLabel(): string {
  const stored = getStoredHomeServerUrl();
  if (stored) {
    try { return new URL(stored).host; } catch { return stored; }
  }
  return window.location.host;
}
