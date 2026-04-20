import { useState, useEffect, useCallback } from "react";
import { getApiBase } from "./LoginPanel";

interface RelayRow {
  id: number;
  label: string;
  callsign: string;
  server: string;
  port: number;
  localRoom: string;
  remoteRoom: string;
  password: string;
  enabled: boolean;
  status: "connecting" | "connected" | "disconnected";
  remoteUsers: string[];
  rxPackets: number;
  txPackets: number;
}

interface RelaysPanelProps {
  token: string;
}

const EMPTY_FORM = {
  label: "", callsign: "", server: "", port: "2171",
  localRoom: "CB", remoteRoom: "CB", password: "", enabled: false,
};

function authHdr(token: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

function StatusDot({ status }: { status: RelayRow["status"] }) {
  const color = status === "connected"
    ? "bg-green-500"
    : status === "connecting"
      ? "bg-yellow-500 animate-pulse"
      : "bg-red-600";
  const label = status === "connected" ? "Conectado"
    : status === "connecting" ? "Conectando..."
    : "Desconectado";
  return (
    <span className="flex items-center gap-1.5 text-xs">
      <span className={`inline-block w-2 h-2 rounded-full ${color}`} />
      <span className="text-gray-400">{label}</span>
    </span>
  );
}

export function RelaysPanel({ token }: RelaysPanelProps) {
  const [relays, setRelays] = useState<RelayRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [actionId, setActionId] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${getApiBase()}/api/admin/relays`, { headers: authHdr(token) });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      setRelays(await res.json());
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Error al cargar radioenlaces");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  function openCreate() {
    setEditId(null);
    setForm({ ...EMPTY_FORM });
    setFormError(null);
    setShowForm(true);
  }

  function openEdit(r: RelayRow) {
    setEditId(r.id);
    setForm({
      label: r.label,
      callsign: r.callsign,
      server: r.server,
      port: String(r.port),
      localRoom: r.localRoom,
      remoteRoom: r.remoteRoom,
      password: r.password,
      enabled: r.enabled,
    });
    setFormError(null);
    setShowForm(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!form.label.trim()) { setFormError("El nombre es obligatorio"); return; }
    if (!form.callsign.trim()) { setFormError("El indicativo es obligatorio"); return; }
    if (!form.server.trim()) { setFormError("El servidor es obligatorio"); return; }
    setSaving(true);
    try {
      const body = {
        label:      form.label.trim(),
        callsign:   form.callsign.trim(),
        server:     form.server.trim(),
        port:       Number(form.port) || 2171,
        localRoom:  form.localRoom.trim() || "CB",
        remoteRoom: form.remoteRoom.trim() || "CB",
        password:   form.password.trim(),
        enabled:    form.enabled,
      };
      const url = editId != null
        ? `${getApiBase()}/api/admin/relays/${editId}`
        : `${getApiBase()}/api/admin/relays`;
      const res = await fetch(url, {
        method: editId != null ? "PUT" : "POST",
        headers: authHdr(token),
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) { setFormError(data.error ?? "Error"); return; }
      setShowForm(false);
      setEditId(null);
      await load();
    } catch {
      setFormError("Error de conexion");
    } finally {
      setSaving(false);
    }
  }

  async function toggleEnabled(r: RelayRow) {
    setActionId(r.id);
    try {
      const action = r.enabled ? "stop" : "start";
      const res = await fetch(`${getApiBase()}/api/admin/relays/${r.id}/${action}`, {
        method: "POST",
        headers: authHdr(token),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      await load();
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Error");
    } finally {
      setActionId(null);
    }
  }

  async function deleteRelay(r: RelayRow) {
    if (!confirm(`Eliminar enlace "${r.label}"? Esta accion no se puede deshacer.`)) return;
    setActionId(r.id);
    try {
      const res = await fetch(`${getApiBase()}/api/admin/relays/${r.id}`, {
        method: "DELETE",
        headers: authHdr(token),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      await load();
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Error");
    } finally {
      setActionId(null);
    }
  }

  const isBusy = (id: number) => actionId === id;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-gray-200">Radioenlaces</h3>
          <p className="text-xs text-gray-500 mt-0.5">
            Conexiones TCP persistentes a servidores eQSO externos. El servidor mantiene el enlace
            activo independientemente de los navegadores conectados.
          </p>
        </div>
        <button
          onClick={openCreate}
          className="bg-green-700 hover:bg-green-600 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors shrink-0"
        >
          + Nuevo enlace
        </button>
      </div>

      {error && (
        <p className="text-xs bg-red-950 border border-red-800 text-red-300 rounded-lg px-3 py-2">{error}</p>
      )}

      {/* Form */}
      {showForm && (
        <form
          onSubmit={handleSubmit}
          className="bg-gray-900 border border-gray-700 rounded-xl p-5 space-y-4"
        >
          <h4 className="text-sm font-semibold text-gray-200">
            {editId != null ? "Editar enlace" : "Nuevo radioenlace"}
          </h4>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-gray-400 mb-1">Nombre del enlace</label>
              <input
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-green-600"
                placeholder="ej. ASORAPA principal"
                value={form.label}
                onChange={e => setForm(f => ({ ...f, label: e.target.value }))}
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Indicativo</label>
              <input
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-green-600 uppercase"
                placeholder="ej. IN70WN"
                value={form.callsign}
                onChange={e => setForm(f => ({ ...f, callsign: e.target.value.toUpperCase() }))}
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Servidor remoto</label>
              <input
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-green-600"
                placeholder="ej. 193.152.83.229"
                value={form.server}
                onChange={e => setForm(f => ({ ...f, server: e.target.value }))}
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Puerto</label>
              <input
                type="number"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-green-600"
                placeholder="2171"
                value={form.port}
                onChange={e => setForm(f => ({ ...f, port: e.target.value }))}
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Sala local</label>
              <input
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-green-600 uppercase"
                placeholder="CB"
                value={form.localRoom}
                onChange={e => setForm(f => ({ ...f, localRoom: e.target.value.toUpperCase() }))}
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Sala remota</label>
              <input
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-green-600 uppercase"
                placeholder="CB"
                value={form.remoteRoom}
                onChange={e => setForm(f => ({ ...f, remoteRoom: e.target.value.toUpperCase() }))}
              />
            </div>
            <div className="col-span-2">
              <label className="block text-xs text-gray-400 mb-1">Contrasena del servidor remoto (opcional)</label>
              <input
                type="password"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-green-600"
                placeholder="Dejar vacio si no hay contrasena"
                value={form.password}
                onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
              />
            </div>
          </div>

          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={e => setForm(f => ({ ...f, enabled: e.target.checked }))}
              className="w-4 h-4 rounded accent-green-500"
            />
            <span className="text-sm text-gray-300">Activar enlace al guardar</span>
          </label>

          {formError && (
            <p className="text-xs text-red-400 bg-red-950 border border-red-800 rounded-lg px-3 py-2">{formError}</p>
          )}

          <div className="flex gap-2">
            <button
              type="submit"
              disabled={saving}
              className="bg-green-700 hover:bg-green-600 disabled:opacity-50 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
            >
              {saving ? "Guardando..." : editId != null ? "Guardar cambios" : "Crear enlace"}
            </button>
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm px-4 py-2 rounded-lg transition-colors"
            >
              Cancelar
            </button>
          </div>
        </form>
      )}

      {/* Relay list */}
      {loading && !relays.length && (
        <p className="text-xs text-gray-600 text-center py-8">Cargando radioenlaces...</p>
      )}

      {!loading && relays.length === 0 && (
        <div className="text-center py-12 border border-dashed border-gray-800 rounded-xl">
          <p className="text-sm text-gray-500">No hay radioenlaces configurados.</p>
          <p className="text-xs text-gray-700 mt-1">Crea uno con el boton "+ Nuevo enlace".</p>
        </div>
      )}

      {relays.length > 0 && (
        <div className="space-y-3">
          {relays.map(r => (
            <div
              key={r.id}
              className={`rounded-xl border p-4 transition-colors ${
                r.enabled && r.status === "connected"
                  ? "border-green-800 bg-green-950/20"
                  : r.enabled
                    ? "border-yellow-800 bg-yellow-950/10"
                    : "border-gray-800 bg-gray-900"
              }`}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-gray-100 text-sm">{r.label}</span>
                    <span className="font-mono text-xs text-gray-400 bg-gray-800 px-1.5 py-0.5 rounded">{r.callsign}</span>
                    {r.enabled && <StatusDot status={r.status} />}
                    {!r.enabled && (
                      <span className="text-xs text-gray-600">Inactivo</span>
                    )}
                  </div>
                  <div className="mt-1.5 text-[11px] text-gray-500 flex flex-wrap gap-x-3 gap-y-0.5">
                    <span>{r.server}:{r.port}</span>
                    <span>Sala local: <span className="text-gray-400 font-mono">{r.localRoom}</span></span>
                    <span>Sala remota: <span className="text-gray-400 font-mono">{r.remoteRoom}</span></span>
                    {r.status === "connected" && (
                      <>
                        <span className="text-green-700">RX: {r.rxPackets}</span>
                        <span className="text-blue-700">TX: {r.txPackets}</span>
                      </>
                    )}
                  </div>
                  {r.status === "connected" && r.remoteUsers.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {r.remoteUsers.map(u => (
                        <span key={u} className="text-[10px] font-mono bg-gray-800 text-gray-400 rounded px-1.5 py-0.5">
                          {u}
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => toggleEnabled(r)}
                    disabled={isBusy(r.id)}
                    className={`text-xs font-medium px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50 ${
                      r.enabled
                        ? "bg-red-900 hover:bg-red-800 text-red-200"
                        : "bg-green-800 hover:bg-green-700 text-green-200"
                    }`}
                  >
                    {isBusy(r.id) ? "..." : r.enabled ? "Detener" : "Activar"}
                  </button>
                  <button
                    onClick={() => openEdit(r)}
                    disabled={isBusy(r.id)}
                    className="text-xs px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 transition-colors disabled:opacity-50"
                  >
                    Editar
                  </button>
                  <button
                    onClick={() => deleteRelay(r)}
                    disabled={isBusy(r.id)}
                    className="text-xs px-3 py-1.5 rounded-lg bg-gray-900 hover:bg-red-950 text-gray-600 hover:text-red-400 transition-colors disabled:opacity-50"
                  >
                    Borrar
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
