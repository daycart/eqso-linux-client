import { useCallback, useEffect, useRef, useState } from "react";
import { getWsUrl } from "../lib/homeServer";

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
    defaultRooms: ["GENERAL", "CB", "ASORAPA", "PRUEBAS"],
  },
  {
    id: "asorapa",
    label: "ASORAPA — Radio Club Iria Flavia",
    description: "Enlace CB27 ASORAPA · Galicia",
    mode: "remote",
    host: "193.152.83.229",
    port: 8008,
    defaultRooms: ["CB", "ASORAPA", "PRUEBAS"],
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
  join: (name: string, room: string, message?: string, password?: string, token?: string) => void;
  pttStart: () => void;
  pttEnd: () => void;
  sendAudio: (data: ArrayBuffer) => void;
}

// Binary opcodes (must match ws-bridge.ts)
const WS_AUDIO_LOCAL  = 0x01; // local relay: Uint8 unsigned PCM
const WS_AUDIO_REMOTE = 0x11; // remote RX:   Float32 PCM decoded from GSM
const WS_PCM_TX       = 0x05; // remote TX:   Int16 signed PCM → GSM encode on server

export function useEqsoClient(
  onAudio?: (data: ArrayBuffer, isFloat32: boolean) => void
): EqsoState & EqsoActions {
  const onAudioRef = useRef(onAudio);
  useEffect(() => { onAudioRef.current = onAudio; }, [onAudio]);
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
  const pttGrantedRef = useRef(false);
  const [channelBusy, setChannelBusy] = useState(false);
  const [selectedServer, setSelectedServer] = useState<EqsoServer>(KNOWN_SERVERS[0]);
  const selectedServerRef = useRef<EqsoServer>(KNOWN_SERVERS[0]);

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
        const rawMembers = (msg.members as RoomMember[]) ?? [];
        const dedupedMembers = rawMembers.reduce<RoomMember[]>((acc, m) => {
          const n = (m.name ?? "").trim();
          if (n && !acc.some((x) => x.name === n)) acc.push({ name: n, message: m.message ?? "" });
          return acc;
        }, []);
        setMembers(dedupedMembers);
        pendingJoinRef.current = null;
        break;
      }

      case "user_joined": {
        const joinName = (msg.name as string ?? "").trim();
        const joinMsg  = (msg.message as string ?? "").trim();
        if (!joinName) break;
        setMembers((prev) => {
          if (prev.some((x) => x.name === joinName)) return prev;
          return [...prev, { name: joinName, message: joinMsg }];
        });
        break;
      }

      case "user_left": {
        const leftName = (msg.name as string ?? "").trim();
        setMembers((prev) => prev.filter((m) => m.name !== leftName));
        break;
      }

      case "ptt_started":
        setActiveSpeaker(msg.name as string);
        setChannelBusy(true);
        break;

      case "ptt_released":
        pttGrantedRef.current = false;
        setPttGranted(false);
        break;

      case "ptt_released_remote":
        setActiveSpeaker(null);
        setChannelBusy(false);
        break;

      case "ptt_granted":
        pttGrantedRef.current = true;
        setPttGranted(true);
        setChannelBusy(false);
        break;

      case "ptt_denied":
        pttGrantedRef.current = false;
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

    // Remote audio: Float32 PCM decoded server-side from GSM
    if (cmd === WS_AUDIO_REMOTE) {
      if (view.length > 1) {
        onAudioRef.current?.(data.slice(1), true);
      }
      return;
    }

    // Local audio: Uint8 unsigned PCM relay
    if (cmd === WS_AUDIO_LOCAL) {
      if (view.length > 1) {
        onAudioRef.current?.(data.slice(1), false);
      }
      return;
    }

    if (cmd === 0x16 && view.length >= 2) {
      const count = view[1];
      if (count === 1 && view.length >= 10) {
        // eQSO single-event format:
        //   [0x16][0x01][0x00][0x00][0x00][action][0x00][0x00][0x00][nameLen][name...]
        // action is at index 5, nameLen is at index 9 (not 4 and 8).
        const action = view[5];
        let off = 9;
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
        const nameSeen = new Set<string>();
        let off = 4;
        for (let i = 0; i < count; i++) {
          if (off + 5 >= view.length) break;
          off += 5;
          if (off >= view.length) break;
          const nameLen = view[off++];
          if (off + nameLen > view.length) break;
          const name = new TextDecoder().decode(view.slice(off, off + nameLen)).trim();
          off += nameLen;
          const msgLen = view[off++];
          const msg = msgLen > 0 ? new TextDecoder().decode(view.slice(off, off + msgLen)) : "";
          off += msgLen;
          if (name && !nameSeen.has(name)) {
            nameSeen.add(name);
            newMembers.push({ name, message: msg });
          }
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
    selectedServerRef.current = server;
    setStatus("connecting");
    setError(null);
    setCurrentRoom(null);
    setCurrentName(null);
    setMembers([]);
    setActiveSpeaker(null);
    pttGrantedRef.current = false;
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
      pttGrantedRef.current = false;
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
    pttGrantedRef.current = false;
    setPttGranted(false);
    pendingJoinRef.current = null;
  }, []);

  const join = useCallback((name: string, room: string, message = "", password = "", token?: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    let nodeName: string;
    if (token) {
      // Authenticated: callsign comes from session, server handles prefix/padding
      nodeName = name.toUpperCase().trim();
    } else {
      // Legacy / unauthenticated: apply 0R- prefix, suffix up to 10 chars
      const upper = name.toUpperCase().trim();
      const withPrefix = upper.startsWith("0R-") ? upper : `0R-${upper}`;
      nodeName = withPrefix.slice(0, 13); // "0R-" (3) + 10 chars max
    }

    pendingJoinRef.current = { name: nodeName, room };
    const msg: Record<string, unknown> = {
      type: "join",
      name: nodeName,
      room: room.toUpperCase(),
      message,
      password,
    };
    if (token) msg.token = token;
    ws.send(JSON.stringify(msg));
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
    if (!ws || ws.readyState !== WebSocket.OPEN || !pttGrantedRef.current) {
      console.debug("[eqso] sendAudio dropped — ws:", ws?.readyState, "pttGranted:", pttGrantedRef.current);
      return;
    }

    // Always send Int16 PCM with opcode 0x05 regardless of local/remote mode.
    // Server GSM-encodes it and relays to TCP relay daemons (0R-CB, etc.).
    // Using WS_AUDIO_LOCAL (0x01) with Uint8 PCM was causing poor 8-bit quality
    // and audio levels outside RC IRIA's activation window (5-15 % FS peak).
    const opcode = WS_PCM_TX;
    const payload = new Uint8Array(data);
    const pkt = new Uint8Array(1 + payload.length);
    pkt[0] = opcode;
    pkt.set(payload, 1);
    ws.send(pkt.buffer);
  }, []);

  useEffect(() => {
    return () => { wsRef.current?.close(); };
  }, []);

  return {
    status, error, rooms, currentRoom, currentName, members,
    activeSpeaker, pttGranted, channelBusy, selectedServer,
    connect, disconnect, join, pttStart, pttEnd, sendAudio,
  };
}
