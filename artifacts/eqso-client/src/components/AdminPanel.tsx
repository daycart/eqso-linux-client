import { useState, useEffect, useCallback } from "react";
import { getApiBase } from "./LoginPanel";
import { ServersPanel } from "./ServersPanel";
import { ServerMonitor } from "./ServerMonitor";
import { RelaysPanel } from "./RelaysPanel";

interface AdminUser {
  id: number;
  callsign: string;
  isRelay: boolean;
  status: string;
  role: string;
  createdAt: string;
  lastLogin: string | null;
}

interface AdminPanelProps {
  token: string;
  onClose: () => void;
}

const STATUS_LABEL: Record<string, string> = {
  pending:  "Pendiente",
  active:   "Activo",
  inactive: "Inactivo",
};

const STATUS_COLOR: Record<string, string> = {
  pending:  "bg-yellow-900 text-yellow-300 border-yellow-700",
  active:   "bg-green-900 text-green-300 border-green-700",
  inactive: "bg-gray-800 text-gray-400 border-gray-700",
};

function fmtDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("es-ES", {
    day: "2-digit", month: "2-digit", year: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
}

function authHeaders(token: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

export function AdminPanel({ token, onClose }: AdminPanelProps) {
  const [activeSection, setActiveSection] = useState<"usuarios" | "servidores" | "radioenlaces" | "monitor" | "inactividad">("usuarios");
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionId, setActionId] = useState<number | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({
    callsign: "", password: "", isRelay: false, role: "user",
  });
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState<"all" | "pending" | "active" | "inactive">("all");
  const [resetId, setResetId] = useState<number | null>(null);
  const [resetPw, setResetPw] = useState("");
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);

  // Inactivity section state
  const [inactConfig, setInactConfig] = useState<{
    enabled: boolean; timeoutMinutes: number; audioExists: boolean;
  } | null>(null);
  const [inactTimeout, setInactTimeout] = useState("10");
  const [inactUploading, setInactUploading] = useState(false);
  const [inactTriggerRoom, setInactTriggerRoom] = useState("");
  const [inactMsg, setInactMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${getApiBase()}/api/admin/users`, {
        headers: authHeaders(token),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      setUsers(await res.json());
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Error al cargar usuarios");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  async function setStatus(id: number, status: string) {
    setActionId(id);
    try {
      const res = await fetch(`${getApiBase()}/api/admin/users/${id}/status`, {
        method: "PATCH",
        headers: authHeaders(token),
        body: JSON.stringify({ status }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      await load();
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Error");
    } finally {
      setActionId(null);
    }
  }

  async function setRelay(id: number, isRelay: boolean) {
    setActionId(id);
    try {
      const res = await fetch(`${getApiBase()}/api/admin/users/${id}/relay`, {
        method: "PATCH",
        headers: authHeaders(token),
        body: JSON.stringify({ isRelay }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      await load();
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Error");
    } finally {
      setActionId(null);
    }
  }

  async function setRole(id: number, role: string) {
    setActionId(id);
    try {
      const res = await fetch(`${getApiBase()}/api/admin/users/${id}/role`, {
        method: "PATCH",
        headers: authHeaders(token),
        body: JSON.stringify({ role }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      await load();
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Error");
    } finally {
      setActionId(null);
    }
  }

  async function deleteUser(id: number, callsign: string) {
    if (!confirm(`Eliminar usuario "${callsign}"? Esta accion no se puede deshacer.`)) return;
    setActionId(id);
    try {
      const res = await fetch(`${getApiBase()}/api/admin/users/${id}`, {
        method: "DELETE",
        headers: authHeaders(token),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      await load();
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Error");
    } finally {
      setActionId(null);
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreateError(null);
    if (!createForm.callsign.trim() || !createForm.password) {
      setCreateError("Indicativo y contraseña son obligatorios");
      return;
    }
    setCreating(true);
    try {
      const res = await fetch(`${getApiBase()}/api/admin/users`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({
          callsign: createForm.callsign.trim(),
          password: createForm.password,
          isRelay: createForm.isRelay,
          role: createForm.role,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setCreateError(data.error ?? "Error"); return; }
      setShowCreate(false);
      setCreateForm({ callsign: "", password: "", isRelay: false, role: "user" });
      await load();
    } catch {
      setCreateError("Error de conexion");
    } finally {
      setCreating(false);
    }
  }

  async function handleResetPw(id: number) {
    setResetError(null);
    if (resetPw.length < 4) { setResetError("Minimo 4 caracteres"); return; }
    setResetting(true);
    try {
      const res = await fetch(`${getApiBase()}/api/admin/users/${id}/password`, {
        method: "PATCH",
        headers: authHeaders(token),
        body: JSON.stringify({ password: resetPw }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      setResetId(null);
      setResetPw("");
    } catch (e: unknown) {
      setResetError(e instanceof Error ? e.message : "Error");
    } finally {
      setResetting(false);
    }
  }

  const pendingCount = users.filter(u => u.status === "pending").length;
  const filtered = filter === "all" ? users : users.filter(u => u.status === filter);

  // ── Inactivity helpers ───────────────────────────────────────────────────────

  async function loadInactConfig() {
    try {
      const res = await fetch(`${getApiBase()}/api/admin/inactivity`, { headers: authHeaders(token) });
      if (!res.ok) return;
      const cfg = await res.json();
      setInactConfig(cfg);
      setInactTimeout(String(cfg.timeoutMinutes));
    } catch {}
  }

  async function saveInactConfig(patch: { enabled?: boolean; timeoutMinutes?: number }) {
    setInactMsg(null);
    try {
      const res = await fetch(`${getApiBase()}/api/admin/inactivity`, {
        method: "PATCH",
        headers: authHeaders(token),
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      const cfg = await res.json();
      setInactConfig(cfg);
      setInactMsg("Configuracion guardada.");
    } catch (e: unknown) {
      setInactMsg(e instanceof Error ? e.message : "Error");
    }
  }

  async function uploadInactAudio(file: File) {
    setInactMsg(null);
    setInactUploading(true);
    try {
      const buf = await file.arrayBuffer();
      const res = await fetch(`${getApiBase()}/api/admin/inactivity/audio`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "audio/wav" },
        body: buf,
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      setInactMsg(`Archivo subido correctamente (${Math.round(buf.byteLength / 1024)} KB).`);
      await loadInactConfig();
    } catch (e: unknown) {
      setInactMsg(e instanceof Error ? e.message : "Error al subir archivo");
    } finally {
      setInactUploading(false);
    }
  }

  async function triggerInact() {
    setInactMsg(null);
    try {
      const res = await fetch(`${getApiBase()}/api/admin/inactivity/trigger`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ room: inactTriggerRoom || undefined }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Error");
      if (json.members === 0) {
        setInactMsg(`AVISO: Sala "${json.room}" sin usuarios conectados. Nadie pudo escuchar el anuncio. Únete a la sala desde el panel principal antes de probar.`);
      } else {
        setInactMsg(`Anuncio reproducido en sala "${json.room}" para ${json.members} usuario(s).`);
      }
    } catch (e: unknown) {
      setInactMsg(e instanceof Error ? e.message : "Error");
    }
  }

  return (
    <div className="flex flex-col flex-1 bg-gray-950 overflow-hidden">
      {/* Header */}
      <div className="border-b border-gray-800 px-6 py-4 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-100">Panel de administracion</h2>
          <p className="text-xs text-gray-500 mt-0.5">Gestion del sistema eQSO ASORAPA</p>
        </div>
        <div className="flex items-center gap-3">
          {activeSection === "usuarios" && (
            <button
              onClick={() => setShowCreate(true)}
              className="bg-green-700 hover:bg-green-600 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
            >
              + Nuevo usuario
            </button>
          )}
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-200 text-sm px-3 py-2 rounded-lg hover:bg-gray-800 transition-colors"
          >
            Volver
          </button>
        </div>
      </div>

      {/* Section tabs */}
      <div className="flex gap-1 px-6 pt-4 border-b border-gray-800 pb-0">
        {(["usuarios", "servidores", "radioenlaces", "monitor", "inactividad"] as const).map((sec) => (
          <button
            key={sec}
            onClick={() => {
              setActiveSection(sec);
              if (sec === "inactividad") loadInactConfig();
            }}
            className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-colors capitalize ${
              activeSection === sec
                ? "bg-gray-800 text-green-400 border-b-2 border-green-500"
                : "text-gray-500 hover:text-gray-300 hover:bg-gray-900"
            }`}
          >
            {sec === "usuarios" ? (
              <>
                Usuarios
                {pendingCount > 0 && (
                  <span className="ml-1.5 text-[10px] bg-yellow-700 text-yellow-200 rounded-full px-1.5 py-0.5">
                    {pendingCount}
                  </span>
                )}
              </>
            ) : sec === "servidores" ? "Servidores"
              : sec === "radioenlaces" ? "Radioenlaces"
              : sec === "monitor" ? "Monitor"
              : "Inactividad"}
          </button>
        ))}
      </div>

      {/* Servidores section */}
      {activeSection === "servidores" && (
        <div className="flex-1 overflow-y-auto p-6">
          <ServersPanel token={token} />
        </div>
      )}

      {/* Radioenlaces section */}
      {activeSection === "radioenlaces" && (
        <div className="flex-1 overflow-y-auto p-6">
          <RelaysPanel token={token} />
        </div>
      )}

      {/* Monitor section */}
      {activeSection === "monitor" && (
        <div className="flex-1 overflow-y-auto p-6">
          <ServerMonitor token={token} />
        </div>
      )}

      {/* Inactividad section */}
      {activeSection === "inactividad" && (
        <div className="flex-1 overflow-y-auto p-6 space-y-6 max-w-2xl">
          <div>
            <h3 className="text-sm font-semibold text-gray-200 mb-1">Control de inactividad</h3>
            <p className="text-xs text-gray-500">
              Cuando ninguna estacion transmite durante el tiempo configurado, el servidor reproduce
              automaticamente un mensaje de audio en todas las salas ocupadas.
            </p>
          </div>

          {inactMsg && (
            <p className={`text-xs px-3 py-2 rounded-lg ${
              inactMsg.startsWith("Error") || inactMsg.startsWith("Ya")
                ? "bg-red-950 text-red-300 border border-red-800"
                : "bg-green-950 text-green-300 border border-green-800"
            }`}>
              {inactMsg}
            </p>
          )}

          {inactConfig === null ? (
            <p className="text-xs text-gray-600">Cargando configuracion...</p>
          ) : (
            <>
              {/* Enable / disable */}
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-gray-200">
                    {inactConfig.enabled ? "Activado" : "Desactivado"}
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    El temporizador {inactConfig.enabled ? "esta corriendo" : "esta detenido"}
                  </p>
                </div>
                <button
                  onClick={() => saveInactConfig({ enabled: !inactConfig.enabled })}
                  className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                    inactConfig.enabled
                      ? "bg-red-900 hover:bg-red-800 text-red-200"
                      : "bg-green-800 hover:bg-green-700 text-green-200"
                  }`}
                >
                  {inactConfig.enabled ? "Desactivar" : "Activar"}
                </button>
              </div>

              {/* Timeout input */}
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
                <label className="block text-sm font-medium text-gray-200 mb-3">
                  Tiempo de inactividad (minutos)
                </label>
                <div className="flex gap-3 items-center">
                  <input
                    type="number"
                    min="1"
                    max="120"
                    value={inactTimeout}
                    onChange={(e) => setInactTimeout(e.target.value)}
                    className="w-24 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-green-600"
                  />
                  <span className="text-xs text-gray-500">minutos (actual: {inactConfig.timeoutMinutes})</span>
                  <button
                    onClick={() => saveInactConfig({ timeoutMinutes: Number(inactTimeout) })}
                    className="ml-auto bg-gray-700 hover:bg-gray-600 text-gray-200 text-sm px-4 py-2 rounded-lg transition-colors"
                  >
                    Guardar
                  </button>
                </div>
              </div>

              {/* Audio file */}
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
                <label className="block text-sm font-medium text-gray-200 mb-1">
                  Archivo de audio de anuncio (.wav, 8 kHz mono recomendado)
                </label>
                <p className="text-xs text-gray-500 mb-3">
                  Estado:{" "}
                  <span className={inactConfig.audioExists ? "text-green-400" : "text-yellow-400"}>
                    {inactConfig.audioExists ? "Archivo presente en el servidor" : "Sin archivo — sube uno aqui"}
                  </span>
                </p>
                <label className={`cursor-pointer inline-block px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  inactUploading
                    ? "bg-gray-800 text-gray-500 cursor-not-allowed"
                    : "bg-blue-900 hover:bg-blue-800 text-blue-200"
                }`}>
                  {inactUploading ? "Subiendo..." : "Seleccionar archivo .wav"}
                  <input
                    type="file"
                    accept=".wav,audio/wav,audio/wave"
                    className="hidden"
                    disabled={inactUploading}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) uploadInactAudio(f);
                      e.target.value = "";
                    }}
                  />
                </label>
              </div>

              {/* Test trigger */}
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
                <p className="text-sm font-medium text-gray-200 mb-1">Probar anuncio ahora</p>
                <p className="text-xs text-gray-500 mb-3">Para escuchar el anuncio debes estar conectado y unido a la sala desde el panel principal.</p>
                <div className="flex gap-3 items-center">
                  <input
                    type="text"
                    placeholder="Sala (dejar vacio = primera sala)"
                    value={inactTriggerRoom}
                    onChange={(e) => setInactTriggerRoom(e.target.value)}
                    className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:border-green-600"
                  />
                  <button
                    onClick={triggerInact}
                    disabled={!inactConfig.audioExists}
                    className="bg-orange-900 hover:bg-orange-800 text-orange-200 text-sm px-4 py-2 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    title={inactConfig.audioExists ? "Reproducir ahora" : "Primero sube un archivo de audio"}
                  >
                    Reproducir
                  </button>
                </div>
                {!inactConfig.audioExists && (
                  <p className="text-xs text-yellow-600 mt-2">Sube un archivo .wav para poder probar el anuncio.</p>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {/* Users section — filter tabs + list */}
      {activeSection === "usuarios" && <>
      <div className="flex gap-1 px-6 pt-4">
        {(["all", "pending", "active", "inactive"] as const).map((f) => {
          const label = f === "all" ? "Todos" : STATUS_LABEL[f];
          const cnt = f === "all" ? users.length : users.filter(u => u.status === f).length;
          return (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                filter === f
                  ? "bg-gray-700 text-gray-100"
                  : "text-gray-500 hover:text-gray-300 hover:bg-gray-800"
              }`}
            >
              {label}
              {f === "pending" && cnt > 0 ? (
                <span className="ml-1.5 bg-yellow-600 text-white rounded-full px-1.5 py-0.5 text-[10px]">{cnt}</span>
              ) : (
                <span className="ml-1.5 text-gray-600">{cnt}</span>
              )}
            </button>
          );
        })}
        <button onClick={load} className="ml-auto text-xs text-gray-600 hover:text-gray-400 px-2">
          Actualizar
        </button>
      </div>

      {/* Pending alert */}
      {pendingCount > 0 && filter !== "pending" && (
        <div
          className="mx-6 mt-3 rounded-lg bg-yellow-950 border border-yellow-800 px-4 py-2.5 flex items-center gap-2 cursor-pointer"
          onClick={() => setFilter("pending")}
        >
          <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4 text-yellow-400 shrink-0">
            <path d="M12 2a10 10 0 1 0 0 20A10 10 0 0 0 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
          </svg>
          <p className="text-xs text-yellow-300">
            {pendingCount} solicitud{pendingCount > 1 ? "es" : ""} pendiente{pendingCount > 1 ? "s" : ""} de aprobacion
          </p>
          <span className="ml-auto text-xs text-yellow-600 underline">Ver</span>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {loading && (
          <div className="text-center py-12 text-gray-600 text-sm">Cargando usuarios...</div>
        )}
        {error && (
          <div className="rounded-lg bg-red-950 border border-red-800 px-4 py-3 text-sm text-red-300">{error}</div>
        )}
        {!loading && !error && filtered.length === 0 && (
          <div className="text-center py-12 text-gray-600 text-sm">No hay usuarios en esta categoria.</div>
        )}

        {!loading && !error && filtered.length > 0 && (
          <div className="space-y-2">
            {filtered.map((u) => (
              <div
                key={u.id}
                className={`rounded-xl border p-4 ${
                  u.status === "pending"
                    ? "border-yellow-800 bg-yellow-950/30"
                    : "border-gray-800 bg-gray-900"
                }`}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono font-bold text-gray-100 text-sm">{u.callsign}</span>
                      <span className={`text-[10px] border rounded px-1.5 py-0.5 ${STATUS_COLOR[u.status] ?? "bg-gray-800 text-gray-400"}`}>
                        {STATUS_LABEL[u.status] ?? u.status}
                      </span>
                      {u.isRelay && (
                        <span className="text-[10px] border border-orange-700 bg-orange-900 text-orange-300 rounded px-1.5 py-0.5">
                          radioenlace
                        </span>
                      )}
                      {u.role === "admin" && (
                        <span className="text-[10px] border border-blue-700 bg-blue-900 text-blue-300 rounded px-1.5 py-0.5">
                          admin
                        </span>
                      )}
                      {!u.isRelay && u.role !== "admin" && (
                        <span className="text-[10px] border border-green-800 bg-green-950 text-green-400 rounded px-1.5 py-0.5">
                          usuario
                        </span>
                      )}
                    </div>
                    <div className="flex gap-4 mt-1.5 text-[11px] text-gray-600">
                      <span>Alta: {fmtDate(u.createdAt)}</span>
                      <span>Ultimo acceso: {fmtDate(u.lastLogin)}</span>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1.5 shrink-0 flex-wrap justify-end">
                    {u.status === "pending" && (
                      <button
                        onClick={() => setStatus(u.id, "active")}
                        disabled={actionId === u.id}
                        className="bg-green-700 hover:bg-green-600 text-white text-xs px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50"
                      >
                        Aprobar
                      </button>
                    )}
                    {u.status === "active" && (
                      <button
                        onClick={() => setStatus(u.id, "inactive")}
                        disabled={actionId === u.id}
                        className="bg-gray-700 hover:bg-gray-600 text-gray-200 text-xs px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50"
                      >
                        Desactivar
                      </button>
                    )}
                    {u.status === "inactive" && (
                      <button
                        onClick={() => setStatus(u.id, "active")}
                        disabled={actionId === u.id}
                        className="bg-green-800 hover:bg-green-700 text-green-200 text-xs px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50"
                      >
                        Reactivar
                      </button>
                    )}
                    <button
                      onClick={() => setRelay(u.id, !u.isRelay)}
                      disabled={actionId === u.id}
                      className={`text-xs px-2.5 py-1.5 rounded-lg transition-colors disabled:opacity-50 ${
                        u.isRelay
                          ? "bg-orange-900 hover:bg-orange-800 text-orange-200"
                          : "bg-gray-800 hover:bg-gray-700 text-gray-300"
                      }`}
                      title={u.isRelay ? "Convertir en usuario normal" : "Convertir en radio-enlace (0R-)"}
                    >
                      {u.isRelay ? "Quitar enlace" : "Hacer enlace"}
                    </button>
                    <button
                      onClick={() => setRole(u.id, u.role === "admin" ? "user" : "admin")}
                      disabled={actionId === u.id}
                      className="bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs px-2.5 py-1.5 rounded-lg transition-colors disabled:opacity-50"
                      title={u.role === "admin" ? "Quitar admin" : "Hacer admin"}
                    >
                      {u.role === "admin" ? "Quitar admin" : "Hacer admin"}
                    </button>
                    <button
                      onClick={() => { setResetId(u.id); setResetPw(""); setResetError(null); }}
                      disabled={actionId === u.id}
                      className="bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs px-2.5 py-1.5 rounded-lg transition-colors disabled:opacity-50"
                      title="Cambiar contrasena"
                    >
                      Contrasena
                    </button>
                    <button
                      onClick={() => deleteUser(u.id, u.callsign)}
                      disabled={actionId === u.id}
                      className="bg-red-950 hover:bg-red-900 text-red-300 text-xs px-2.5 py-1.5 rounded-lg transition-colors disabled:opacity-50"
                      title="Eliminar usuario"
                    >
                      Eliminar
                    </button>
                  </div>
                </div>

                {/* Password reset inline */}
                {resetId === u.id && (
                  <div className="mt-3 pt-3 border-t border-gray-700 flex items-center gap-2">
                    <input
                      type="password"
                      value={resetPw}
                      onChange={(e) => setResetPw(e.target.value)}
                      placeholder="Nueva contrasena (min 4)"
                      className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-100
                                 placeholder:text-gray-600 focus:outline-none focus:border-green-600"
                    />
                    <button
                      onClick={() => handleResetPw(u.id)}
                      disabled={resetting}
                      className="bg-green-700 hover:bg-green-600 text-white text-xs px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50"
                    >
                      Guardar
                    </button>
                    <button
                      onClick={() => { setResetId(null); setResetPw(""); setResetError(null); }}
                      className="text-gray-500 hover:text-gray-300 text-xs px-2 py-1.5"
                    >
                      Cancelar
                    </button>
                    {resetError && <span className="text-xs text-red-400">{resetError}</span>}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      </>}

      {/* Create user modal */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 w-full max-w-sm shadow-2xl">
            <h3 className="text-base font-semibold text-gray-100 mb-4">Crear usuario</h3>
            <form onSubmit={handleCreate} className="space-y-3">
              <div>
                <label className="block text-xs text-gray-400 mb-1">Indicativo</label>
                <input
                  type="text"
                  value={createForm.callsign}
                  onChange={(e) => setCreateForm(f => ({ ...f, callsign: e.target.value.toUpperCase() }))}
                  placeholder="Ej: 30RCI184, EA1ABC..."
                  maxLength={20}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100
                             font-mono uppercase placeholder:text-gray-600 focus:outline-none focus:border-green-600"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Contrasena</label>
                <input
                  type="password"
                  value={createForm.password}
                  onChange={(e) => setCreateForm(f => ({ ...f, password: e.target.value }))}
                  placeholder="Contrasena"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100
                             placeholder:text-gray-600 focus:outline-none focus:border-green-600"
                />
              </div>
              <div className="flex gap-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={createForm.isRelay}
                    onChange={(e) => setCreateForm(f => ({ ...f, isRelay: e.target.checked }))}
                    className="accent-green-600"
                  />
                  <span className="text-xs text-gray-300">Radio-enlace (0R-)</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={createForm.role === "admin"}
                    onChange={(e) => setCreateForm(f => ({ ...f, role: e.target.checked ? "admin" : "user" }))}
                    className="accent-blue-600"
                  />
                  <span className="text-xs text-gray-300">Administrador</span>
                </label>
              </div>
              {createError && (
                <p className="text-xs text-red-400">{createError}</p>
              )}
              <div className="flex gap-2 pt-1">
                <button
                  type="submit"
                  disabled={creating}
                  className="flex-1 bg-green-700 hover:bg-green-600 text-white text-sm font-medium py-2 rounded-lg transition-colors disabled:opacity-50"
                >
                  {creating ? "Creando..." : "Crear"}
                </button>
                <button
                  type="button"
                  onClick={() => { setShowCreate(false); setCreateError(null); }}
                  className="flex-1 bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm py-2 rounded-lg transition-colors"
                >
                  Cancelar
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
