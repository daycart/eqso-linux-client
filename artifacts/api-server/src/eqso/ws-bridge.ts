import { IncomingMessage, Server as HttpServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "crypto";
import { logger } from "../lib/logger";
import { roomManager } from "./room-manager";
import {
  buildRoomList,
  buildUserList,
  buildUserJoined,
  buildUserLeft,
  buildPttStarted,
  buildPttReleased,
  buildErrorMessage,
  buildServerInfo,
  AUDIO_PAYLOAD_SIZE,
} from "./protocol";
import { EqsoProxy, ProxyEvent } from "./eqso-proxy";
import { gsmEncodePacket, gsmDecodePacket, GSM_FRAME_SAMPLES, FRAMES_PER_PACKET } from "./gsm610";

// Binary opcodes for browser ↔ server WebSocket protocol
const WS_AUDIO_LOCAL  = 0x01; // local relay: Uint8 unsigned PCM
const WS_AUDIO_REMOTE = 0x11; // remote RX:   Float32 PCM (decoded from GSM)
const WS_PCM_TX       = 0x05; // remote TX:   Int16 signed PCM (→ encode to GSM)

const PCM_CHUNK_SAMPLES = GSM_FRAME_SAMPLES * FRAMES_PER_PACKET; // 960 samples per GSM packet

const SERVER_VERSION = "eQSO Linux Server v1.0";
const KEEPALIVE_MS = 30_000;

interface WsMessage {
  type:
    | "select_server"
    | "join"
    | "ptt_start"
    | "ptt_end"
    | "ping";
  mode?: "local" | "remote";
  host?: string;
  port?: number;
  name?: string;
  room?: string;
  message?: string;
  password?: string;
}

function sendJson(ws: WebSocket, obj: object): void {
  if (ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(obj)); } catch { /* ignore */ }
  }
}

function sendBin(ws: WebSocket, data: Buffer): void {
  if (ws.readyState === WebSocket.OPEN) {
    try { ws.send(data); } catch { /* ignore */ }
  }
}

function handleLocalMode(
  ws: WebSocket,
  id: string,
  keepaliveTimer: ReturnType<typeof setInterval>
): {
  onMessage: (msg: WsMessage, raw: Buffer | null) => void;
  onClose: () => void;
} {
  const clientInfo = {
    id,
    name: `_WS_${id.slice(0, 6)}`,
    room: "",
    message: "",
    send: (data: Buffer) => sendBin(ws, data),
    close: () => ws.close(),
  };
  roomManager.addClient(clientInfo);

  sendJson(ws, {
    type: "room_list",
    rooms: roomManager.getRooms(),
  });
  sendJson(ws, { type: "server_info", message: SERVER_VERSION + " (Local)" });

  const pingTimer = setInterval(() => {
    sendJson(ws, { type: "keepalive" });
  }, KEEPALIVE_MS);

  return {
    onMessage: (msg, rawBin) => {
      if (rawBin && rawBin.length > 0 && rawBin[0] === 0x01) {
        const client = roomManager.getClient(id);
        if (client?.room) {
          roomManager.broadcastToRoom(client.room, rawBin, id);
        }
        return;
      }

      switch (msg.type) {
        case "join": {
          const name = (msg.name ?? "").trim().toUpperCase();
          const room = (msg.room ?? "GENERAL").trim().toUpperCase();
          const message = (msg.message ?? "").trim();
          const password = (msg.password ?? "").trim();

          const serverPassword = process.env.EQSO_PASSWORD ?? "";
          if (serverPassword && password !== serverPassword) {
            sendJson(ws, { type: "error", message: "Acceso denegado: contraseña incorrecta" });
            logger.warn({ id, name }, "WS client rejected: wrong password");
            ws.close();
            return;
          }

          if (!name || name.length > 20) {
            sendJson(ws, { type: "error", message: "Indicativo inválido (máx 20 chars)" });
            return;
          }
          if (!room || room.length > 20) {
            sendJson(ws, { type: "error", message: "Sala inválida (máx 20 chars)" });
            return;
          }
          if (roomManager.isNameTaken(name, id)) {
            sendJson(ws, { type: "error", message: `Indicativo "${name}" ya está en uso` });
            return;
          }

          const ci = roomManager.getClient(id);
          if (ci) { ci.name = name; ci.message = message; }

          const oldRoom = ci?.room ?? "";
          const oldMembers = oldRoom ? roomManager.getRoomMembers(oldRoom) : [];
          roomManager.joinRoom(id, room);

          if (oldRoom && oldRoom !== room) {
            const leftPkt = buildUserLeft(name);
            for (const m of oldMembers) { if (m.id !== id) m.send(leftPkt); }
          }

          const members = roomManager.getRoomMembers(room);
          const memberData = members.filter((m) => m.id !== id).map((m) => ({ name: m.name, message: m.message }));
          sendJson(ws, { type: "joined", room, name, members: memberData });

          const joinedPkt = buildUserJoined(name, message);
          for (const m of members) { if (m.id !== id) m.send(joinedPkt); }
          logger.info({ id, name, room }, "WS local client joined room");
          break;
        }

        case "ptt_start": {
          const client = roomManager.getClient(id);
          if (client?.room && client.name) {
            const locked = roomManager.tryLockRoom(client.room, id);
            if (locked) {
              roomManager.broadcastToRoom(client.room, buildPttStarted(client.name), id);
              sendJson(ws, { type: "ptt_granted" });
            } else {
              sendJson(ws, { type: "ptt_denied", reason: "Canal ocupado" });
            }
          }
          break;
        }

        case "ptt_end": {
          const client = roomManager.getClient(id);
          if (client?.room && client.name) {
            roomManager.broadcastToRoom(client.room, buildPttReleased(client.name), id);
            roomManager.unlockRoom(client.room, id);
            sendJson(ws, { type: "ptt_released" });
          }
          break;
        }

        case "ping":
          sendJson(ws, { type: "pong" });
          break;
      }
    },

    onClose: () => {
      clearInterval(pingTimer);
      const client = roomManager.getClient(id);
      if (client?.room && client.name) {
        roomManager.broadcastToRoom(client.room, buildUserLeft(client.name), id);
      }
      roomManager.removeClient(id);
    },
  };
}

