import { useState, useEffect, useRef, useCallback } from "react";
import { useEqsoClient, EqsoServer } from "@/hooks/useEqsoClient";
import { useAudio } from "@/hooks/useAudio";
import { ConnectPanel } from "@/components/ConnectPanel";
import { RoomPanel } from "@/components/RoomPanel";
import { LoginPanel, type AuthSession } from "@/components/LoginPanel";
import { AdminPanel } from "@/components/AdminPanel";

export default function HomePage() {
  const audioRef = useRef<ReturnType<typeof useAudio> | null>(null);
  const audio = useAudio();
  audioRef.current = audio;

  const eqso = useEqsoClient(
    useCallback((data: ArrayBuffer, isFloat32: boolean) => {
      audioRef.current?.playAudio(data, isFloat32);
    }, [])
  );

  const [auth, setAuth] = useState<AuthSession | null>(null);
  const [showAdmin, setShowAdmin] = useState(false);
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

    const mode = eqso.selectedServer.mode === "remote" ? "remote" : "local";
    await audio.startRecording((chunk) => {
      pttChunkRef.current(chunk);
    }, mode);
  }, [pttActive, eqso, audio]);

  const pttEnd = useCallback(() => {
    if (!pttActive) return;
    audio.stopRecording();
    eqso.pttEnd();
    setPttActive(false);
    audio.muteRx(false);
  }, [pttActive, audio, eqso]);

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
        <AppHeader auth={auth} onLogout={handleLogout} onAdmin={() => setShowAdmin(true)} />
        <AdminPanel token={auth.token} onClose={() => setShowAdmin(false)} />
      </div>
    );
  }

  // ── Main radio UI ──────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 flex flex-col">
      <AppHeader
        auth={auth}
        eqsoStatus={eqso.status}
        onLogout={handleLogout}
        onAdmin={() => setShowAdmin(true)}
      />
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
              setSelectedRoom(room);
              eqso.join(eqso.currentName!, room, "", "", auth?.token);
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
  onLogout?: () => void;
  onAdmin?: () => void;
}

function AppHeader({ auth, eqsoStatus, onLogout, onAdmin }: AppHeaderProps) {
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
