import { useState } from "react";
import { getHomeServerLabel } from "../lib/homeServer";
import { HomeServerModal } from "./HomeServerModal";

export interface AuthSession {
  token: string;
  callsign: string;
  isRelay: boolean;
  role: "admin" | "user";
}

interface LoginPanelProps {
  onAuth: (session: AuthSession) => void;
}

// Re-export so all existing imports still work
export { getApiBase } from "../lib/homeServer";

type Mode = "login" | "register";

export function LoginPanel({ onAuth }: LoginPanelProps) {
  const [mode, setMode] = useState<Mode>("login");
  const [callsign, setCallsign] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isRelay, setIsRelay] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingMsg, setPendingMsg] = useState<string | null>(null);
  const [showServerModal, setShowServerModal] = useState(false);
  const [serverLabel, setServerLabel] = useState(() => getHomeServerLabel());

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setPendingMsg(null);

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

      // Registration approved → pending
      if (res.status === 202 && data.pending) {
        setPendingMsg(data.message ?? "Registro pendiente de aprobacion por el administrador.");
        setLoading(false);
        return;
      }

      if (!res.ok) {
        setError(data.error ?? "Error desconocido");
        setLoading(false);
        return;
      }

      onAuth({
        token: data.token,
        callsign: data.callsign,
        isRelay: data.isRelay,
        role: data.role ?? "user",
      });
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
          <h1 className="text-2xl font-bold text-gray-100">eQSO ASORAPA</h1>
          <p className="text-sm text-gray-500 mt-1">CB27 / Radio Link</p>
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 shadow-xl">
          <div className="flex mb-6 rounded-lg overflow-hidden border border-gray-700">
            <button
              type="button"
              onClick={() => { setMode("login"); setError(null); setPendingMsg(null); }}
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
              onClick={() => { setMode("register"); setError(null); setPendingMsg(null); }}
              className={`flex-1 py-2 text-sm font-medium transition-colors ${
                mode === "register"
                  ? "bg-green-700 text-white"
                  : "bg-gray-800 text-gray-400 hover:text-gray-200"
              }`}
            >
              Registrarse
            </button>
          </div>

          {pendingMsg ? (
            <div className="text-center py-4">
              <div className="w-12 h-12 rounded-full bg-yellow-900 border border-yellow-700 flex items-center justify-center mx-auto mb-3">
                <svg viewBox="0 0 24 24" fill="currentColor" className="w-6 h-6 text-yellow-400">
                  <path d="M12 2a10 10 0 1 0 0 20A10 10 0 0 0 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
                </svg>
              </div>
              <p className="text-sm text-yellow-300 font-medium mb-1">Solicitud enviada</p>
              <p className="text-xs text-gray-400 leading-relaxed">{pendingMsg}</p>
              <button
                onClick={() => { setPendingMsg(null); setMode("login"); }}
                className="mt-4 text-xs text-green-400 hover:text-green-300 underline"
              >
                Volver al inicio de sesion
              </button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1.5">
                  Indicativo
                </label>
                <input
                  type="text"
                  value={callsign}
                  onChange={(e) => setCallsign(e.target.value.toUpperCase())}
                  placeholder="Ej: 30RCI184, EA1ABC, IN60WM..."
                  maxLength={20}
                  autoComplete="username"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100
                             placeholder:text-gray-600 focus:outline-none focus:border-green-600 focus:ring-1 focus:ring-green-600
                             font-mono tracking-wide uppercase"
                />
                {mode === "register" && (
                  <p className="text-[11px] text-gray-600 mt-1">
                    Indicativos CB (ej: 30RCI184) y radioaficionado (ej: EA1ABC) aceptados.
                  </p>
                )}
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
                    <label className="flex items-start gap-3 cursor-pointer">
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
                    <label className="flex items-start gap-3 cursor-pointer">
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

                  <div className="rounded-lg bg-yellow-950 border border-yellow-800 px-3 py-2.5">
                    <p className="text-xs text-yellow-300">
                      El acceso queda pendiente hasta que el administrador apruebe tu registro.
                    </p>
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
                    : "Solicitar acceso"}
              </button>
            </form>
          )}
        </div>

        {/* Server config button */}
        <button
          onClick={() => setShowServerModal(true)}
          className="mt-4 w-full flex items-center justify-center gap-2 text-xs text-gray-600 hover:text-gray-400 transition-colors py-1"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5">
            <path strokeLinecap="round" strokeLinejoin="round" d="M5.636 5.636a9 9 0 1 0 12.728 12.728M5.636 5.636A9 9 0 0 1 17 6.343M5.636 5.636 3 3m14 3.343 2.364-2.364" />
            <circle cx="12" cy="12" r="3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Servidor: {serverLabel}
        </button>
      </div>

      {showServerModal && (
        <HomeServerModal
          onClose={() => setShowServerModal(false)}
          onSaved={(label) => { setServerLabel(label); setShowServerModal(false); }}
        />
      )}
    </div>
  );
}
