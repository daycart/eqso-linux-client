import { useState, useEffect } from "react";
import { ConnectionStatus, EqsoServer, KNOWN_SERVERS } from "@/hooks/useEqsoClient";
import type { AuthSession } from "@/components/LoginPanel";

interface ConnectPanelProps {
  status: ConnectionStatus;
  error: string | null;
  rooms: string[];
  callsign: string;
  selectedRoom: string;
  statusMessage: string;
  password: string;
  selectedServer: EqsoServer;
  servers?: EqsoServer[];
  auth?: AuthSession | null;
  onCallsignChange: (v: string) => void;
  onRoomChange: (v: string) => void;
  onStatusMessageChange: (v: string) => void;
  onPasswordChange: (v: string) => void;
  onConnect: (server: EqsoServer, customHost?: string, customPort?: number) => void;
  onJoin: () => void;
}

export function ConnectPanel({
  status,
  error,
  rooms,
  callsign,
  selectedRoom,
  statusMessage,
  password,
  servers: serversProp,
  auth,
  onCallsignChange,
  onRoomChange,
  onStatusMessageChange,
  onPasswordChange,
  onConnect,
  onJoin,
}: ConnectPanelProps) {
  const isAuthenticated = !!auth;
  const isRelay = auth?.isRelay ?? false;
  const displayCallsign = isAuthenticated
    ? (isRelay
        ? (auth!.callsign.startsWith("0R-") ? auth!.callsign : `0R-${auth!.callsign}`)
        : auth!.callsign)
    : null;
  const isConnected = status === "connected";
  const isConnecting = status === "connecting";

  const serverList = serversProp && serversProp.length > 0 ? serversProp : KNOWN_SERVERS;

  const [chosenServerId, setChosenServerId] = useState<string>(serverList[0].id);
  const [editHost, setEditHost] = useState("");
  const [editPort, setEditPort] = useState(2171);
  const [connectedServerLabel, setConnectedServerLabel] = useState("");

  const chosenServer = serverList.find((s) => s.id === chosenServerId) ?? serverList[0];
  const isRemote = chosenServer.mode === "remote";

  useEffect(() => {
    if (chosenServer.host !== undefined) {
      setEditHost(chosenServer.host);
    }
    if (chosenServer.port !== undefined) {
      setEditPort(chosenServer.port);
    }
    if (chosenServer.defaultRooms?.[0]) {
      onRoomChange(chosenServer.defaultRooms[0]);
    }
  }, [chosenServerId]);

  const availableRooms =
    rooms.length > 0
      ? rooms
      : chosenServer.defaultRooms?.length
      ? chosenServer.defaultRooms
      : ["GENERAL", "CB27"];

  const handleConnect = () => {
    const label = chosenServer.id === "custom"
      ? `${editHost}:${editPort}`
      : chosenServer.label;
    setConnectedServerLabel(label);

    if (isRemote) {
      onConnect(chosenServer, editHost, editPort);
    } else {
      onConnect(chosenServer);
    }
  };

  const handleChangeServer = () => {
    if (isRemote) {
      onConnect(chosenServer, editHost, editPort);
    } else {
      onConnect(chosenServer);
    }
  };

  const hostIsValid = editHost.trim().length > 0;
  const canConnect = !isConnecting && (!isRemote || hostIsValid);

  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="w-20 h-20 rounded-full bg-green-900/40 border-2 border-green-600 flex items-center justify-center mx-auto mb-4">
            <svg viewBox="0 0 24 24" fill="none" strokeWidth="1.5" stroke="currentColor" className="w-10 h-10 text-green-400">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 7.5l16.5-4.125M12 6.75c-2.708 0-5.363.224-7.948.655C2.999 7.58 2.25 8.507 2.25 9.574v9.176A2.25 2.25 0 004.5 21h15a2.25 2.25 0 002.25-2.25V9.574c0-1.067-.75-1.994-1.802-2.169A48.329 48.329 0 0012 6.75zm-1.683 6.443l-.005.005-.006-.005.006-.005.005.005zm-.005 2.146l-.005-.005.005-.006.006.006-.006.005zm-2.116-.006l-.005.005-.006-.005.005-.005.006.005zm-.005-2.146l-.006-.005.006-.005.005.005-.005.005z" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-white">eQSO ASORAPA</h1>
          <p className="text-sm text-gray-400 mt-1">Enlace CB27 via Internet</p>
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 space-y-5">
          {error && (
            <div className="bg-red-950/50 border border-red-800 text-red-300 text-sm rounded-lg px-4 py-3">
              {error}
            </div>
          )}

          {/* SERVER PRESET SELECTOR */}
          <div>
            <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1.5">
              Servidor eQSO
            </label>
            <select
              value={chosenServerId}
              onChange={(e) => setChosenServerId(e.target.value)}
              disabled={isConnected}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-white focus:outline-none focus:border-green-500 focus:ring-1 focus:ring-green-500 text-sm disabled:opacity-60"
            >
              {serverList.map((s) => (
                <option key={s.id} value={s.id}>{s.label}</option>
              ))}
            </select>
            {chosenServer.description && (
              <p className="text-xs text-gray-500 mt-1 ml-1">{chosenServer.description}</p>
            )}
          </div>

          {/* HOST + PORT — visible for all remote servers, editable */}
          {isRemote && (
            <div className="flex gap-2">
              <div className="flex-1">
                <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1.5">
                  IP / Hostname
                </label>
                <input
                  type="text"
                  value={editHost}
                  onChange={(e) => setEditHost(e.target.value)}
                  placeholder="192.168.1.1 o servidor.eqso.net"
                  disabled={isConnected}
                  spellCheck={false}
                  autoCapitalize="none"
                  autoCorrect="off"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-white placeholder-gray-600 focus:outline-none focus:border-green-500 focus:ring-1 focus:ring-green-500 font-mono text-sm disabled:opacity-60"
                />
              </div>
              <div className="w-24">
                <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1.5">
                  Puerto
                </label>
                <input
                  type="number"
                  value={editPort}
                  onChange={(e) => setEditPort(Number(e.target.value))}
                  min={1}
                  max={65535}
                  disabled={isConnected}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-white focus:outline-none focus:border-green-500 focus:ring-1 focus:ring-green-500 font-mono text-sm disabled:opacity-60"
                />
              </div>
            </div>
          )}

          <div className="border-t border-gray-800" />

          {/* CALLSIGN */}
          <div>
            <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1.5">
              Indicativo / Callsign
            </label>

            {isAuthenticated ? (
              /* Authenticated: show identity badge, callsign fixed from session */
              <div className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 ${
                isRelay
                  ? "border-orange-800 bg-orange-950/30"
                  : "border-green-800 bg-green-950/30"
              }`}>
                <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 ${
                  isRelay ? "bg-orange-800 text-orange-100" : "bg-green-800 text-green-100"
                }`}>
                  {displayCallsign![0]}
                </div>
                <div className="min-w-0">
                  <p className="font-mono font-bold text-white text-sm">{displayCallsign}</p>
                  <p className="text-xs text-gray-500">
                    {isRelay ? "Radioenlace (0R-)" : "Usuario normal"}
                  </p>
                </div>
              </div>
            ) : (
              /* Legacy unauthenticated: 0R- prefix + editable callsign */
              <>
                <div className="flex items-center bg-gray-800 border border-gray-700 rounded-lg focus-within:border-green-500 focus-within:ring-1 focus-within:ring-green-500 overflow-hidden">
                  <span className="px-2.5 py-2.5 text-green-400 font-mono text-sm select-none border-r border-gray-700 bg-gray-900">0R-</span>
                  <input
                    type="text"
                    value={callsign}
                    onChange={(e) => onCallsignChange(e.target.value.toUpperCase())}
                    placeholder="IN80AU"
                    maxLength={10}
                    className="flex-1 bg-transparent px-3 py-2.5 text-white placeholder-gray-600 focus:outline-none font-mono text-sm"
                  />
                </div>
                {callsign.length > 0 && (
                  <p className="mt-1 text-xs text-gray-600">
                    Apareceras como:{" "}
                    <span className="font-mono text-green-400">0R-{callsign.toUpperCase()}</span>
                  </p>
                )}
                <p className="mt-1 text-xs text-gray-600">
                  Maximo 10 caracteres (ej: <span className="font-mono">EA4RCH</span> o <span className="font-mono">IN80AU</span>)
                </p>
              </>
            )}
          </div>

          {/* ROOM */}
          <div>
            <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1.5">
              Sala / Room
            </label>
            <select
              value={selectedRoom}
              onChange={(e) => onRoomChange(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-white focus:outline-none focus:border-green-500 focus:ring-1 focus:ring-green-500 text-sm"
            >
              {availableRooms.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </div>

          {/* STATUS MESSAGE */}
          <div>
            <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1.5">
              Mensaje de estado{" "}
              <span className="text-gray-600 font-normal normal-case">(opcional)</span>
            </label>
            <input
              type="text"
              value={statusMessage}
              onChange={(e) => onStatusMessageChange(e.target.value)}
              placeholder="CB27 link via internet..."
              maxLength={100}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-white placeholder-gray-600 focus:outline-none focus:border-green-500 focus:ring-1 focus:ring-green-500 text-sm"
            />
          </div>

          {/* PASSWORD */}
          <div>
            <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1.5">
              Contraseña del servidor{" "}
              <span className="text-gray-600 font-normal normal-case">(si se requiere)</span>
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => onPasswordChange(e.target.value)}
              placeholder="Dejar en blanco si no hay contrasena"
              autoComplete="current-password"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-white placeholder-gray-600 focus:outline-none focus:border-green-500 focus:ring-1 focus:ring-green-500 text-sm"
            />
          </div>

          {/* ACTIONS */}
          {!isConnected ? (
            <button
              onClick={handleConnect}
              disabled={!canConnect}
              className="w-full bg-green-600 hover:bg-green-500 disabled:bg-gray-700 disabled:text-gray-500 text-white font-semibold rounded-lg py-3 transition-colors"
            >
              {isConnecting ? "Conectando..." : "Conectar al servidor"}
            </button>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-green-400 text-sm">
                <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse flex-shrink-0" />
                <span>
                  Conectado
                  {connectedServerLabel ? (
                    <span className="text-white"> · {connectedServerLabel}</span>
                  ) : null}
                </span>
              </div>
              <button
                onClick={onJoin}
                disabled={isAuthenticated ? !displayCallsign : !callsign.trim()}
                className="w-full bg-green-600 hover:bg-green-500 disabled:bg-gray-700 disabled:text-gray-500 text-white font-semibold rounded-lg py-3 transition-colors"
              >
                Entrar a la sala #{selectedRoom}
              </button>
              <button
                onClick={handleChangeServer}
                className="w-full text-xs text-gray-500 hover:text-gray-300 py-1 transition-colors"
              >
                Cambiar servidor
              </button>
            </div>
          )}
        </div>

        <div className="mt-4 bg-gray-900/50 border border-gray-800 rounded-lg p-4">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
            Clientes Windows eQSO
          </p>
          <p className="text-xs text-gray-500 leading-relaxed">
            Conecta desde Windows directamente al servidor local TCP puerto{" "}
            <span className="text-green-400 font-mono">2171</span>. Compatible al 100%
            con el cliente eQSO original.
          </p>
        </div>
      </div>
    </div>
  );
}
