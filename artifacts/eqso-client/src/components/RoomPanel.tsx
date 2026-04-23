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
  isRemote: boolean;
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
  isRemote,
  onRoomChange,
  onPttStart,
  onPttEnd,
  onDisconnect,
}: RoomPanelProps) {
  const seen = new Set<string>([currentName]);
  const allMembers: RoomMember[] = [
    { name: currentName, message: "Tú" },
    ...members.reduce<RoomMember[]>((acc, m) => {
      const n = m.name.trim();
      if (!n || n === currentName || seen.has(n)) return acc;
      seen.add(n);
      acc.push({ name: n, message: m.message });
      return acc;
    }, []),
  ];

  const currentIsRelay = currentName.startsWith("0R-");
  const radioLinks = allMembers.filter(
    (m) => m.name !== currentName && m.name.trim().startsWith("0R-")
  );
  // Incluir al propio usuario si es un radioenlace
  const totalRelayCount = radioLinks.length + (currentIsRelay ? 1 : 0);
  const hasRadioLinks = totalRelayCount > 0;

  return (
    <div className="flex flex-1 overflow-hidden">
      <aside className="w-64 border-r border-gray-800 bg-gray-900 flex flex-col">
        <div className="px-4 py-3 border-b border-gray-800">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Salas</p>
          <div className="space-y-0.5">
            {rooms.map((room) => {
              const isActive = room === currentRoom;
              return (
                <button
                  key={room}
                  onClick={() => onRoomChange(room)}
                  title={isActive ? `Sala activa: #${room}` : `Cambiar a sala #${room}`}
                  className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors flex items-center justify-between gap-1 ${
                    isActive
                      ? "bg-green-900/50 text-green-300 font-medium"
                      : "text-gray-500 hover:bg-gray-800 hover:text-gray-300"
                  }`}
                >
                  <span># {room}</span>
                  {isActive && (
                    <span className="w-1.5 h-1.5 rounded-full bg-green-400 flex-shrink-0" />
                  )}
                </button>
              );
            })}
          </div>
        </div>

        <div className="px-4 py-3 flex-1 overflow-y-auto">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
            Usuarios en #{currentRoom} ({allMembers.length})
          </p>
          <div className="space-y-1">
            {allMembers.map((m) => {
              const isRadioLink = m.name.startsWith("0R-");
              const isSelf = m.name === currentName;
              const isSelfTx = isSelf && pttActive && pttGranted;
              const isSpeaking = activeSpeaker === m.name;
              const initials = m.name.replace(/^0R-/, "").slice(0, 2).toUpperCase();
              return (
                <div
                  key={m.name}
                  className={`flex items-center gap-2 px-2 py-1.5 rounded-lg transition-colors ${
                    isSelfTx
                      ? "bg-red-900/30"
                      : isSpeaking
                      ? "bg-yellow-900/30"
                      : ""
                  }`}
                >
                  <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 ${
                    isSelfTx
                      ? "bg-red-700 text-red-100"
                      : isSelf && isRadioLink
                      ? "bg-green-700 text-green-100"
                      : isSelf
                      ? "bg-green-700 text-green-100"
                      : isSpeaking
                      ? "bg-yellow-700 text-yellow-100"
                      : isRadioLink
                      ? "bg-blue-800 text-blue-100"
                      : "bg-gray-700 text-gray-300"
                  }`}>
                    {isRadioLink ? (
                      <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
                        <path d="M4.5 6.375a4.125 4.125 0 1 1 8.25 0 4.125 4.125 0 0 1-8.25 0ZM14.25 8.625a3.375 3.375 0 1 1 6.75 0 3.375 3.375 0 0 1-6.75 0ZM1.5 19.125a7.125 7.125 0 0 1 14.25 0v.003l-.001.119a.75.75 0 0 1-.363.63 13.067 13.067 0 0 1-6.761 1.873c-2.472 0-4.786-.684-6.76-1.873a.75.75 0 0 1-.364-.63l-.001-.122ZM17.25 19.128l-.001.144a2.25 2.25 0 0 1-.233.96 10.088 10.088 0 0 0 5.06-1.01.75.75 0 0 0 .42-.643 4.875 4.875 0 0 0-6.957-4.611 8.586 8.586 0 0 1 1.71 5.157v.003Z" />
                      </svg>
                    ) : (
                      initials
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className={`text-sm font-mono truncate ${
                      isSelfTx
                        ? "text-red-300"
                        : isSpeaking
                        ? "text-yellow-300"
                        : isSelf
                        ? "text-green-300"
                        : isRadioLink
                        ? "text-blue-300"
                        : "text-gray-200"
                    }`}>
                      {m.name}
                      {isSelf && (
                        <span className="text-gray-500 font-sans text-xs ml-1">(tú)</span>
                      )}
                    </p>
                    {isRadioLink && (
                      <p className={`text-xs ${isSelf ? "text-green-600" : "text-blue-500"}`}>Nodo radioenlace</p>
                    )}
                    {m.message && !isRadioLink && !isSelf && (
                      <p className="text-xs text-gray-500 truncate">{m.message}</p>
                    )}
                  </div>
                  {(isSpeaking || isSelfTx) && (
                    <div className="ml-auto flex-shrink-0 flex items-center gap-0.5">
                      {[120, 60, 180, 90, 150].map((dur, i) => (
                        <span
                          key={i}
                          className={`w-1 rounded-full ${isSelfTx ? "bg-red-400" : "bg-yellow-400"}`}
                          style={{
                            animation: `vuBar ${dur}ms ease-in-out ${i * 40}ms infinite alternate`,
                            minHeight: "4px",
                          }}
                        />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
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
          <div className={`flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full border ${
            hasRadioLinks
              ? "bg-blue-900/30 border-blue-700/50 text-blue-300"
              : "bg-amber-900/30 border-amber-700/50 text-amber-300"
          }`}>
            <span className={`w-1.5 h-1.5 rounded-full ${hasRadioLinks ? "bg-blue-400" : "bg-amber-400 animate-pulse"}`} />
            {hasRadioLinks
              ? `${totalRelayCount} nodo${totalRelayCount !== 1 ? "s" : ""} RF`
              : "Sin nodo RF"}
          </div>
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

          {!hasRadioLinks && (
            <div className="mb-6 bg-amber-950/50 border border-amber-700/60 text-amber-300 text-sm rounded-lg px-4 py-3 text-center max-w-sm">
              <p className="font-semibold mb-1">Sin nodos de radioenlace en la sala</p>
              <p className="text-amber-400/80 text-xs">
                El software Windows del nodo no esta conectado a #{currentRoom}. Tus transmisiones llegan al servidor pero no se emiten por RF.
              </p>
            </div>
          )}

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
                onTouchCancel={(e) => { e.preventDefault(); onPttEnd(); }}
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