function handleRemoteMode(
  ws: WebSocket,
  id: string,
  host: string,
  port: number
): {
  onMessage: (msg: WsMessage, raw: Buffer | null) => void;
  onClose: () => void;
} {
  const proxy = new EqsoProxy(host, port);
  let pttGranted = false;
  let currentName = "";
  let currentRoom = "";

  // PCM accumulation buffer for TX: browser sends Int16 PCM chunks
  let pcmAccum = new Int16Array(0);

  proxy.on("event", (ev: ProxyEvent) => {
    switch (ev.type) {
      case "connected":
        sendJson(ws, { type: "server_info", message: `Conectado a ${host}:${port}` });
        break;
      case "server_info":
        sendJson(ws, { type: "error", message: String(ev.data) });
        break;
      case "disconnected":
        sendJson(ws, { type: "disconnected", message: "Servidor desconectado" });
        break;
      case "error":
        sendJson(ws, { type: "error", message: `Error de conexión: ${ev.data}` });
        break;
      case "room_list":
        sendJson(ws, { type: "room_list", rooms: ev.data as string[] });
        break;
      case "members":
        sendJson(ws, {
          type: "joined",
          room: currentRoom,
          name: currentName,
          members: ev.data,
        });
        break;
      case "user_joined":
        sendJson(ws, { type: "user_joined", ...(ev.data as object) });
        break;
      case "user_left":
        sendJson(ws, { type: "user_left", ...(ev.data as object) });
        break;
      case "ptt_started":
        sendJson(ws, { type: "ptt_started", ...(ev.data as object) });
        break;
      case "ptt_released":
        sendJson(ws, { type: "ptt_released_remote", ...(ev.data as object) });
        break;
      case "audio": {
        // Incoming GSM packet from remote eQSO server: [0x01][198 bytes GSM]
        const pkt = ev.data as Buffer;
        if (pkt.length < 1 + AUDIO_PAYLOAD_SIZE) break;
        try {
          const gsmBytes = new Uint8Array(pkt.buffer, pkt.byteOffset + 1, AUDIO_PAYLOAD_SIZE);
          const pcm = gsmDecodePacket(gsmBytes); // Int16Array, 960 samples
          // Convert Int16 → Float32 for browser playback
          const float32 = new Float32Array(pcm.length);
          for (let i = 0; i < pcm.length; i++) {
            float32[i] = pcm[i] / 32768;
          }
          // Send [0x11][Float32 bytes] to browser
          const header = Buffer.alloc(1);
          header[0] = WS_AUDIO_REMOTE;
          const payload = Buffer.from(float32.buffer);
          sendBin(ws, Buffer.concat([header, payload]));
        } catch (err) {
          logger.warn({ err }, "GSM decode error");
        }
        break;
      }
      case "keepalive":
        sendJson(ws, { type: "keepalive" });
        break;
    }
  });

  proxy.connect();

  return {
    onMessage: (msg, rawBin) => {
      // Handle TX audio: browser sends [0x05][Int16 PCM bytes]
      if (rawBin && rawBin.length > 1 && rawBin[0] === WS_PCM_TX && pttGranted) {
        // Copy payload into a fresh ArrayBuffer (rawBin.slice has unaligned byteOffset)
        const payloadLen = rawBin.length - 1;
        const sampleCount = Math.floor(payloadLen / 2);
        const newSamples = new Int16Array(sampleCount);
        const view = new DataView(rawBin.buffer, rawBin.byteOffset + 1, payloadLen);
        for (let i = 0; i < sampleCount; i++) {
          newSamples[i] = view.getInt16(i * 2, true); // little-endian
        }
        // Merge into accumulation buffer
        const merged = new Int16Array(pcmAccum.length + newSamples.length);
        merged.set(pcmAccum);
        merged.set(newSamples, pcmAccum.length);
        pcmAccum = merged;

        // Emit complete GSM packets (960 samples each)
        while (pcmAccum.length >= PCM_CHUNK_SAMPLES) {
          const chunk = pcmAccum.slice(0, PCM_CHUNK_SAMPLES);
          pcmAccum = pcmAccum.slice(PCM_CHUNK_SAMPLES);
          try {
            const gsm = gsmEncodePacket(chunk);
            proxy.sendAudio(Buffer.from(gsm));
            logger.debug({ bytes: gsm.length }, "Remote TX: sent GSM packet");
          } catch (err) {
            logger.warn({ err }, "GSM encode error");
          }
        }
        return;
      }

      // Ignore old-style [0x01] binary from browser (local PCM, not used in remote mode)
      if (rawBin && rawBin.length > 0 && rawBin[0] === WS_AUDIO_LOCAL) {
        return;
      }

      switch (msg.type) {
        case "join": {
          const name = (msg.name ?? "").trim().toUpperCase();
          const room = (msg.room ?? "GENERAL").trim().toUpperCase();
          const message = (msg.message ?? "").trim();
          const password = (msg.password ?? "").trim();
          currentName = name;
          currentRoom = room;
          logger.info({ id, name, room, host, port }, "Remote proxy: join requested");
          proxy.sendJoin(name, room, message, password);
          sendJson(ws, { type: "joined", room, name, members: [] });
          logger.info({ id, name, room }, "Remote proxy: sent joined to browser");
          break;
        }
        case "ptt_start":
          pttGranted = true;
          pcmAccum = new Int16Array(0); // reset accumulator
          sendJson(ws, { type: "ptt_granted" });
          break;
        case "ptt_end":
          pttGranted = false;
          pcmAccum = new Int16Array(0); // discard leftover
          sendJson(ws, { type: "ptt_released" });
          break;
        case "ping":
          sendJson(ws, { type: "pong" });
          break;
      }
    },

    onClose: () => {
      pttGranted = false;
      pcmAccum = new Int16Array(0);
      proxy.disconnect();
    },
  };
}

