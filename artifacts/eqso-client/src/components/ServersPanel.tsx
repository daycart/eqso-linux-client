/**
 * ServersPanel — Admin tab for managing eQSO servers and rooms.
 * CRUD over /api/admin/servers.
 */
import { useState, useEffect, useCallback } from "react";
import { getApiBase } from "./LoginPanel";

interface ServerRow {
  id: string;
  label: string;
  description: string;
  mode: "local" | "remote";
  host?: string;
  port?: number;
  defaultPassword?: string;
  defaultRooms: string[];
  isActive: boolean;
  sortOrder: number;
}

interface Props {
  token: string;
}

function authHeaders(token: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

const EMPTY_FORM = {
  label: "",
  description: "",
  mode: "remote" as "local" | "remote",
  host: "",
  port: 2171,
  defaultPassword: "",
  rooms: "",
  isActive: true,
  sortOrder: 0,
};

export function ServersPanel({ token }: Props) {
  const [servers, setServers] = useState<ServerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${getApiBase()}/api/admin/servers`, {
        headers: authHeaders(token),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      setServers(await res.json());
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Error al cargar servidores");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  function openNew() {
    setForm({ ...EMPTY_FORM });
    setEditId(null);
    setFormError(null);
    setShowForm(true);
  }

  function openEdit(s: ServerRow) {
    setForm({
      label:           s.label,
      description:     s.description,
      mode:            s.mode,
      host:            s.host ?? "",
      port:            s.port ?? 2171,
      defaultPassword: s.defaultPassword ?? "",
      rooms:           s.defaultRooms.join(", "),
      isActive:        s.isActive,
      sortOrder:       s.sortOrder,
    });
    setEditId(s.id);
    setFormError(null);
    setShowForm(true);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!form.label.trim()) { setFormError("El nombre es obligatorio"); return; }
    setSaving(true);
    try {
      const body = {
        label:           form.label.trim(),
        description:     form.description.trim(),
        mode:            form.mode,
        host:            form.mode === "remote" ? form.host.trim() : null,
        port:            form.mode === "remote" ? form.port : null,
        defaultPassword: form.defaultPassword.trim() || null,
        rooms:           form.rooms,
        isActive:        form.isActive,
        sortOrder:       form.sortOrder,
      };
      const url = editId
        ? `${getApiBase()}/api/admin/servers/${editId}`
        : `${getApiBase()}/api/admin/servers`;
      const res = await fetch(url, {
        method:  editId ? "PUT" : "POST",
        headers: authHeaders(token),
        body:    JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) { setFormError(data.error ?? "Error al guardar"); return; }
      setShowForm(false);
      await load();
    } catch {
      setFormError("Error de conexion");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string, label: string) {
    if (!confirm(`Eliminar servidor "${label}"? Esta accion no se puede deshacer.`)) return;
    try {
      await fetch(`${getApiBase()}/api/admin/servers/${id}`, {
        method:  "DELETE",
        headers: authHeaders(token),
      });
      await load();
    } catch {
      alert("Error al eliminar el servidor");
    }
  }

  async function toggleActive(s: ServerRow) {
    try {
      await fetch(`${getApiBase()}/api/admin/servers/${s.id}`, {
        method:  "PUT",
        headers: authHeaders(token),
        body: JSON.stringify({
          label:           s.label,
          description:     s.description,
          mode:            s.mode,
          host:            s.host,
          port:            s.port,
          defaultPassword: s.defaultPassword,
          rooms:           s.defaultRooms.join(","),
          isActive:        !s.isActive,
          sortOrder:       s.sortOrder,
        }),
      });
      await load();
    } catch {
      alert("Error al actualizar el servidor");
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Toolbar */}
      <div className="flex items-center justify-between">
        <p className="text-xs text-gray-500">
          Gestiona los servidores eQSO disponibles para los usuarios.
          El "Servidor personalizado..." se añade automaticamente al final.
        </p>
        <button
          onClick={openNew}
          className="bg-green-700 hover:bg-green-600 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors whitespace-nowrap"
        >
          + Nuevo servidor
        </button>
      </div>

      {error && (
        <div className="bg-red-950/50 border border-red-800 text-red-300 text-sm rounded-lg px-4 py-3">{error}</div>
      )}

      {/* Form modal */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
          <div className="bg-gray-900 border border-gray-700 rounded-lg shadow-2xl w-[520px] max-w-[95vw] max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-700 bg-gray-800 rounded-t-lg sticky top-0">
              <span className="font-semibold text-gray-100">
                {editId ? "Editar servidor" : "Nuevo servidor"}
              </span>
              <button onClick={() => setShowForm(false)} className="text-gray-500 hover:text-gray-200 text-xl leading-none">×</button>
            </div>
            <form onSubmit={handleSave} className="p-5 space-y-4">
              {formError && (
                <div className="bg-red-950/50 border border-red-800 text-red-300 text-sm rounded px-3 py-2">{formError}</div>
              )}

              <div>
                <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1">Nombre</label>
                <input
                  value={form.label}
                  onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-green-500"
                  placeholder="Radio Club ASORAPA"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1">Descripcion</label>
                <input
                  value={form.description}
                  onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-green-500"
                  placeholder="Servidor principal ASORAPA · Galicia"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1">Modo</label>
                <div className="flex gap-4">
                  {(["remote", "local"] as const).map((m) => (
                    <label key={m} className="flex items-center gap-2 cursor-pointer text-sm text-gray-200">
                      <input
                        type="radio"
                        name="mode"
                        value={m}
                        checked={form.mode === m}
                        onChange={() => setForm((f) => ({ ...f, mode: m }))}
                        className="accent-green-500"
                      />
                      {m === "remote" ? "Servidor remoto" : "Servidor local (este equipo)"}
                    </label>
                  ))}
                </div>
              </div>

              {form.mode === "remote" && (
                <div className="flex gap-3">
                  <div className="flex-1">
                    <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1">IP / Hostname</label>
                    <input
                      value={form.host}
                      onChange={(e) => setForm((f) => ({ ...f, host: e.target.value }))}
                      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white font-mono text-sm focus:outline-none focus:border-green-500"
                      placeholder="193.152.83.229"
                    />
                  </div>
                  <div className="w-28">
                    <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1">Puerto</label>
                    <input
                      type="number"
                      value={form.port}
                      onChange={(e) => setForm((f) => ({ ...f, port: Number(e.target.value) }))}
                      min={1} max={65535}
                      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white font-mono text-sm focus:outline-none focus:border-green-500"
                    />
                  </div>
                </div>
              )}

              <div>
                <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1">
                  Contraseña por defecto{" "}
                  <span className="text-gray-600 font-normal normal-case">(opcional)</span>
                </label>
                <input
                  value={form.defaultPassword}
                  onChange={(e) => setForm((f) => ({ ...f, defaultPassword: e.target.value }))}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm font-mono focus:outline-none focus:border-green-500"
                  placeholder="Dejar vacio si no hay contrasena"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1">
                  Salas (rooms)
                  <span className="text-gray-600 font-normal normal-case ml-1">separadas por comas</span>
                </label>
                <input
                  value={form.rooms}
                  onChange={(e) => setForm((f) => ({ ...f, rooms: e.target.value }))}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm font-mono focus:outline-none focus:border-green-500"
                  placeholder="CB, ASORAPA, PRUEBAS"
                />
              </div>

              <div className="flex gap-6">
                <div>
                  <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1">Orden</label>
                  <input
                    type="number"
                    value={form.sortOrder}
                    onChange={(e) => setForm((f) => ({ ...f, sortOrder: Number(e.target.value) }))}
                    min={0}
                    className="w-20 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-green-500"
                  />
                </div>
                <label className="flex items-center gap-2 cursor-pointer self-end pb-2">
                  <input
                    type="checkbox"
                    checked={form.isActive}
                    onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))}
                    className="accent-green-500 w-4 h-4"
                  />
                  <span className="text-sm text-gray-200">Activo (visible para usuarios)</span>
                </label>
              </div>

              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowForm(false)}
                  className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200 hover:bg-gray-800 rounded transition-colors"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-5 py-2 text-sm bg-green-700 hover:bg-green-600 disabled:bg-gray-700 text-white rounded font-medium transition-colors"
                >
                  {saving ? "Guardando..." : editId ? "Guardar cambios" : "Crear servidor"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Server list */}
      {loading ? (
        <div className="text-sm text-gray-500 py-8 text-center">Cargando servidores...</div>
      ) : servers.length === 0 ? (
        <div className="text-sm text-gray-500 py-8 text-center">No hay servidores configurados.</div>
      ) : (
        <div className="space-y-2">
          {servers.map((s) => (
            <div
              key={s.id}
              className={`bg-gray-900 border rounded-lg px-4 py-3 flex items-start gap-4 ${
                s.isActive ? "border-gray-800" : "border-gray-800 opacity-50"
              }`}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-gray-100 text-sm">{s.label}</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded border font-mono ${
                    s.mode === "local"
                      ? "bg-blue-900 text-blue-300 border-blue-700"
                      : "bg-purple-900 text-purple-300 border-purple-700"
                  }`}>
                    {s.mode === "local" ? "local" : "remoto"}
                  </span>
                  {!s.isActive && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded border bg-gray-800 text-gray-500 border-gray-700">
                      inactivo
                    </span>
                  )}
                </div>
                {s.description && (
                  <p className="text-xs text-gray-500 mt-0.5">{s.description}</p>
                )}
                <div className="flex items-center gap-3 mt-1 text-xs font-mono text-gray-600 flex-wrap">
                  {s.mode === "remote" && s.host && (
                    <span>{s.host}:{s.port}</span>
                  )}
                  {s.defaultRooms.length > 0 && (
                    <span className="text-gray-600">
                      Salas: <span className="text-gray-400">{s.defaultRooms.join(", ")}</span>
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                <button
                  onClick={() => toggleActive(s)}
                  className={`text-xs px-2 py-1 rounded transition-colors ${
                    s.isActive
                      ? "text-gray-400 hover:text-yellow-300 hover:bg-gray-800"
                      : "text-gray-500 hover:text-green-300 hover:bg-gray-800"
                  }`}
                  title={s.isActive ? "Desactivar" : "Activar"}
                >
                  {s.isActive ? "Desactivar" : "Activar"}
                </button>
                <button
                  onClick={() => openEdit(s)}
                  className="text-xs px-2 py-1 rounded text-blue-400 hover:text-blue-200 hover:bg-gray-800 transition-colors"
                >
                  Editar
                </button>
                <button
                  onClick={() => handleDelete(s.id, s.label)}
                  className="text-xs px-2 py-1 rounded text-red-500 hover:text-red-300 hover:bg-gray-800 transition-colors"
                >
                  Eliminar
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
