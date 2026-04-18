import { useState, useEffect, useRef, useCallback } from "react";
import { useEqsoClient, EqsoServer } from "@/hooks/useEqsoClient";
import { useAudio } from "@/hooks/useAudio";
import { usePTTSerial } from "@/hooks/usePTTSerial";
import { useServers } from "@/hooks/useServers";
import { ConnectPanel } from "@/components/ConnectPanel";
import { RoomPanel } from "@/components/RoomPanel";
import { LoginPanel, type AuthSession } from "@/components/LoginPanel";
import { AdminPanel } from "@/components/AdminPanel";
import { PTTConfigModal } from "@/components/PTTConfigModal";

export default function HomePage() {
  const audioRef = useRef<ReturnType<typeof useAudio> | null>(null);
  const audio = useAudio();
  audioRef.current = audio;

  const eqso = useEqsoClient(
    useCallback((data: ArrayBuffer, isFloat32: boolean) => {
      audioRef.current?.playAudio(data, isFloat32);
    }, [])
  );

  const serial = usePTTSerial();
  const { servers } = useServers();

  const [auth, setAuth] = useState<AuthSession | null>(null);
  const [showAdmin, setShowAdmin] = useState(false);
  const [showPTTConfig, setShowPTTConfig] = useState(false);
  const [callsign, setCallsign] = useState("");
  const [selectedRoom, setSelectedRoom] = useState("GENERAL");
  const [statusMessage, setStatusMessage] = useState("CB27 link via internet. ");
  const [password, setPassword] = useState("");
  const [pttActive, setPttActive] = useState(false);
  const pttChunkRef = useRef<(data: ArrayBuffer) => void>(() => {});

  const handleAuth = (session: AuthSession) => {
    setAuth(session);
    setCallsign(session.callsign);
    setShowAdmin(false);
  };

  const handleLogout = () => {
    setAuth(null);
    setCallsign("");
    setShowAdmin(false);
    eqso.disconnect();
    audio.stopRecording();
    setPttActive(false);
  };

  const handleConnect = (server: EqsoServer, customHost?: string, customPort?: number) => {
    eqso.connect(server, customHost, customPort);
  };

  const handleDisconnect = () => {
    eqso.disconnect();
    audio.stopRecording();
    setPttActive(false);
  };

  const handleJoin = () => {
    if (!callsign.trim()) return;
    audio.resumeContext();
    eqso.join(callsign.trim(), selectedRoom, statusMessage, password, auth?.token);
  };

  const pttStart = useCallback(async () => {
    if (pttActive || !eqso.currentRoom) return;
    audio.muteRx(true);
    eqso.pttStart();
    setPttActive(true);
    serial.keyDown();

    const mode = eqso.selectedServer.mode === "remote" ? "remote" : "local";
    await audio.startRecording((chunk) => {
      pttChunkRef.current(chunk);
    }, mode);
  }, [pttActive, eqso, audio, serial]);

  const pttEnd = useCallback(() => {
    if (!pttActive) return;
    audio.stopRecording();
    eqso.pttEnd();
    setPttActive(false);
    audio.muteRx(false);
    serial.keyUp();
  }, [pttActive, audio, eqso, serial]);

  useEffect(() => {
    pttChunkRef.current = (data: ArrayBuffer) => {
      eqso.sendAudio(data);
    };
  }, [eqso]);

  useEffect(() => {
    if (showAdmin) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Space" && !e.repeat) {
        e.preventDefault();
        pttStart();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        e.preventDefault();
        pttEnd();
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [pttStart, pttEnd, showAdmin]);

  const isInRoom = !!eqso.currentRoom;

  // ── Not authenticated: show login ──────────────────────────────────────────
  if (!auth) {
    return (
      <div className="min-h-screen bg-gray-950 text-gray-100 flex flex-col">
        <AppHeader />
        <LoginPanel onAuth={handleAuth} />
      </div>
    );
  }

  // ── Admin panel ────────────────────────────────────────────────────────────
  if (showAdmin) {
    return (
      <div className="min-h-screen bg-gray-950 text-gray-100 flex flex-col">
        <AppHeader auth={auth} onLogout={handleLogout} onAdmin={() => setShowAdmin(true)} onPTTConfig={() => setShowPTTConfig(true)} />
        <AdminPanel token={auth.token} onClose={() => setShowAdmin(false)} />
        {showPTTConfig && <PTTConfigModal onClose={() => setShowPTTConfig(false)} />}
      </div>
    );
  }

  // ── Main radio UI ──────────────────────────────────────────────────────────
  const isSecureContext = window.isSecureContext;

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 flex flex-col">
      <AppHeader
        auth={auth}
        eqsoStatus={eqso.status}
        pttConfig={serial.config}
        portOpen={serial.portOpen}
        onLogout={handleLogout}
        onAdmin={() => setShowAdmin(true)}
        onPTTConfig={() => setShowPTTConfig(true)}
      />
      {!isSecureContext && (
        <div className="bg-yellow-900 border-b border-yellow-700 px-4 py-2 text-xs text-yellow-200 text-center">
          Aviso: la pagina se sirve por HTTP sin SSL. El microfono y el audio no funcionaran hasta que el servidor tenga un certificado HTTPS.
        </div>
      )}
      {showPTTConfig && <PTTConfigModal onClose={() => setShowPTTConfig(false)} />}
      <main className="flex flex-1 overflow-hidden">
        {!isInRoom ? (
          <ConnectPanel
            status={eqso.status}
            error={eqso.error}
            rooms={eqso.rooms}
            callsign={callsign}
            selectedRoom={selectedRoom}
            statusMessage={statusMessage}
            password={password}
            selectedServer={eqso.selectedServer}
            servers={servers}
            auth={auth}
            onCallsignChange={setCallsign}
            onRoomChange={setSelectedRoom}
            onStatusMessageChange={setStatusMessage}
            onPasswordChange={setPassword}
            onConnect={handleConnect}
            onJoin={handleJoin}
          />
        ) : (
          <RoomPanel
            currentRoom={eqso.currentRoom!}
            currentName={eqso.currentName!}
            members={eqso.members}
            activeSpeaker={eqso.activeSpeaker}
            pttActive={pttActive}
            pttGranted={eqso.pttGranted}
            channelBusy={eqso.channelBusy}
            isRecording={audio.isRecording}
            isMicAllowed={audio.isMicAllowed}
            inputLevel={audio.inputLevel}
            rooms={eqso.rooms}
            selectedRoom={selectedRoom}
            isRemote={eqso.selectedServer.mode === "remote"}
            onRoomChange={(room) => {
              if (room === eqso.currentRoom) return;
              setSelectedRoom(room);
              eqso.join(eqso.currentName!, room, statusMessage, password, auth?.token);
            }}
            onPttStart={pttStart}
            onPttEnd={pttEnd}
            onDisconnect={handleDisconnect}
          />
        )}
      </main>
    </div>
  );
}

