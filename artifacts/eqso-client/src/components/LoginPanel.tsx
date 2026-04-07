import { useState } from "react";

export interface AuthSession {
  token: string;
  callsign: string;
  isRelay: boolean;
}

interface LoginPanelProps {
  onAuth: (session: AuthSession) => void;
}

function getApiBase(): string {
  const base = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
  if (import.meta.env.VITE_API_WS_URL) {
    const wsUrl = new URL(import.meta.env.VITE_API_WS_URL);
    const proto = wsUrl.protocol === "wss:" ? "https:" : "http:";
    return `${proto}//${wsUrl.host}${base}`;
  }
  return `${window.location.protocol}//${window.location.host}${base}`;
}

type Mode = "login" | "register";

export function LoginPanel({ onAuth }: LoginPanelProps) {
  const [mode, setMode] = useState<Mode>("login");
  const [callsign, setCallsign] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isRelay, setIsRelay] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!callsign.trim() || !password) {
      setError("Indicativo y contraseña son obligatorios");
      return;
    }
    if (mode === "register" && password !== confirmPassword) {
      setError("Las contraseñas no coinciden");
      return;
    }

    setLoading(true);
    try {
      const endpoint = mode === "login" ? "/api/auth/login" : "/api/auth/register";
      const body: Record<string, unknown> = { callsign: callsign.trim(), password };
      if (mode === "register") body.isRelay = isRelay;

      const res = await fetch(`${getApiBase()}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Error desconocido");
        return;
      }

      onAuth({ token: data.token, callsign: data.callsign, isRelay: data.isRelay });
    } catch {
      setError("No se pudo conectar con el servidor. Comprueba tu conexion.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-1 items-center justify-center bg-gray-950 p-6">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-green-700 mb-4">
            <svg viewBox="0 0 24 24" fill="currentColor" className="w-8 h-8 text-white">
              <path d="M12 2a5 5 0 1 1 0 10A5 5 0 0 1 12 2zm0 12c5.33 0 8 2.67 8 4v2H4v-2c0-1.33 2.67-4 8-4z"/>
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-gray-100">eQSO Linux</h1>
          <p className="text-sm text-gray-500 mt-1">CB27 / Radio Link</p>
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 shadow-xl">
          <div className="flex mb-6 rounded-lg overflow-hidden border border-gray-700">
            <button
              type="button"
              onClick={() => { setMode("login"); setError(null); }}
              className={`flex-1 py-2 text-sm font-medium transition-colors ${
                mode === "login"
                  ? "bg-green-700 text-white"
                  : "bg-gray-800 text-gray-400 hover:text-gray-200"
              }`}
            >
              Iniciar sesion
            </button>
            <button
              type="button"
              onClick={() => { setMode("register"); setError(null); }}
              className={`flex-1 py-2 text-sm font-medium transition-colors ${
                mode === "register"
                  ? "bg-green-700 text-white"
                  : "bg-gray-800 text-gray-400 hover:text-gray-200"
              }`}
            >
              Registrarse
            </button>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1.5">
                Indicativo
              </label>
              <input
                type="text"
                value={callsign}
                onChange={(e) => setCallsign(e.target.value.toUpperCase())}
                placeholder="Ej: IN60WM, EA1ABC..."
                maxLength={20}
                autoComplete="username"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100
                           placeholder:text-gray-600 focus:outline-none focus:border-green-600 focus:ring-1 focus:ring-green-600
                           font-mono tracking-wide uppercase"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1.5">
                Contrasena
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Contrasena"
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100
                           placeholder:text-gray-600 focus:outline-none focus:border-green-600 focus:ring-1 focus:ring-green-600"
              />
            </div>

            {mode === "register" && (
              <>
                <div>
                  <label className="block text-xs font-medium text-gray-400 mb-1.5">
                    Confirmar contrasena
                  </label>
                  <input
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Repite la contrasena"
                    autoComplete="new-password"
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100
                               placeholder:text-gray-600 focus:outline-none focus:border-green-600 focus:ring-1 focus:ring-green-600"
                  />
                </div>

                <div className="rounded-lg border border-gray-700 p-3 space-y-2">
                  <p className="text-xs font-medium text-gray-400">Tipo de usuario</p>
                  <label className="flex items-start gap-3 cursor-pointer group">
                    <input
                      type="radio"
                      name="userType"
                      checked={!isRelay}
                      onChange={() => setIsRelay(false)}
                      className="mt-0.5 accent-green-600"
                    />
                    <div>
                      <span className="text-sm text-gray-200 font-medium">Usuario normal</span>
                      <p className="text-xs text-gray-500 mt-0.5">
                        Accede a salas sin activar el transmisor RF local.
                      </p>
                    </div>
                  </label>
                  <label className="flex items-start gap-3 cursor-pointer group">
                    <input
                      type="radio"
                      name="userType"
                      checked={isRelay}
                      onChange={() => setIsRelay(true)}
                      className="mt-0.5 accent-green-600"
                    />
                    <div>
                      <span className="text-sm text-gray-200 font-medium">Radio-enlace (0R-)</span>
                      <p className="text-xs text-gray-500 mt-0.5">
                        Activa el transmisor RF via COM port. Prefijo 0R- automatico.
                      </p>
                    </div>
                  </label>
                </div>
              </>
            )}

            {error && (
              <div className="rounded-lg bg-red-950 border border-red-800 px-3 py-2.5">
                <p className="text-sm text-red-300">{error}</p>
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-green-700 hover:bg-green-600 disabled:bg-gray-700 disabled:text-gray-500
                         text-white font-medium py-2.5 rounded-lg text-sm transition-colors mt-2"
            >
              {loading
                ? "Procesando..."
                : mode === "login"
                  ? "Entrar"
                  : "Crear cuenta"}
            </button>
          </form>
        </div>

        <p className="text-center text-xs text-gray-600 mt-4">
          Sistema de radio-enlace CB27 via internet
        </p>
      </div>
    </div>
  );
}
