import { useCallback, useEffect, useRef, useState } from "react";

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

export interface RoomMember {
  name: string;
  message: string;
}

export interface EqsoServer {
  id: string;
  label: string;
  description: string;
  mode: "local" | "remote";
  host?: string;
  port?: number;
  defaultRooms?: string[];
}

export const KNOWN_SERVERS: EqsoServer[] = [
  {
    id: "local",
    label: "Servidor Local",
    description: "Servidor eQSO propio (Linux)",
    mode: "local",
    defaultRooms: ["GENERAL", "CB27", "ASORAPA", "PRUEBA"],
  },
  {
    id: "asorapa",
    label: "ASORAPA — Radio Club Iria Flavia",
    description: "Enlace CB27 ASORAPA · Galicia",
    mode: "remote",
    host: "asorapa.eqso.net",
    port: 2171,
    defaultRooms: ["ASORAPA", "CB27ES"],
  },
  {
    id: "eqso-main",
    label: "eQSO Principal (server.eqso.net)",
    description: "Servidor oficial eQSO · Puerto 2171",
    mode: "remote",
    host: "server.eqso.net",
    port: 2171,
    defaultRooms: ["101ENGLISH", "SPAIN", "HISPANIC"],
  },
  {
    id: "custom",
    label: "Servidor personalizado...",
    description: "Introduce dirección y puerto manual",
    mode: "remote",
    host: "",
    port: 2171,
    defaultRooms: [],
  },
];

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
  selectedServer: EqsoServer;
}

export interface EqsoActions {
  connect: (server: EqsoServer, customHost?: string, customPort?: number) => void;
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
  const pendingJoinRef = useRef<{ name: string; room: string } | null>(null);

  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const [error, setError] = useState<string | null>(null);
  const [rooms, setRooms] = useState<string[]>([]);
  const [currentRoom, setCurrentRoom] = useState<string | null>(null);
  const [currentName, setCurrentName] = useState<string | null>(null);
  const [members, setMembers] = useState<RoomMember[]>([]);
  const [activeSpeaker, setActiveSpeaker] = useState<string | null>(null);
  const [pttGranted, setPttGranted] = useState(false);
  const [channelBusy, setChannelBusy] = useState(false);
  const [selectedServer, setSelectedServer] = useState<EqsoServer>(KNOWN_SERVERS[0]);

  const handleTextMessage = useCallback((msg: Record<string, unknown>) => {
    switch (msg.type) {
      case "room_list":
        setRooms((msg.rooms as string[]) ?? []);
        break;

      case "server_info":
        break;

      case "joined": {
        const room = msg.room === "__current__" && pendingJoinRef.current
          ? pendingJoinRef.current.room
          : (msg.room as string) ?? null;
        const name = msg.name === "__pending__" && pendingJoinRef.current
          ? pendingJoinRef.current.name
          : (msg.name as string) ?? null;
        setCurrentRoom(room);
        setCurrentName(name);
        setMembers((msg.members as RoomMember[]) ?? []);
        pendingJoinRef.current = null;
        break;
      }

      case "user_joined":
        setMembers((prev) => {
          const m = { name: msg.name as string, message: (msg.message as string) ?? "" };
          if (prev.some((x) => x.name === m.name)) return prev;
          return [...prev, m];
        });
        break;

      case "user_left":
        setMembers((prev) => prev.filter((m) => m.name !== (msg.name as string)));
        break;

      case "ptt_started":
        setActiveSpeaker(msg.name as string);
        setChannelBusy(true);
        break;

      case "ptt_released":
        setPttGranted(false);
        break;

      case "ptt_released_remote":
        setActiveSpeaker(null);
        setChannelBusy(false);
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

      case "disconnected":
        setStatus("disconnected");
        setCurrentRoom(null);
        setCurrentName(null);
        setMembers([]);
        setActiveSpeaker(null);
        break;

      case "error":
        setError((msg.message as string) ?? "Error desconocido");
        break;

      case "keepalive":
      case "pong":
        break;
    }
  }, []);

  const handleBinary = useCallback((data: ArrayBuffer) => {
    const view = new Uint8Array(data);
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
        off += nameLen;

        if (action === 0x00) {
          if (off >= view.length) return;
          const msgLen = view[off++];
          const msg = msgLen > 0 ? new TextDecoder().decode(view.slice(off, off + msgLen)) : "";
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
      } else if (count > 1) {
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
          const msg = msgLen > 0 ? new TextDecoder().decode(view.slice(off, off + msgLen)) : "";
          off += msgLen;
          newMembers.push({ name, message: msg });
        }
        if (newMembers.length > 0) setMembers(newMembers);
      }
    }
  }, []);

  const connect = useCallback((server: EqsoServer, customHost?: string, customPort?: number) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.close();
    }

    setSelectedServer(server);
    setStatus("connecting");
    setError(null);
    setCurrentRoom(null);
    setCurrentName(null);
    setMembers([]);
    setActiveSpeaker(null);
    setPttGranted(false);

    const ws = new WebSocket(getWsUrl());
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    ws.onopen = () => {
      const host = customHost ?? server.host;
      const port = customPort ?? server.port ?? 2171;

      if (server.mode === "remote" && host) {
        ws.send(JSON.stringify({ type: "select_server", mode: "remote", host, port }));
      } else {
        ws.send(JSON.stringify({ type: "select_server", mode: "local" }));
      }
      setStatus("connected");
      setError(null);
    };

    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        handleBinary(ev.data);
      } else {
        try {
          const msg = JSON.parse(ev.data as string);
          handleTextMessage(msg);
        } catch { /* ignore */ }
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
      setError("No se pudo conectar al servidor eQSO");
    };
  }, [handleTextMessage, handleBinary]);

  const disconnect = useCallback(() => {
    wsRef.current?.close();
    wsRef.current = null;
    setStatus("disconnected");
    setCurrentRoom(null);
    setCurrentName(null);
    setMembers([]);
    setPttGranted(false);
    pendingJoinRef.current = null;
  }, []);

  const join = useCallback((name: string, room: string, message = "") => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    pendingJoinRef.current = { name, room };
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
    const pkt = new Uint8Array(1 + payload.length);
    pkt.set(header, 0);
    pkt.set(payload, 1);
    ws.send(pkt.buffer);
  }, [pttGranted]);

  useEffect(() => {
    return () => { wsRef.current?.close(); };
  }, []);

  return {
    status, error, rooms, currentRoom, currentName, members,
    activeSpeaker, pttGranted, channelBusy, selectedServer,
    connect, disconnect, join, pttStart, pttEnd, sendAudio,
  };
}