// ── Shared header component ────────────────────────────────────────────────────
interface AppHeaderProps {
  auth?: AuthSession | null;
  eqsoStatus?: string;
  pttConfig?: { method: string; pin: string; invertVoltage: boolean };
  portOpen?: boolean;
  onLogout?: () => void;
  onAdmin?: () => void;
  onPTTConfig?: () => void;
}

function AppHeader({ auth, eqsoStatus, pttConfig, portOpen, onLogout, onAdmin, onPTTConfig }: AppHeaderProps) {
  return (
    <header className="border-b border-gray-800 px-6 py-3 flex items-center gap-3">
      <div className="flex items-center gap-2">
        <div className="w-8 h-8 rounded-full bg-green-600 flex items-center justify-center">
          <svg viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5 text-white">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14H9V8h2v8zm4 0h-2V8h2v8z"/>
          </svg>
        </div>
        <span className="font-bold text-lg tracking-wide">eQSO ASORAPA</span>
        <span className="text-xs text-gray-500 font-mono">CB27 / Radio Link</span>
      </div>

      <div className="ml-auto flex items-center gap-3">
        {/* Connection status */}
        {eqsoStatus === "connected" && (
          <span className="flex items-center gap-1.5 text-xs text-green-400">
            <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
            Conectado
          </span>
        )}
        {eqsoStatus === "connecting" && (
          <span className="flex items-center gap-1.5 text-xs text-yellow-400">
            <span className="w-2 h-2 rounded-full bg-yellow-400" />
            Conectando...
          </span>
        )}
        {(eqsoStatus === "disconnected" || eqsoStatus === "error") && (
          <span className="flex items-center gap-1.5 text-xs text-gray-500">
            <span className="w-2 h-2 rounded-full bg-gray-500" />
            Desconectado
          </span>
        )}

        {/* PTT config button — shown only to admins */}
        {auth && auth.role === "admin" && onPTTConfig && (
          <button
            onClick={onPTTConfig}
            className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-200 px-2 py-1 rounded hover:bg-gray-800 transition-colors border border-gray-700 hover:border-gray-600"
            title="Configurar PTT / Puerto COM"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M10.343 3.94c.09-.542.56-.94 1.11-.94h1.093c.55 0 1.02.398 1.11.94l.149.894c.07.424.384.764.78.93.398.164.855.142 1.205-.108l.737-.527a1.125 1.125 0 011.45.12l.773.774c.39.389.44 1.002.12 1.45l-.527.737c-.25.35-.272.806-.107 1.204.165.397.505.71.93.78l.893.15c.543.09.94.56.94 1.109v1.094c0 .55-.397 1.02-.94 1.11l-.893.149c-.425.07-.765.383-.93.78-.165.398-.143.854.107 1.204l.527.738c.32.447.269 1.06-.12 1.45l-.774.773a1.125 1.125 0 01-1.449.12l-.738-.527c-.35-.25-.806-.272-1.203-.107-.397.165-.71.505-.781.929l-.149.894c-.09.542-.56.94-1.11.94h-1.094c-.55 0-1.019-.398-1.11-.94l-.148-.894c-.071-.424-.384-.764-.781-.93-.398-.164-.854-.142-1.204.108l-.738.527c-.447.32-1.06.269-1.45-.12l-.773-.774a1.125 1.125 0 01-.12-1.45l.527-.737c.25-.35.273-.806.108-1.204-.165-.397-.505-.71-.93-.78l-.894-.15c-.542-.09-.94-.56-.94-1.109v-1.094c0-.55.398-1.02.94-1.11l.894-.149c.424-.07.765-.383.93-.78.165-.398.143-.854-.108-1.204l-.526-.738a1.125 1.125 0 01.12-1.45l.773-.773a1.125 1.125 0 011.45-.12l.737.527c.35.25.807.272 1.204.107.397-.165.71-.505.78-.929l.15-.894z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            PTT
            {pttConfig && (
              <span className="font-mono text-[10px] text-gray-500">
                {pttConfig.method === "COM"
                  ? `COM/${pttConfig.pin}${portOpen ? "" : " !"}`
                  : "VOX"}
              </span>
            )}
          </button>
        )}

        {/* Authenticated user info */}
        {auth && (
          <div className="flex items-center gap-2 border-l border-gray-800 pl-3">
            <span className="flex items-center gap-1.5 text-xs text-gray-400">
              <span className="font-mono text-green-400 font-medium">{auth.callsign}</span>
              {auth.isRelay && (
                <span className="text-[10px] bg-orange-900 text-orange-300 border border-orange-700 rounded px-1 py-0.5">
                  enlace
                </span>
              )}
              {auth.role === "admin" && (
                <span className="text-[10px] bg-blue-900 text-blue-300 border border-blue-700 rounded px-1 py-0.5">
                  admin
                </span>
              )}
            </span>
            {auth.role === "admin" && onAdmin && (
              <button
                onClick={onAdmin}
                className="text-xs text-blue-400 hover:text-blue-300 px-2 py-1 rounded hover:bg-gray-800 transition-colors"
                title="Panel de administracion"
              >
                Admin
              </button>
            )}
            {onLogout && (
              <button
                onClick={onLogout}
                className="text-xs text-gray-500 hover:text-gray-300 px-2 py-1 rounded hover:bg-gray-800 transition-colors"
                title="Cerrar sesion"
              >
                Salir
              </button>
            )}
          </div>
        )}
      </div>
    </header>
  );
}
