import { ConnectionStatus } from "@/hooks/useEqsoClient";

interface ConnectPanelProps {
  status: ConnectionStatus;
  error: string | null;
  rooms: string[];
  callsign: string;
  selectedRoom: string;
  statusMessage: string;
  onCallsignChange: (v: string) => void;
  onRoomChange: (v: string) => void;
  onStatusMessageChange: (v: string) => void;
  onConnect: () => void;
  onJoin: () => void;
}

export function ConnectPanel({
  status,
  error,
  rooms,
  callsign,
  selectedRoom,
  statusMessage,
  onCallsignChange,
  onRoomChange,
  onStatusMessageChange,
  onConnect,
  onJoin,
}: ConnectPanelProps) {
  const isConnected = status === "connected";
  const isConnecting = status === "connecting";

  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="w-20 h-20 rounded-full bg-green-900/40 border-2 border-green-600 flex items-center justify-center mx-auto mb-4">
            <svg viewBox="0 0 24 24" fill="none" strokeWidth="1.5" stroke="currentColor" className="w-10 h-10 text-green-400">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 7.5l16.5-4.125M12 6.75c-2.708 0-5.363.224-7.948.655C2.999 7.58 2.25 8.507 2.25 9.574v9.176A2.25 2.25 0 004.5 21h15a2.25 2.25 0 002.25-2.25V9.574c0-1.067-.75-1.994-1.802-2.169A48.329 48.329 0 0012 6.75zm-1.683 6.443l-.005.005-.006-.005.006-.005.005.005zm-.005 2.146l-.005-.005.005-.006.006.006-.006.005zm-2.116-.006l-.005.005-.006-.005.005-.005.006.005zm-.005-2.146l-.006-.005.006-.005.005.005-.005.005z" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-white">eQSO Linux Client</h1>
          <p className="text-sm text-gray-400 mt-1">Enlace CB27 via Internet</p>
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 space-y-5">
          {error && (
            <div className="bg-red-950/50 border border-red-800 text-red-300 text-sm rounded-lg px-4 py-3">
              {error}
            </div>
          )}

          <div>
            <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1.5">
              Indicativo / Callsign
            </label>
            <input
              type="text"
              value={callsign}
              onChange={(e) => onCallsignChange(e.target.value.toUpperCase())}
              placeholder="EA4XYZ o 27CB123"
              maxLength={20}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-white placeholder-gray-600 focus:outline-none focus:border-green-500 focus:ring-1 focus:ring-green-500 font-mono text-sm"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1.5">
              Sala / Room
            </label>
            <select
              value={selectedRoom}
              onChange={(e) => onRoomChange(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-white focus:outline-none focus:border-green-500 focus:ring-1 focus:ring-green-500 text-sm"
            >
              {rooms.length > 0 ? (
                rooms.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))
              ) : (
                <>
                  <option value="GENERAL">GENERAL</option>
                  <option value="CB27">CB27</option>
                  <option value="ASORAPA">ASORAPA</option>
                </>
              )}
            </select>
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1.5">
              Mensaje de estado (opcional)
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

          {!isConnected ? (
            <button
              onClick={onConnect}
              disabled={isConnecting}
              className="w-full bg-green-600 hover:bg-green-500 disabled:bg-gray-700 disabled:text-gray-500 text-white font-semibold rounded-lg py-3 transition-colors"
            >
              {isConnecting ? "Conectando..." : "Conectar al servidor"}
            </button>
          ) : (
            <button
              onClick={onJoin}
              disabled={!callsign.trim()}
              className="w-full bg-green-600 hover:bg-green-500 disabled:bg-gray-700 disabled:text-gray-500 text-white font-semibold rounded-lg py-3 transition-colors"
            >
              Entrar a la sala
            </button>
          )}
        </div>

        <div className="mt-6 bg-gray-900/50 border border-gray-800 rounded-lg p-4">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Clientes Windows eQSO</p>
          <p className="text-xs text-gray-500 leading-relaxed">
            Los clientes eQSO para Windows pueden conectarse directamente al servidor TCP en el puerto <span className="text-green-400 font-mono">2171</span>. Son totalmente compatibles con este servidor.
          </p>
        </div>
      </div>
    </div>
  );
}
