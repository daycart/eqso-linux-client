import { useState, useEffect, useRef, useCallback } from "react";
import { useEqsoClient, EqsoServer } from "@/hooks/useEqsoClient";
import { useAudio } from "@/hooks/useAudio";
import { ConnectPanel } from "@/components/ConnectPanel";
import { RoomPanel } from "@/components/RoomPanel";

export default function HomePage() {
  const eqso = useEqsoClient();
  const audio = useAudio();
  const [callsign, setCallsign] = useState("");
  const [selectedRoom, setSelectedRoom] = useState("GENERAL");
  const [statusMessage, setStatusMessage] = useState("CB27 link via internet. ");
  const [password, setPassword] = useState("");
  const [pttActive, setPttActive] = useState(false);
  const pttChunkRef = useRef<(data: ArrayBuffer) => void>(() => {});

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
    eqso.join(callsign.trim(), selectedRoom, statusMessage, password);
  };

  const pttStart = useCallback(async () => {
    if (pttActive || !eqso.currentRoom) return;
    eqso.pttStart();
    setPttActive(true);

    await audio.startRecording((chunk) => {
      pttChunkRef.current(chunk);
    });
  }, [pttActive, eqso, audio]);

  const pttEnd = useCallback(() => {
    if (!pttActive) return;
    audio.stopRecording();
    eqso.pttEnd();
    setPttActive(false);
  }, [pttActive, audio, eqso]);

  useEffect(() => {
    pttChunkRef.current = (data: ArrayBuffer) => {
      if (eqso.pttGranted) {
        eqso.sendAudio(data);
      }
    };
  }, [eqso]);

  useEffect(() => {
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
  }, [pttStart, pttEnd]);

  const isInRoom = !!eqso.currentRoom;

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 flex flex-col">
      <header className="border-b border-gray-800 px-6 py-3 flex items-center gap-3">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-full bg-green-600 flex items-center justify-center">
            <svg viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5 text-white">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14H9V8h2v8zm4 0h-2V8h2v8z"/>
            </svg>
          </div>
          <span className="font-bold text-lg tracking-wide">eQSO Linux</span>
          <span className="text-xs text-gray-500 font-mono">CB27 / Radio Link</span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {eqso.status === "connected" && (
            <span className="flex items-center gap-1.5 text-xs text-green-400">
              <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
              Conectado al servidor
            </span>
          )}
          {eqso.status === "connecting" && (
            <span className="flex items-center gap-1.5 text-xs text-yellow-400">
              <span className="w-2 h-2 rounded-full bg-yellow-400" />
              Conectando...
            </span>
          )}
          {(eqso.status === "disconnected" || eqso.status === "error") && (
            <span className="flex items-center gap-1.5 text-xs text-gray-500">
              <span className="w-2 h-2 rounded-full bg-gray-500" />
              Desconectado
            </span>
          )}
        </div>
      </header>

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
              eqso.join(eqso.currentName!, room);
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
