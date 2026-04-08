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

interface RemoteConn {
  id: string;
  host: string;
  port: number;
  name: string;
  room: string;
  status: "connecting" | "connected" | "disconnected";
  connectedAt: number;
  txBytes: number;
  rxBytes: number;
}

interface ServerStatus {
  enabled: boolean;
  startedAt: number;
  uptimeMs: number;
  totalClients: number;
  inRoom: number;
  rooms: MonitorRoom[];
  remoteConnections: RemoteConn[];
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

interface Props {
  token: string;
}

export function ServerMonitor({ token }: Props) {
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toggling, setToggling] = useState(false);

  const headers = { Authorization: `Bearer ${token}` };

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`${getApiBase()}/api/admin/server/status`, { headers });
      if (!res.ok) throw new Error("Error al obtener estado");
      const data = await res.json();
      setStatus(data);
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Error de red");
    }
  }, [token]);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 3000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  async function toggleServer() {
    if (!status) return;
    setToggling(true);
    try {
      const action = status.enabled ? "disable" : "enable";
      const res = await fetch(`${getApiBase()}/api/admin/server/${action}`, {
        method: "POST",
        headers,
      });
      if (!res.ok) throw new Error("Error al cambiar estado");
      await fetchStatus();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Error de red");
    } finally {
      setToggling(false);
    }
  }

  if (error) {
    return (
      <div className="rounded-lg bg-red-950 border border-red-800 px-4 py-3 text-sm text-red-300">
        {error}
      </div>
    );
  }

  if (!status) {
    return (
      <div className="text-center py-12 text-gray-600 text-sm">Cargando monitor...</div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Server overview */}
      <div className="rounded-xl border border-gray-800 bg-gray-900 p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-gray-200 uppercase tracking-wide">
            Estado del servidor
          </h3>
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
          <Stat
            label="Estado"
            value={status.enabled ? "Activo" : "Detenido"}
            valueClass={status.enabled ? "text-green-400" : "text-red-400"}
          />
          <Stat label="Uptime" value={fmtUptime(status.uptimeMs)} />
          <Stat label="Clientes" value={String(status.totalClients)} />
          <Stat label="En sala" value={String(status.inRoom)} />
        </div>
      </div>

      {/* Remote connections */}
      <div className="space-y-3">
        <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide px-1">
          Conexiones a servidores remotos ({status.remoteConnections?.length ?? 0})
        </h3>

        {(status.remoteConnections?.length ?? 0) === 0 && (
          <div className="rounded-xl border border-gray-800 bg-gray-900 px-5 py-4 text-sm text-gray-600">
            Ningun cliente conectado a un servidor remoto en este momento.
          </div>
        )}

        {(status.remoteConnections ?? []).map((rc) => (
          <div key={rc.id} className="rounded-xl border border-gray-800 bg-gray-900 overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-800 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
                  rc.status === "connected" ? "bg-green-500" :
                  rc.status === "connecting" ? "bg-yellow-500 animate-pulse" : "bg-red-500"
                }`} />
                <div>
                  <span className="text-sm font-mono font-semibold text-gray-100">
                    {rc.host}:{rc.port}
                  </span>
                  {rc.name && (
                    <span className="ml-2 text-xs text-green-400 font-mono">{rc.name}</span>
                  )}
                  {rc.room && (
                    <span className="ml-2 text-xs text-gray-500">sala: {rc.room}</span>
                  )}
                </div>
              </div>
              <span className={`text-xs font-medium px-2 py-1 rounded ${
                rc.status === "connected" ? "bg-green-900 text-green-300" :
                rc.status === "connecting" ? "bg-yellow-900 text-yellow-300" : "bg-red-900 text-red-300"
              }`}>
                {rc.status === "connected" ? "Conectado" :
                 rc.status === "connecting" ? "Conectando..." : "Desconectado"}
              </span>
            </div>
            <div className="grid grid-cols-3 divide-x divide-gray-800 text-center">
              <div className="px-4 py-3">
                <div className="text-xs text-gray-500 mb-1">TX enviado</div>
                <div className="text-sm font-semibold text-gray-200 tabular-nums">{fmtBytes(rc.txBytes)}</div>
              </div>
              <div className="px-4 py-3">
                <div className="text-xs text-gray-500 mb-1">RX recibido</div>
                <div className="text-sm font-semibold text-gray-200 tabular-nums">{fmtBytes(rc.rxBytes)}</div>
              </div>
              <div className="px-4 py-3">
                <div className="text-xs text-gray-500 mb-1">Tiempo activo</div>
                <div className="text-sm font-semibold text-gray-200 tabular-nums">
                  {rc.status === "connected" ? fmtConnTime(rc.connectedAt) : "—"}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Rooms */}
      <div className="space-y-3">
        <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide px-1">
          Salas activas ({status.rooms.length})
        </h3>

        {status.rooms.length === 0 && (
          <div className="text-center py-8 text-gray-600 text-sm">
            No hay clientes conectados en ninguna sala.
          </div>
        )}

        {status.rooms.map((room) => (
          <div key={room.room} className="rounded-xl border border-gray-800 bg-gray-900 overflow-hidden">
            {/* Room header */}
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

            {/* Client table */}
            {room.clients.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-gray-600 border-b border-gray-800">
                      <th className="text-left px-5 py-2 font-medium">Indicativo</th>
                      <th className="text-left px-3 py-2 font-medium">Prot.</th>
                      <th className="text-right px-3 py-2 font-medium">TX</th>
                      <th className="text-right px-3 py-2 font-medium">RX</th>
                      <th className="text-right px-3 py-2 font-medium">Ping</th>
                      <th className="text-right px-5 py-2 font-medium">Tiempo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {room.clients.map((c) => (
                      <tr key={c.id} className="border-b border-gray-800/50 hover:bg-gray-800/40 transition-colors">
                        <td className="px-5 py-2.5 font-mono text-green-400 font-medium">{c.name}</td>
                        <td className="px-3 py-2.5">
                          <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase ${
                            c.protocol === "tcp"
                              ? "bg-blue-900 text-blue-300"
                              : "bg-purple-900 text-purple-300"
                          }`}>
                            {c.protocol}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-right text-gray-400">{fmtBytes(c.txBytes)}</td>
                        <td className="px-3 py-2.5 text-right text-gray-400">{fmtBytes(c.rxBytes)}</td>
                        <td className="px-3 py-2.5 text-right text-gray-500">
                          {c.pingMs > 0 ? `${c.pingMs}ms` : "—"}
                        </td>
                        <td className="px-5 py-2.5 text-right text-gray-500">{fmtConnTime(c.connectedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ))}
      </div>
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
