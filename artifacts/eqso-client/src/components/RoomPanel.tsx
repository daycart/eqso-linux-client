import { RoomMember } from "@/hooks/useEqsoClient";

interface RoomPanelProps {
  currentRoom: string;
  currentName: string;
  members: RoomMember[];
  activeSpeaker: string | null;
  pttActive: boolean;
  pttGranted: boolean;
  channelBusy: boolean;
  isRecording: boolean;
  isMicAllowed: boolean | null;
  inputLevel: number;
  rooms: string[];
  selectedRoom: string;
  onRoomChange: (room: string) => void;
  onPttStart: () => void;
  onPttEnd: () => void;
  onDisconnect: () => void;
}

export function RoomPanel({
  currentRoom,
  currentName,
  members,
  activeSpeaker,
  pttActive,
  pttGranted,
  channelBusy,
  isRecording,
  isMicAllowed,
  inputLevel,
  rooms,
  selectedRoom,
  onRoomChange,
  onPttStart,
  onPttEnd,
  onDisconnect,
}: RoomPanelProps) {
  const allMembers: RoomMember[] = [
    { name: currentName, message: "Tú" },
    ...members,
  ];

  return (
    <div className="flex flex-1 overflow-hidden">
      <aside className="w-64 border-r border-gray-800 bg-gray-900 flex flex-col">
        <div className="px-4 py-3 border-b border-gray-800">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Salas</p>
          <div className="space-y-0.5">
            {rooms.map((room) => (
              <button
                key={room}
                onClick={() => onRoomChange(room)}
                className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${
                  room === currentRoom
                    ? "bg-green-900/50 text-green-300 font-medium"
                    : "text-gray-400 hover:bg-gray-800 hover:text-gray-200"
                }`}
              >
                # {room}
              </button>
            ))}
          </div>
        </div>

        <div className="px-4 py-3 flex-1">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
            Usuarios en #{currentRoom} ({allMembers.length})
          </p>
          <div className="space-y-1">
            {allMembers.map((m) => (
              <div
                key={m.name}
                className={`flex items-center gap-2 px-2 py-1.5 rounded-lg ${
                  activeSpeaker === m.name ? "bg-yellow-900/30" : ""
                }`}
              >
                <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 ${
                  m.name === currentName
                    ? "bg-green-700 text-green-100"
                    : "bg-gray-700 text-gray-300"
                }`}>
                  {m.name[0]}
                </div>
                <div className="min-w-0">
                  <p className={`text-sm font-mono truncate ${
                    activeSpeaker === m.name ? "text-yellow-300" : "text-gray-200"
                  }`}>
                    {m.name}
                    {m.name === currentName && (
                      <span className="text-gray-500 font-sans text-xs ml-1">(tú)</span>
                    )}
                  </p>
                  {m.message && m.name !== currentName && (
                    <p className="text-xs text-gray-500 truncate">{m.message}</p>
                  )}
                </div>
                {activeSpeaker === m.name && (
                  <div className="ml-auto flex-shrink-0">
                    <span className="flex gap-0.5">
                      {[1,2,3].map((i) => (
                        <span key={i} className="w-0.5 h-3 bg-yellow-400 rounded-full animate-pulse" style={{ animationDelay: `${i * 100}ms` }} />
                      ))}
                    </span>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="px-4 py-3 border-t border-gray-800">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-7 h-7 rounded-full bg-green-700 flex items-center justify-center text-xs font-bold text-green-100 flex-shrink-0">
              {currentName[0]}
            </div>
            <div className="min-w-0">
              <p className="text-sm font-mono text-white truncate">{currentName}</p>
              <p className="text-xs text-green-400"># {currentRoom}</p>
            </div>
          </div>
          <button
            onClick={onDisconnect}
            className="w-full text-xs text-red-400 hover:text-red-300 py-1.5 border border-red-900/50 hover:border-red-700 rounded-lg transition-colors"
          >
            Desconectar
          </button>
        </div>
      </aside>

      <div className="flex-1 flex flex-col bg-gray-950">
        <div className="border-b border-gray-800 px-6 py-3 flex items-center gap-3">
          <span className="text-gray-400 text-lg">#</span>
          <span className="font-bold text-white">{currentRoom}</span>
          <span className="text-gray-600 text-sm">{allMembers.length} usuario{allMembers.length !== 1 ? "s" : ""}</span>
          {channelBusy && !pttActive && (
            <div className="ml-auto flex items-center gap-2 bg-yellow-900/30 border border-yellow-700/50 rounded-full px-3 py-1">
              <span className="flex gap-0.5">
                {[1,2,3].map((i) => (
                  <span key={i} className="w-0.5 h-3 bg-yellow-400 rounded-full animate-pulse" style={{ animationDelay: `${i * 100}ms` }} />
                ))}
              </span>
              <span className="text-yellow-300 text-xs font-medium">
                {activeSpeaker ? `${activeSpeaker} transmitiendo` : "Canal ocupado"}
              </span>
            </div>
          )}
        </div>

        <div className="flex-1 flex flex-col items-center justify-center p-8">
          <div className="text-center mb-10">
            <p className="text-gray-500 text-sm mb-1">Sala activa</p>
            <p className="text-3xl font-bold font-mono text-white"># {currentRoom}</p>
            <p className="text-gray-500 text-sm mt-1 font-mono">{currentName}</p>
          </div>

          {isMicAllowed === false && (
            <div className="mb-6 bg-red-950/50 border border-red-800 text-red-300 text-sm rounded-lg px-4 py-3 text-center max-w-sm">
              Micrófono denegado. Activa los permisos del micrófono en tu navegador para poder transmitir.
            </div>
          )}

          <div className="flex flex-col items-center gap-6">
            <div className="relative">
              <button
                onMouseDown={onPttStart}
                onMouseUp={onPttEnd}
                onTouchStart={(e) => { e.preventDefault(); onPttStart(); }}
                onTouchEnd={(e) => { e.preventDefault(); onPttEnd(); }}
                disabled={channelBusy && !pttActive}
                className={`w-40 h-40 rounded-full flex flex-col items-center justify-center gap-2 transition-all duration-150 select-none touch-none
                  ${pttActive && pttGranted
                    ? "bg-red-600 scale-95 shadow-lg shadow-red-900/50 border-4 border-red-400"
                    : pttActive && !pttGranted
                    ? "bg-orange-700 scale-95 border-4 border-orange-500"
                    : channelBusy
                    ? "bg-gray-800 border-4 border-gray-700 cursor-not-allowed opacity-60"
                    : "bg-green-700 hover:bg-green-600 active:scale-95 border-4 border-green-500 shadow-lg shadow-green-900/30 cursor-pointer"
                  }`}
              >
                <svg viewBox="0 0 24 24" fill="currentColor" className={`w-14 h-14 ${pttActive && pttGranted ? "text-red-100" : "text-white"}`}>
                  <path d="M12 2a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z"/>
                  <path d="M19 10v1a7 7 0 0 1-14 0v-1h2v1a5 5 0 0 0 10 0v-1h2z"/>
                  <rect x="11" y="18" width="2" height="4"/>
                </svg>
                <span className="text-xs font-bold text-white/80 uppercase tracking-widest">
                  {pttActive && pttGranted ? "TX" : pttActive ? "..." : "PTT"}
                </span>
              </button>

              {pttActive && pttGranted && isRecording && (
                <div className="absolute -bottom-2 left-1/2 -translate-x-1/2 flex gap-0.5">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <div
                      key={i}
                      className="w-1 rounded-full bg-red-400 animate-pulse"
                      style={{
                        height: `${Math.max(4, inputLevel * 24 * (0.5 + Math.random() * 0.5))}px`,
                        animationDelay: `${i * 60}ms`,
                      }}
                    />
                  ))}
                </div>
              )}
            </div>

            <div className="text-center">
              <p className="text-gray-500 text-sm">
                {pttActive && pttGranted
                  ? "Transmitiendo... suelta para dejar de hablar"
                  : pttActive
                  ? "Esperando..."
                  : channelBusy
                  ? "Canal ocupado"
                  : "Mantén pulsado para hablar"}
              </p>
              <p className="text-gray-600 text-xs mt-1">
                También puedes usar la barra espaciadora
              </p>
            </div>
          </div>
        </div>

        <div className="border-t border-gray-800 px-6 py-3 flex items-center gap-4">
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${isRecording ? "bg-red-500 animate-pulse" : "bg-gray-600"}`} />
            <span className="text-xs text-gray-500">Micrófono</span>
          </div>
          {isRecording && (
            <div className="flex items-center gap-1">
              {Array.from({ length: 10 }).map((_, i) => (
                <div
                  key={i}
                  className="w-0.5 rounded-full bg-red-400 transition-all duration-100"
                  style={{ height: `${Math.max(2, inputLevel * 16 * Math.random())}px` }}
                />
              ))}
            </div>
          )}
          <div className="ml-auto text-xs text-gray-600 font-mono">
            TCP :2171 | WS /ws
          </div>
        </div>
      </div>
    </div>
  );
}
