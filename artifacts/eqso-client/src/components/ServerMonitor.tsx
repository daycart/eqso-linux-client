import { useState, useEffect, useCallback } from "react";
import { getApiBase } from "./LoginPanel";

interface MonitorClient {
  id: string;
  name: string;
  protocol: string;
  connectedAt: number;
  txBytes: number;
  rxBytes: number;
  pingMs: number;
  message: string;
}

interface MonitorRoom {
  room: string;
  locked: boolean;
  lockedBy: string;
  clients: MonitorClient[];
}

interface MuteEntry {
  callsign: string;
  mutedAt: number;
  expiresAt: number | null;
}

interface BanEntry {
  callsign: string;
  reason: string;
  bannedBy: string;
  bannedAt: number;
}

interface ServerStatus {
  enabled: boolean;
  startedAt: number;
  uptimeMs: number;
  totalClients: number;
  inRoom: number;
  rooms: MonitorRoom[];
  mutes: MuteEntry[];
  bans: BanEntry[];
}

function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(2)} MB`;
}

function fmtUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function fmtConnTime(connectedAt: number): string {
  const ms = Date.now() - connectedAt;
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function fmtMuteRemaining(expiresAt: number | null): string {
  if (expiresAt === null) return "Permanente";
  const ms = expiresAt - Date.now();
  if (ms <= 0) return "Caducado";
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function fmtDate(ts: number): string {
  return new Date(ts).toLocaleString("es-ES", {
    day: "2-digit", month: "2-digit", year: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
}

const MUTE_OPTIONS = [
  { label: "5 min",    ms: 5  * 60 * 1000 },
  { label: "15 min",   ms: 15 * 60 * 1000 },
  { label: "30 min",   ms: 30 * 60 * 1000 },
  { label: "1 hora",   ms: 60 * 60 * 1000 },
  { label: "Siempre",  ms: null },
];

interface Props {
  token: string;
}

export function ServerMonitor({ token }: Props) {
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toggling, setToggling] = useState(false);
  const [actionKey, setActionKey] = useState<string | null>(null);
  const [muteDropdown, setMuteDropdown] = useState<string | null>(null);
  const [banModal, setBanModal] = useState<{ clientId: string; name: string } | null>(null);
  const [banReason, setBanReason] = useState("");
  const [banCallsignInput, setBanCallsignInput] = useState("");
  const [banReasonInput, setBanReasonInput] = useState("");
  const [showManualBan, setShowManualBan] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const base = getApiBase();
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`${base}/api/admin/server/status`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("Error al obtener estado");
      setStatus(await res.json() as ServerStatus);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error de red");
    }
  }, [token, base]);

  useEffect(() => {
    fetchStatus();
    const t = setInterval(fetchStatus, 3000);
    return () => clearInterval(t);
  }, [fetchStatus]);

  function flash(m: string) {
    setMsg(m);
    setTimeout(() => setMsg(null), 3000);
  }

  async function toggleServer() {
    if (!status) return;
    setToggling(true);
    try {
      const action = status.enabled ? "disable" : "enable";
      const res = await fetch(`${base}/api/admin/server/${action}`, { method: "POST", headers });
      if (!res.ok) throw new Error("Error al cambiar estado");
      await fetchStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error de red");
    } finally {
      setToggling(false);
    }
  }

  async function kick(clientId: string, name: string) {
    setActionKey(`kick-${clientId}`);
    try {
      await fetch(`${base}/api/admin/moderation/kick/${clientId}`, { method: "POST", headers });
      flash(`${name} expulsado`);
      await fetchStatus();
    } catch { /* ignore */ } finally {
      setActionKey(null);
    }
  }

  async function mute(callsign: string, durationMs: number | null) {
    setActionKey(`mute-${callsign}`);
    setMuteDropdown(null);
    try {
      await fetch(`${base}/api/admin/moderation/mute`, {
        method: "POST", headers,
        body: JSON.stringify({ callsign, durationMs }),
      });
      flash(`${callsign} silenciado`);
      await fetchStatus();
    } catch { /* ignore */ } finally {
      setActionKey(null);
    }
  }

  async function unmute(callsign: string) {
    setActionKey(`unmute-${callsign}`);
    try {
      await fetch(`${base}/api/admin/moderation/mute/${encodeURIComponent(callsign)}`, {
        method: "DELETE", headers,
      });
      flash(`${callsign} sin silencio`);
      await fetchStatus();
    } catch { /* ignore */ } finally {
      setActionKey(null);
    }
  }

  async function ban(callsign: string, reason: string) {
    setActionKey(`ban-${callsign}`);
    setBanModal(null);
    setBanReason("");
    try {
      await fetch(`${base}/api/admin/moderation/ban`, {
        method: "POST", headers,
        body: JSON.stringify({ callsign, reason }),
      });
      flash(`${callsign} baneado`);
      await fetchStatus();
    } catch { /* ignore */ } finally {
      setActionKey(null);
    }
  }

  async function unban(callsign: string) {
    setActionKey(`unban-${callsign}`);
    try {
      await fetch(`${base}/api/admin/moderation/ban/${encodeURIComponent(callsign)}`, {
        method: "DELETE", headers,
      });
      flash(`${callsign} desbaneado`);
      await fetchStatus();
    } catch { /* ignore */ } finally {
      setActionKey(null);
    }
  }

  function isMuted(callsign: string): boolean {
    return (status?.mutes ?? []).some(m => m.callsign.toUpperCase() === callsign.toUpperCase());
  }

  if (error) {
    return (
      <div className="rounded-lg bg-red-950 border border-red-800 px-4 py-3 text-sm text-red-300">{error}</div>
    );
  }
  if (!status) {
    return <div className="text-center py-12 text-gray-600 text-sm">Cargando monitor...</div>;
  }

  return (
    <div className="space-y-6" onClick={() => setMuteDropdown(null)}>
      {msg && (
        <div className="fixed top-4 right-4 z-50 bg-green-900 border border-green-600 text-green-200 text-sm px-4 py-2 rounded-lg shadow-lg">
          {msg}
        </div>
      )}

      {/* Server overview */}
      <div className="rounded-xl border border-gray-800 bg-gray-900 p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-gray-200 uppercase tracking-wide">Estado del servidor</h3>
          <button
            onClick={toggleServer}
            disabled={toggling}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 ${
              status.enabled
                ? "bg-red-800 hover:bg-red-700 text-red-100"
                : "bg-green-800 hover:bg-green-700 text-green-100"
            }`}
          >
            {toggling ? "..." : status.enabled ? "Detener servidor" : "Iniciar servidor"}
          </button>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Estado" value={status.enabled ? "Activo" : "Detenido"} valueClass={status.enabled ? "text-green-400" : "text-red-400"} />
          <Stat label="Uptime" value={fmtUptime(status.uptimeMs)} />
          <Stat label="Clientes" value={String(status.totalClients)} />
          <Stat label="En sala" value={String(status.inRoom)} />
        </div>
      </div>

      {/* Active rooms with moderation controls */}
      <div className="space-y-3">
        <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide px-1">
          Salas activas ({status.rooms.length})
        </h3>

        {status.rooms.length === 0 && (
          <div className="text-center py-8 text-gray-600 text-sm">No hay clientes conectados en ninguna sala.</div>
        )}

        {status.rooms.map((room) => (
          <div key={room.room} className="rounded-xl border border-gray-800 bg-gray-900 overflow-hidden">
            <div className="flex items-center justify-between px-5 py-3 bg-gray-850 border-b border-gray-800">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-gray-100">{room.room}</span>
                {room.locked && (
                  <span className="text-[10px] bg-orange-900 text-orange-300 border border-orange-700 rounded-full px-2 py-0.5">
                    PTT: {room.lockedBy}
                  </span>
                )}
              </div>
              <span className="text-xs text-gray-500">{room.clients.length} cliente{room.clients.length !== 1 ? "s" : ""}</span>
            </div>

            {room.clients.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-gray-600 border-b border-gray-800">
                      <th className="text-left px-5 py-2 font-medium">Indicativo</th>
                      <th className="text-left px-3 py-2 font-medium">Prot.</th>
                      <th className="text-right px-3 py-2 font-medium">TX</th>
                      <th className="text-right px-3 py-2 font-medium">RX</th>
                      <th className="text-right px-3 py-2 font-medium">Tiempo</th>
                      <th className="text-right px-5 py-2 font-medium">Acciones</th>
                    </tr>
                  </thead>
                  <tbody>
                    {room.clients.map((c) => (
                      <tr key={c.id} className={`border-b border-gray-800/50 transition-colors ${isMuted(c.name) ? "bg-yellow-950/20" : "hover:bg-gray-800/40"}`}>
                        <td className="px-5 py-2.5 font-mono font-medium">
                          <span className={isMuted(c.name) ? "text-yellow-400" : "text-green-400"}>{c.name}</span>
                          {isMuted(c.name) && (
                            <span className="ml-1.5 text-[9px] bg-yellow-900 text-yellow-300 rounded px-1 py-0.5">MUTE</span>
                          )}
                        </td>
                        <td className="px-3 py-2.5">
                          <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase ${
                            c.protocol === "tcp" ? "bg-blue-900 text-blue-300" : "bg-purple-900 text-purple-300"
                          }`}>{c.protocol}</span>
                        </td>
                        <td className="px-3 py-2.5 text-right text-gray-400">{fmtBytes(c.txBytes)}</td>
                        <td className="px-3 py-2.5 text-right text-gray-400">{fmtBytes(c.rxBytes)}</td>
                        <td className="px-3 py-2.5 text-right text-gray-500">{fmtConnTime(c.connectedAt)}</td>
                        <td className="px-5 py-2 text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            {/* Kick */}
                            <button
                              onClick={() => kick(c.id, c.name)}
                              disabled={actionKey === `kick-${c.id}`}
                              className="px-2 py-1 text-[11px] bg-gray-700 hover:bg-gray-600 text-gray-200 rounded disabled:opacity-50 transition-colors"
                              title="Expulsar de la sala"
                            >
                              Expulsar
                            </button>

                            {/* Mute dropdown */}
                            <div className="relative" onClick={e => e.stopPropagation()}>
                              {isMuted(c.name) ? (
                                <button
                                  onClick={() => unmute(c.name)}
                                  disabled={actionKey === `unmute-${c.name}`}
                                  className="px-2 py-1 text-[11px] bg-yellow-900 hover:bg-yellow-800 text-yellow-200 rounded disabled:opacity-50 transition-colors"
                                >
                                  Quitar mute
                                </button>
                              ) : (
                                <>
                                  <button
                                    onClick={() => setMuteDropdown(muteDropdown === c.id ? null : c.id)}
                                    disabled={!!actionKey}
                                    className="px-2 py-1 text-[11px] bg-yellow-900/60 hover:bg-yellow-900 text-yellow-300 rounded disabled:opacity-50 transition-colors"
                                    title="Silenciar"
                                  >
                                    Silenciar
                                  </button>
                                  {muteDropdown === c.id && (
                                    <div className="absolute right-0 top-full mt-1 z-20 bg-gray-800 border border-gray-600 rounded-lg shadow-xl min-w-[120px]">
                                      {MUTE_OPTIONS.map(opt => (
                                        <button
                                          key={opt.label}
                                          onClick={() => mute(c.name, opt.ms)}
                                          className="block w-full text-left px-3 py-2 text-xs text-gray-200 hover:bg-gray-700 first:rounded-t-lg last:rounded-b-lg transition-colors"
                                        >
                                          {opt.label}
                                        </button>
                                      ))}
                                    </div>
                                  )}
                                </>
                              )}
                            </div>

                            {/* Ban */}
                            <button
                              onClick={() => { setBanModal({ clientId: c.id, name: c.name }); setBanReason(""); }}
                              disabled={!!actionKey}
                              className="px-2 py-1 text-[11px] bg-red-900/70 hover:bg-red-900 text-red-300 rounded disabled:opacity-50 transition-colors"
                              title="Banear indicativo"
                            >
                              Banear
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Muted users */}
      {status.mutes.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-xs font-semibold text-yellow-600 uppercase tracking-wide px-1">
            Silenciados ({status.mutes.length})
          </h3>
          <div className="rounded-xl border border-yellow-900/50 bg-gray-900 overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-600 border-b border-gray-800">
                  <th className="text-left px-5 py-2 font-medium">Indicativo</th>
                  <th className="text-left px-3 py-2 font-medium">Tiempo restante</th>
                  <th className="text-right px-5 py-2 font-medium">Accion</th>
                </tr>
              </thead>
              <tbody>
                {status.mutes.map((m) => (
                  <tr key={m.callsign} className="border-b border-gray-800/50 hover:bg-gray-800/40">
                    <td className="px-5 py-2.5 font-mono text-yellow-400 font-medium">{m.callsign}</td>
                    <td className="px-3 py-2.5 text-gray-300">{fmtMuteRemaining(m.expiresAt)}</td>
                    <td className="px-5 py-2 text-right">
                      <button
                        onClick={() => unmute(m.callsign)}
                        disabled={actionKey === `unmute-${m.callsign}`}
                        className="px-2 py-1 text-[11px] bg-yellow-900 hover:bg-yellow-800 text-yellow-200 rounded disabled:opacity-50 transition-colors"
                      >
                        Quitar mute
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Banned users */}
      <div className="space-y-2">
        <div className="flex items-center justify-between px-1">
          <h3 className="text-xs font-semibold text-red-600 uppercase tracking-wide">
            Baneados ({status.bans.length})
          </h3>
          <button
            onClick={() => { setShowManualBan(true); setBanCallsignInput(""); setBanReasonInput(""); }}
            className="text-xs text-red-400 hover:text-red-300 transition-colors"
          >
            + Banear indicativo
          </button>
        </div>

        {status.bans.length === 0 ? (
          <div className="rounded-xl border border-gray-800 bg-gray-900 px-5 py-4 text-sm text-gray-600">
            Ningun indicativo baneado.
          </div>
        ) : (
          <div className="rounded-xl border border-red-900/40 bg-gray-900 overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-600 border-b border-gray-800">
                  <th className="text-left px-5 py-2 font-medium">Indicativo</th>
                  <th className="text-left px-3 py-2 font-medium">Motivo</th>
                  <th className="text-left px-3 py-2 font-medium">Fecha</th>
                  <th className="text-right px-5 py-2 font-medium">Accion</th>
                </tr>
              </thead>
              <tbody>
                {status.bans.map((b) => (
                  <tr key={b.callsign} className="border-b border-gray-800/50 hover:bg-gray-800/40">
                    <td className="px-5 py-2.5 font-mono text-red-400 font-medium">{b.callsign}</td>
                    <td className="px-3 py-2.5 text-gray-400">{b.reason || "—"}</td>
                    <td className="px-3 py-2.5 text-gray-500">{fmtDate(b.bannedAt)}</td>
                    <td className="px-5 py-2 text-right">
                      <button
                        onClick={() => unban(b.callsign)}
                        disabled={actionKey === `unban-${b.callsign}`}
                        className="px-2 py-1 text-[11px] bg-gray-700 hover:bg-gray-600 text-gray-200 rounded disabled:opacity-50 transition-colors"
                      >
                        Desbanear
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Ban confirm modal (from connected client) */}
      {banModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-5 w-80 space-y-4">
            <h3 className="text-white font-bold">Banear {banModal.name}</h3>
            <p className="text-gray-400 text-sm">
              El indicativo sera expulsado ahora y no podra volver a conectarse.
            </p>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Motivo (opcional)</label>
              <input
                className="w-full bg-gray-800 border border-gray-600 rounded px-3 py-1.5 text-white text-sm focus:outline-none focus:border-red-500"
                value={banReason}
                onChange={e => setBanReason(e.target.value)}
                placeholder="Ej: spam, lenguaje inapropiado..."
              />
            </div>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setBanModal(null)} className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-gray-200 text-sm rounded">
                Cancelar
              </button>
              <button
                onClick={() => ban(banModal.name, banReason)}
                disabled={actionKey === `ban-${banModal.name}`}
                className="px-3 py-1.5 bg-red-700 hover:bg-red-600 text-white text-sm rounded font-medium disabled:opacity-50"
              >
                Banear
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Manual ban modal */}
      {showManualBan && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-5 w-80 space-y-4">
            <h3 className="text-white font-bold">Banear indicativo</h3>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Indicativo *</label>
              <input
                className="w-full bg-gray-800 border border-gray-600 rounded px-3 py-1.5 text-white text-sm focus:outline-none focus:border-red-500 font-mono uppercase"
                value={banCallsignInput}
                onChange={e => setBanCallsignInput(e.target.value.toUpperCase())}
                placeholder="Ej: EA4XYZ"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Motivo (opcional)</label>
              <input
                className="w-full bg-gray-800 border border-gray-600 rounded px-3 py-1.5 text-white text-sm focus:outline-none focus:border-red-500"
                value={banReasonInput}
                onChange={e => setBanReasonInput(e.target.value)}
                placeholder="Ej: spam, lenguaje inapropiado..."
              />
            </div>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setShowManualBan(false)} className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-gray-200 text-sm rounded">
                Cancelar
              </button>
              <button
                onClick={() => { if (banCallsignInput.trim()) { ban(banCallsignInput.trim(), banReasonInput); setShowManualBan(false); } }}
                disabled={!banCallsignInput.trim()}
                className="px-3 py-1.5 bg-red-700 hover:bg-red-600 text-white text-sm rounded font-medium disabled:opacity-50"
              >
                Banear
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, valueClass = "text-gray-100" }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="bg-gray-800/50 rounded-lg px-4 py-3">
      <div className="text-xs text-gray-500 mb-1">{label}</div>
      <div className={`text-lg font-semibold tabular-nums ${valueClass}`}>{value}</div>
    </div>
  );
}
