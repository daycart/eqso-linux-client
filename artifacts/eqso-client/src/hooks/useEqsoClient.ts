import { useCallback, useEffect, useRef, useState } from "react";

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

export interface RoomMember {
  name: string;
  message: string;
}

export interface EqsoState {
  status: ConnectionStatus;
  error: string | null;
  rooms: string[];
  currentRoom: string | null;
  currentName: string | null;
  members: RoomMember[];
  activeSpeaker: string | null;
  pttGranted: boolean;
  channelBusy: boolean;
}

export interface EqsoActions {
  connect: () => void;
  disconnect: () => void;
  join: (name: string, room: string, message?: string) => void;
  pttStart: () => void;
  pttEnd: () => void;
  sendAudio: (data: ArrayBuffer) => void;
}

function getWsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host = window.location.host;
  const base = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
  return `${proto}//${host}${base}/ws`;
}

export function useEqsoClient(): EqsoState & EqsoActions {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const [error, setError] = useState<string | null>(null);
  const [rooms, setRooms] = useState<string[]>([]);
  const [currentRoom, setCurrentRoom] = useState<string | null>(null);
  const [currentName, setCurrentName] = useState<string | null>(null);
  const [members, setMembers] = useState<RoomMember[]>([]);
  const [activeSpeaker, setActiveSpeaker] = useState<string | null>(null);
  const [pttGranted, setPttGranted] = useState(false);
  const [channelBusy, setChannelBusy] = useState(false);

  const handleMessage = useCallback((ev: MessageEvent) => {
    try {
      if (ev.data instanceof Blob || ev.data instanceof ArrayBuffer) {
        return;
      }
      const msg = JSON.parse(ev.data as string);
      switch (msg.type) {
        case "room_list":
          setRooms(msg.rooms ?? []);
          break;
        case "server_info":
          break;
        case "joined":
          setCurrentRoom(msg.room ?? null);
          setCurrentName(msg.name ?? null);
          setMembers(msg.members ?? []);
          break;
        case "error":
          setError(msg.message ?? "Unknown error");
          break;
        case "ptt_granted":
          setPttGranted(true);
          setChannelBusy(false);
          break;
        case "ptt_denied":
          setPttGranted(false);
          setChannelBusy(true);
          setTimeout(() => setChannelBusy(false), 2000);
          break;
        case "ptt_released":
          setPttGranted(false);
          break;
        case "keepalive":
          break;
        case "pong":
          break;
        default:
          break;
      }
    } catch {
    }
  }, []);

  const handleBinary = useCallback((_data: ArrayBuffer) => {
    const view = new Uint8Array(_data);
    if (view.length < 1) return;

    const cmd = view[0];
    if (cmd === 0x01) {
      return;
    }
    if (cmd === 0x16 && view.length >= 2) {
      const count = view[1];
      if (count === 1 && view.length >= 9) {
        const action = view[4];
        let off = 8;
        if (off >= view.length) return;
        const nameLen = view[off++];
        if (off + nameLen > view.length) return;
        const name = new TextDecoder().decode(view.slice(off, off + nameLen));

        if (action === 0x00) {
          const msgLen = view.length > off + nameLen ? view[off + nameLen] : 0;
          const msg = msgLen > 0
            ? new TextDecoder().decode(view.slice(off + nameLen + 1, off + nameLen + 1 + msgLen))
            : "";
          setMembers((prev) => {
            if (prev.some((m) => m.name === name)) return prev;
            return [...prev, { name, message: msg }];
          });
        } else if (action === 0x01) {
          setMembers((prev) => prev.filter((m) => m.name !== name));
        } else if (action === 0x02) {
          setActiveSpeaker(name);
          setChannelBusy(true);
        } else if (action === 0x03) {
          setActiveSpeaker(null);
          setChannelBusy(false);
        }
      } else if (count > 0) {
        const newMembers: RoomMember[] = [];
        let off = 4;
        for (let i = 0; i < count; i++) {
          if (off + 5 >= view.length) break;
          off += 5;
          if (off >= view.length) break;
          const nameLen = view[off++];
          if (off + nameLen > view.length) break;
          const name = new TextDecoder().decode(view.slice(off, off + nameLen));
          off += nameLen;
          const msgLen = view[off++];
          const msg = msgLen > 0
            ? new TextDecoder().decode(view.slice(off, off + msgLen))
            : "";
          off += msgLen;
          newMembers.push({ name, message: msg });
        }
        if (newMembers.length > 0) {
          setMembers(newMembers);
        }
      }
    }
  }, []);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;
    setStatus("connecting");
    setError(null);

    const ws = new WebSocket(getWsUrl());
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus("connected");
      setError(null);
    };

    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        handleBinary(ev.data);
      } else {
        handleMessage(ev);
      }
    };

    ws.onclose = () => {
      setStatus("disconnected");
      setCurrentRoom(null);
      setCurrentName(null);
      setMembers([]);
      setActiveSpeaker(null);
      setPttGranted(false);
    };

    ws.onerror = () => {
      setStatus("error");
      setError("Could not connect to eQSO server");
    };
  }, [handleMessage, handleBinary]);

  const disconnect = useCallback(() => {
    if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    wsRef.current?.close();
    wsRef.current = null;
    setStatus("disconnected");
    setCurrentRoom(null);
    setCurrentName(null);
    setMembers([]);
  }, []);

  const join = useCallback((name: string, room: string, message = "") => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "join", name: name.toUpperCase(), room: room.toUpperCase(), message }));
  }, []);

  const pttStart = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "ptt_start" }));
  }, []);

  const pttEnd = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "ptt_end" }));
  }, []);

  const sendAudio = useCallback((data: ArrayBuffer) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !pttGranted) return;
    const header = new Uint8Array([0x01]);
    const payload = new Uint8Array(data);
    const pkt = new Uint8Array(header.length + payload.length);
    pkt.set(header, 0);
    pkt.set(payload, 1);
    ws.send(pkt.buffer);
  }, [pttGranted]);

  useEffect(() => {
    return () => {
      wsRef.current?.close();
    };
  }, []);

  return {
    status,
    error,
    rooms,
    currentRoom,
    currentName,
    members,
    activeSpeaker,
    pttGranted,
    channelBusy,
    connect,
    disconnect,
    join,
    pttStart,
    pttEnd,
    sendAudio,
  };
}