export function startWsBridge(httpServer: HttpServer): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

  wss.on("connection", (ws: WebSocket, _req: IncomingMessage) => {
    const id = randomUUID();
    logger.info({ id }, "New WS eQSO client");

    let handler: {
      onMessage: (msg: WsMessage, raw: Buffer | null) => void;
      onClose: () => void;
    } | null = null;

    const keepaliveTimer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        clearInterval(keepaliveTimer);
        return;
      }
    }, KEEPALIVE_MS);

    sendJson(ws, {
      type: "room_list",
      rooms: roomManager.getRooms(),
    });
    sendJson(ws, { type: "server_info", message: SERVER_VERSION });

    ws.on("message", (raw) => {
      try {
        // Binary frames: local audio (0x01) or remote PCM TX (0x05)
        const isBin = raw instanceof Buffer && raw.length > 0 &&
          (raw[0] === WS_AUDIO_LOCAL || raw[0] === WS_PCM_TX);

        if (isBin) {
          handler?.onMessage({} as WsMessage, raw as Buffer);
          return;
        }

        const msg: WsMessage = JSON.parse(raw.toString());

        if (msg.type === "select_server") {
          handler?.onClose();
          handler = null;

          if (msg.mode === "remote" && msg.host) {
            const port = msg.port ?? 2171;
            logger.info({ id, host: msg.host, port }, "WS client selecting remote server");
            handler = handleRemoteMode(ws, id, msg.host, port);
          } else {
            logger.info({ id }, "WS client selecting local server");
            handler = handleLocalMode(ws, id, keepaliveTimer);
          }
          return;
        }

        if (!handler) {
          handler = handleLocalMode(ws, id, keepaliveTimer);
        }

        handler.onMessage(msg, null);
      } catch (err) {
        logger.warn({ err, id }, "WS message error");
      }
    });

    ws.on("close", () => {
      clearInterval(keepaliveTimer);
      handler?.onClose();
      handler = null;
      logger.info({ id }, "WS client disconnected");
    });

    ws.on("error", (err) => {
      logger.warn({ err, id }, "WS error");
    });
  });

  logger.info("eQSO WebSocket bridge ready on /ws");
  return wss;
}
