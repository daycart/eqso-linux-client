import { useState } from "react";
import {
  getStoredHomeServerUrl,
  setHomeServerUrl,
  clearHomeServerUrl,
  getApiBase,
  getHomeServerLabel,
} from "../lib/homeServer";

interface Props {
  onClose: () => void;
  onSaved: (label: string) => void;
}

export function HomeServerModal({ onClose, onSaved }: Props) {
  const defaultPlaceholder = `${window.location.protocol}//${window.location.host}`;
  const [url, setUrl] = useState(getStoredHomeServerUrl() ?? "");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);

  function normalise(raw: string): string {
    let u = raw.trim().replace(/\/$/, "");
    if (u && !u.startsWith("http://") && !u.startsWith("https://")) {
      u = "https://" + u;
    }
    return u;
  }

  async function handleTest() {
    const target = normalise(url) || defaultPlaceholder;
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch(`${target}/health`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        setTestResult({ ok: true, msg: `Servidor OK${data.version ? ` — v${data.version}` : ""}` });
      } else {
        setTestResult({ ok: false, msg: `HTTP ${res.status} — servidor no compatible` });
      }
    } catch (e: unknown) {
      const err = e instanceof Error ? e.message : String(e);
      setTestResult({ ok: false, msg: `Sin respuesta: ${err}` });
    } finally {
      setTesting(false);
    }
  }

  function handleSave() {
    const norm = normalise(url);
    if (norm) {
      setHomeServerUrl(norm);
    } else {
      clearHomeServerUrl();
    }
    onSaved(getHomeServerLabel());
  }

  function handleClear() {
    setUrl("");
    clearHomeServerUrl();
    onSaved(getHomeServerLabel());
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl w-full max-w-md">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800">
          <div>
            <h2 className="text-base font-semibold text-gray-100">Servidor home</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Servidor eQSO ASORAPA donde te autenticas y conectas
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-300 transition-colors p-1"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-5 h-5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-4">
          {/* Info box */}
          <div className="rounded-lg bg-gray-800/60 border border-gray-700 px-4 py-3 text-xs text-gray-400 leading-relaxed space-y-1">
            <p>
              El servidor home proporciona autenticacion de usuarios, gestion administrativa
              y el puente WebSocket para audio local.
            </p>
            <p className="text-gray-500">
              Deja en blanco para usar el mismo servidor que sirve esta pagina
              (<span className="font-mono text-gray-400">{window.location.host}</span>).
            </p>
          </div>

          {/* URL input */}
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1.5">
              URL del servidor
            </label>
            <input
              type="text"
              value={url}
              onChange={(e) => { setUrl(e.target.value); setTestResult(null); }}
              placeholder={defaultPlaceholder}
              spellCheck={false}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5
                         text-sm text-gray-100 font-mono placeholder-gray-600
                         focus:outline-none focus:border-green-600 focus:ring-1 focus:ring-green-700
                         transition-colors"
            />
            <p className="mt-1.5 text-xs text-gray-600">
              Ej: <span className="font-mono">https://eqso.example.com</span> o
              {" "}<span className="font-mono">http://192.168.1.10:8080</span>
            </p>
          </div>

          {/* Test result */}
          {testResult && (
            <div className={`rounded-lg px-4 py-2.5 text-xs ${
              testResult.ok
                ? "bg-green-950 border border-green-800 text-green-300"
                : "bg-red-950 border border-red-800 text-red-300"
            }`}>
              {testResult.msg}
            </div>
          )}

          {/* Current active server */}
          <div className="text-xs text-gray-600">
            Activo ahora: <span className="font-mono text-gray-500">{getApiBase()}</span>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center gap-2 px-6 pb-5">
          <button
            onClick={handleTest}
            disabled={testing}
            className="flex-none px-4 py-2 rounded-lg text-sm font-medium bg-gray-800 hover:bg-gray-700
                       text-gray-300 border border-gray-700 transition-colors disabled:opacity-50"
          >
            {testing ? "Probando..." : "Probar conexion"}
          </button>

          <div className="flex-1" />

          {(getStoredHomeServerUrl()) && (
            <button
              onClick={handleClear}
              className="px-3 py-2 rounded-lg text-xs text-gray-500 hover:text-red-400
                         hover:bg-red-950/30 transition-colors"
            >
              Restaurar por defecto
            </button>
          )}

          <button
            onClick={handleSave}
            className="px-5 py-2 rounded-lg text-sm font-medium bg-green-700 hover:bg-green-600
                       text-white transition-colors"
          >
            Guardar
          </button>
        </div>
      </div>
    </div>
  );
}
