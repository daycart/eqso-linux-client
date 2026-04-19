import { useState, useEffect, useCallback } from "react";
import { getApiBase } from "./LoginPanel";

interface RelayStatus {
  id: number;
  label: string;
  callsign: string;
  server: string;
  port: number;
  room: string;
  localRoom: string;
  enabled: boolean;
  status: "connecting" | "connected" | "disconnected" | "stopped";
  connectedAt: number | null;
  rxPackets: number;
  usersInRoom: string[];
}

interface RelaysPanelProps {
  token: string;
}

const STATUS_DOT: Record<string, string> = {
  connected:    "bg-green-500",
  connecting:   "bg-yellow-400 animate-pulse",
  disconnected: "bg-red-500",
  stopped:      "bg-gray-600",
};

const STATUS_LABEL: Record<string, string> = {
  connected:    "Conectado",
  connecting:   "Conectando...",
  disconnected: "Desconectado",
  stopped:      "Detenido",
};

const EMPTY_FORM = {
  label: "", callsign: "", server: "193.152.83.229", port: 8008,
  room: "CB", password: "", message: "", localRoom: "", enabled: false,
};

function authHeaders(token: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

function fmtUptime(connectedAt: number | null): string {
  if (!connectedAt) return "—";
  const ms = Date.now() - connectedAt;
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

export function RelaysPanel({ token }: RelaysPanelProps) {
  const [relays, setRelays] = useState<RelayStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionId, setActionId] = useState<number | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleteId, setDeleteId] = useState<number | null>(null);

  const base = getApiBase();

  const loadRelays = useCallback(async () => {
    try {
      const r = await fetch(`${base}/api/admin/relays`, { headers: authHeaders(token) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setRelays(await r.json() as RelayStatus[]);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [base, token]);

  useEffect(() => {
    loadRelays();
    const t = setInterval(loadRelays, 5000);
    return () => clearInterval(t);
  }, [loadRelays]);

  async function toggleRelay(id: number, currentEnabled: boolean) {
    setActionId(id);
    try {
      const action = currentEnabled ? "stop" : "start";
      const r = await fetch(`${base}/api/admin/relays/${id}/${action}`, {
        method: "POST", headers: authHeaders(token),
      });
      if (!r.ok) {
        const d = await r.json() as { error?: string };
        throw new Error(d.error ?? `HTTP ${r.status}`);
      }
      await loadRelays();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setActionId(null);
    }
  }

  async function deleteRelay(id: number) {
    setActionId(id);
    try {
      const r = await fetch(`${base}/api/admin/relays/${id}`, {
        method: "DELETE", headers: authHeaders(token),
      });
      if (!r.ok) {
        const d = await r.json() as { error?: string };
        throw new Error(d.error ?? `HTTP ${r.status}`);
      }
      setDeleteId(null);
      await loadRelays();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setActionId(null);
    }
  }

  function openCreate() {
    setEditId(null);
    setForm({ ...EMPTY_FORM });
    setFormError(null);
    setShowForm(true);
  }

  function openEdit(relay: RelayStatus) {
    setEditId(relay.id);
    setForm({
      label: relay.label,
      callsign: relay.callsign,
      server: relay.server,
      port: relay.port,
      room: relay.room,
      password: "",
      message: "",
      localRoom: relay.localRoom,
      enabled: relay.enabled,
    });
    setFormError(null);
    setShowForm(true);
  }

  async function saveForm() {
    if (!form.label.trim() || !form.callsign.trim() || !form.server.trim() || !form.room.trim()) {
      setFormError("Rellena todos los campos obligatorios");
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const payload = {
        ...form,
        localRoom: form.localRoom.trim() || form.room.trim(),
      };
      const url = editId
        ? `${base}/api/admin/relays/${editId}`
        : `${base}/api/admin/relays`;
      const method = editId ? "PUT" : "POST";
      const r = await fetch(url, {
        method,
        headers: authHeaders(token),
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        const d = await r.json() as { error?: string };
        throw new Error(d.error ?? `HTTP ${r.status}`);
      }
      setShowForm(false);
      await loadRelays();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold text-white">Radioenlaces</h2>
          <p className="text-xs text-gray-400 mt-0.5">
            Conexiones TCP persistentes a servidores eQSO/ASORAPA (activas sin navegador)
          </p>
        </div>
        <button
          onClick={openCreate}
          className="px-3 py-1.5 bg-blue-700 hover:bg-blue-600 text-white text-sm rounded font-medium transition-colors"
        >
          + Nuevo enlace
        </button>
      </div>

      {error && (
        <div className="bg-red-900/50 border border-red-700 text-red-300 rounded px-3 py-2 text-sm">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-gray-400 text-sm">Cargando...</p>
      ) : relays.length === 0 ? (
        <div className="bg-gray-800 border border-gray-700 rounded p-6 text-center text-gray-400 text-sm">
          No hay radioenlaces configurados. Crea uno con el boton de arriba.
        </div>
      ) : (
        <div className="space-y-3">
          {relays.map(relay => (
            <div key={relay.id} className="bg-gray-800 border border-gray-700 rounded-lg p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-center gap-3 min-w-0">
                  <div className={`w-2.5 h-2.5 rounded-full flex-shrink-0 mt-0.5 ${STATUS_DOT[relay.status] ?? "bg-gray-600"}`} />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-bold text-white text-sm">{relay.label}</span>
                      <span className="text-xs text-gray-500 font-mono">{relay.callsign.startsWith("0R-") ? relay.callsign : `0R-${relay.callsign}`}</span>
                      <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${
                        relay.status === "connected" ? "bg-green-900 text-green-300" :
                        relay.status === "connecting" ? "bg-yellow-900 text-yellow-300" :
                        relay.status === "disconnected" ? "bg-red-900 text-red-300" :
                        "bg-gray-700 text-gray-400"
                      }`}>
                        {STATUS_LABEL[relay.status] ?? relay.status}
                      </span>
                    </div>
                    <div className="text-xs text-gray-400 mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                      <span>{relay.server}:{relay.port}</span>
                      <span>Sala ASORAPA: <span className="text-gray-300">{relay.room}</span></span>
                      <span>Sala local: <span className="text-gray-300">{relay.localRoom || relay.room}</span></span>
                      {relay.status === "connected" && (
                        <>
                          <span>Uptime: <span className="text-gray-300">{fmtUptime(relay.connectedAt)}</span></span>
                          <span>Paquetes RX: <span className="text-gray-300">{relay.rxPackets}</span></span>
                        </>
                      )}
                    </div>
                    {relay.usersInRoom.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {relay.usersInRoom.map(u => (
                          <span key={u} className="text-xs bg-gray-700 text-gray-300 rounded px-1.5 py-0.5 font-mono">{u}</span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2 flex-shrink-0">
                  <button
                    onClick={() => toggleRelay(relay.id, relay.enabled)}
                    disabled={actionId === relay.id}
                    className={`px-3 py-1 text-xs rounded font-medium transition-colors disabled:opacity-50 ${
                      relay.enabled
                        ? "bg-yellow-800 hover:bg-yellow-700 text-yellow-200"
                        : "bg-green-800 hover:bg-green-700 text-green-200"
                    }`}
                  >
                    {actionId === relay.id ? "..." : relay.enabled ? "Detener" : "Iniciar"}
                  </button>
                  <button
                    onClick={() => openEdit(relay)}
                    className="px-3 py-1 text-xs bg-gray-700 hover:bg-gray-600 text-gray-200 rounded font-medium transition-colors"
                  >
                    Editar
                  </button>
                  <button
                    onClick={() => setDeleteId(relay.id)}
                    className="px-3 py-1 text-xs bg-red-900 hover:bg-red-800 text-red-200 rounded font-medium transition-colors"
                  >
                    Borrar
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {deleteId !== null && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-lg p-5 w-80 space-y-4">
            <h3 className="text-white font-bold">Confirmar borrado</h3>
            <p className="text-gray-300 text-sm">
              Este radioenlace sera eliminado y desconectado permanentemente.
            </p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setDeleteId(null)}
                className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-gray-200 text-sm rounded"
              >
                Cancelar
              </button>
              <button
                onClick={() => deleteRelay(deleteId)}
                disabled={actionId === deleteId}
                className="px-3 py-1.5 bg-red-700 hover:bg-red-600 text-white text-sm rounded disabled:opacity-50"
              >
                {actionId === deleteId ? "Borrando..." : "Borrar"}
              </button>
            </div>
          </div>
        </div>
      )}

      {showForm && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-lg p-5 w-full max-w-lg space-y-4 max-h-[90vh] overflow-y-auto">
            <h3 className="text-white font-bold text-base">
              {editId ? "Editar radioenlace" : "Nuevo radioenlace"}
            </h3>

            {formError && (
              <div className="bg-red-900/50 border border-red-700 text-red-300 rounded px-3 py-2 text-sm">
                {formError}
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <label className="block text-xs text-gray-400 mb-1">Nombre / etiqueta *</label>
                <input
                  className="w-full bg-gray-800 border border-gray-600 rounded px-3 py-1.5 text-white text-sm focus:outline-none focus:border-blue-500"
                  value={form.label}
                  onChange={e => setForm(f => ({ ...f, label: e.target.value }))}
                  placeholder="Ej: Enlace ASORAPA CB"
                />
              </div>

              <div>
                <label className="block text-xs text-gray-400 mb-1">Indicativo *</label>
                <input
                  className="w-full bg-gray-800 border border-gray-600 rounded px-3 py-1.5 text-white text-sm focus:outline-none focus:border-blue-500 font-mono uppercase"
                  value={form.callsign}
                  onChange={e => setForm(f => ({ ...f, callsign: e.target.value.toUpperCase() }))}
                  placeholder="Ej: EA4XYZ (se anade 0R-)"
                />
                <p className="text-xs text-gray-500 mt-0.5">Se conectara como 0R-{form.callsign || "INDICATIVO"}</p>
              </div>

              <div>
                <label className="block text-xs text-gray-400 mb-1">Mensaje de estado</label>
                <input
                  className="w-full bg-gray-800 border border-gray-600 rounded px-3 py-1.5 text-white text-sm focus:outline-none focus:border-blue-500"
                  value={form.message}
                  onChange={e => setForm(f => ({ ...f, message: e.target.value }))}
                  placeholder="Ej: Radioenlace ASORAPA"
                />
              </div>

              <div>
                <label className="block text-xs text-gray-400 mb-1">Servidor *</label>
                <input
                  className="w-full bg-gray-800 border border-gray-600 rounded px-3 py-1.5 text-white text-sm focus:outline-none focus:border-blue-500 font-mono"
                  value={form.server}
                  onChange={e => setForm(f => ({ ...f, server: e.target.value }))}
                  placeholder="193.152.83.229"
                />
              </div>

              <div>
                <label className="block text-xs text-gray-400 mb-1">Puerto *</label>
                <input
                  type="number"
                  className="w-full bg-gray-800 border border-gray-600 rounded px-3 py-1.5 text-white text-sm focus:outline-none focus:border-blue-500 font-mono"
                  value={form.port}
                  onChange={e => setForm(f => ({ ...f, port: Number(e.target.value) }))}
                />
              </div>

              <div>
                <label className="block text-xs text-gray-400 mb-1">Sala en servidor remoto *</label>
                <input
                  className="w-full bg-gray-800 border border-gray-600 rounded px-3 py-1.5 text-white text-sm focus:outline-none focus:border-blue-500 uppercase font-mono"
                  value={form.room}
                  onChange={e => setForm(f => ({ ...f, room: e.target.value.toUpperCase() }))}
                  placeholder="CB, ASORAPA, PRUEBAS..."
                />
              </div>

              <div>
                <label className="block text-xs text-gray-400 mb-1">Sala local (donde se escucha)</label>
                <input
                  className="w-full bg-gray-800 border border-gray-600 rounded px-3 py-1.5 text-white text-sm focus:outline-none focus:border-blue-500 uppercase font-mono"
                  value={form.localRoom}
                  onChange={e => setForm(f => ({ ...f, localRoom: e.target.value.toUpperCase() }))}
                  placeholder={`Igual que sala remota si se deja vacio`}
                />
              </div>

              <div className="col-span-2">
                <label className="block text-xs text-gray-400 mb-1">Contrasena de sala (opcional)</label>
                <input
                  type="password"
                  className="w-full bg-gray-800 border border-gray-600 rounded px-3 py-1.5 text-white text-sm focus:outline-none focus:border-blue-500"
                  value={form.password}
                  onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                  placeholder={editId ? "Dejar vacio para no cambiar" : "Sin contrasena"}
                />
              </div>

              <div className="col-span-2">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.enabled}
                    onChange={e => setForm(f => ({ ...f, enabled: e.target.checked }))}
                    className="w-4 h-4 accent-blue-500"
                  />
                  <span className="text-sm text-gray-300">Activar al guardar (conectar automaticamente)</span>
                </label>
              </div>
            </div>

            <div className="flex gap-2 justify-end pt-1">
              <button
                onClick={() => setShowForm(false)}
                className="px-4 py-1.5 bg-gray-700 hover:bg-gray-600 text-gray-200 text-sm rounded"
              >
                Cancelar
              </button>
              <button
                onClick={saveForm}
                disabled={saving}
                className="px-4 py-1.5 bg-blue-700 hover:bg-blue-600 text-white text-sm rounded font-medium disabled:opacity-50"
              >
                {saving ? "Guardando..." : editId ? "Guardar cambios" : "Crear enlace"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
