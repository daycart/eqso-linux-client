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
import { validateSession } from "../lib/auth";
import {
  FfmpegGsmDecoder,
  FfmpegGsmEncoder,
  GSM_FRAME_SAMPLES,
  FRAMES_PER_PACKET,
  GSM_PACKET_BYTES,
} from "./ffmpeg-gsm";

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
  token?: string;
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
          const room = (msg.room ?? "GENERAL").trim().toUpperCase();
          const message = (msg.message ?? "").trim();
          const password = (msg.password ?? "").trim();

          // Resolve callsign from session token or raw name
          let name = (msg.name ?? "").trim().toUpperCase();
          let isRelay = false;
          if (msg.token) {
            const session = validateSession(msg.token);
            if (!session) {
              sendJson(ws, { type: "error", message: "Sesión expirada. Vuelve a iniciar sesión." });
              ws.close();
              return;
            }
            name = session.callsign;
            isRelay = session.isRelay;
          }

          // Apply 0R- prefix + Maidenhead padding for relay users
          if (isRelay) {
            const prefix = "0R-";
            const suffix = name.startsWith(prefix) ? name.slice(prefix.length) : name;
            const TEMPLATE = "AA00AA";
            let padded = "";
            for (let i = 0; i < 6; i++) padded += i < suffix.length ? suffix[i] : TEMPLATE[i];
            name = prefix + padded;
          }

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
  let pttTailTimer: ReturnType<typeof setTimeout> | null = null;
  let currentName = "";
  let currentRoom = "";

  // PCM accumulation buffer for TX: browser sends Int16 PCM chunks
  let pcmAccum = new Int16Array(0);

  // PTT tail: flush FFmpeg encoder buffer before sending [0x0d] to eQSO.
  // GSM 06.10 encoding has ~120 ms pipeline latency; 300 ms tail ensures
  // the last voice frames make it through before the channel closes.
  const PTT_TAIL_MS = 300;

  function releasePtt(): void {
    pttGranted = false;
    pcmAccum = new Int16Array(0);
    proxy.sendPttEnd();
    logger.info({ name: currentName }, "Remote TX: PTT end sent to eQSO server");
  }

  // ── FFmpeg codec instances (pre-warmed at connection time) ──────────────────
  const decoder = new FfmpegGsmDecoder();
  const encoder = new FfmpegGsmEncoder();
  decoder.start();
  encoder.start();

  // When decoder produces a decoded PCM packet, send it to browser
  decoder.on("pcm", (pcm: Int16Array) => {
    let peak = 0;
    const float32 = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) {
      const a = Math.abs(pcm[i]);
      if (a > peak) peak = a;
      // Soft-limit to ±0.85 FS before sending to browser:
      // prevents clipping on the browser's 2× playback gain node for loud
      // stations while keeping the dynamic range of normal speech intact.
      float32[i] = Math.max(-0.85, Math.min(0.85, pcm[i] / 32768));
    }
    const header = Buffer.alloc(1);
    header[0] = WS_AUDIO_REMOTE;
    const payload = Buffer.from(float32.buffer);
    sendBin(ws, Buffer.concat([header, payload]));
    logger.info({ samples: pcm.length, peak }, "Remote RX: sent Float32 to browser");
  });

  // When encoder produces a GSM packet, forward it to the eQSO server
  encoder.on("gsm", (gsm: Buffer) => {
    if (!pttGranted) return; // discard if PTT released mid-frame
    proxy.sendAudio(gsm);
    logger.info({ bytes: gsm.length }, "Remote TX: sent GSM packet");
  });

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
        // Feed 198-byte GSM payload into the streaming decoder
        const gsmBuf = Buffer.from(
          pkt.buffer,
          pkt.byteOffset + 1,
          Math.min(AUDIO_PAYLOAD_SIZE, GSM_PACKET_BYTES)
        );
        decoder.decode(gsmBuf);
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
      if (rawBin && rawBin.length > 1 && rawBin[0] === WS_PCM_TX) {
        if (!pttGranted) {
          logger.debug({ bytes: rawBin.length }, "Remote TX: dropped audio — pttGranted=false");
          return;
        }
        // Copy payload into a fresh ArrayBuffer (rawBin.slice has unaligned byteOffset)
        const payloadLen = rawBin.length - 1;
        const sampleCount = Math.floor(payloadLen / 2);
        const newSamples = new Int16Array(sampleCount);
        const view = new DataView(rawBin.buffer, rawBin.byteOffset + 1, payloadLen);
        for (let i = 0; i < sampleCount; i++) {
          newSamples[i] = view.getInt16(i * 2, true); // little-endian
        }

        // Log PCM peak to detect silence vs speech (once every ~10 packets)
        if (Math.random() < 0.1) {
          let peak = 0;
          for (let i = 0; i < newSamples.length; i++) {
            const a = Math.abs(newSamples[i]);
            if (a > peak) peak = a;
          }
          logger.info({ samples: newSamples.length, peak }, "Remote TX: PCM from browser");
        }

        // Merge into accumulation buffer
        const merged = new Int16Array(pcmAccum.length + newSamples.length);
        merged.set(pcmAccum);
        merged.set(newSamples, pcmAccum.length);
        pcmAccum = merged;

        // Feed complete 960-sample chunks to the encoder
        while (pcmAccum.length >= PCM_CHUNK_SAMPLES) {
          const chunk = pcmAccum.slice(0, PCM_CHUNK_SAMPLES);
          pcmAccum = pcmAccum.slice(PCM_CHUNK_SAMPLES);
          encoder.encode(chunk);
        }
        return;
      }

      // Ignore old-style [0x01] binary from browser (local PCM, not used in remote mode)
      if (rawBin && rawBin.length > 0 && rawBin[0] === WS_AUDIO_LOCAL) {
        return;
      }

      switch (msg.type) {
        case "join": {
          const room = (msg.room ?? "GENERAL").trim().toUpperCase();
          const message = (msg.message ?? "").trim();
          const password = (msg.password ?? "").trim();

          // Resolve callsign: prefer authenticated session over raw name
          let resolvedName = (msg.name ?? "").trim().toUpperCase();
          let isRelay = false;
          if (msg.token) {
            const session = validateSession(msg.token);
            if (!session) {
              sendJson(ws, { type: "error", message: "Sesión expirada. Vuelve a iniciar sesión." });
              return;
            }
            resolvedName = session.callsign;
            isRelay = session.isRelay;
          }

          // Apply 0R- prefix + Maidenhead padding for relay users
          if (isRelay) {
            const prefix = "0R-";
            const suffix = resolvedName.startsWith(prefix)
              ? resolvedName.slice(prefix.length)
              : resolvedName;
            const TEMPLATE = "AA00AA";
            let padded = "";
            for (let i = 0; i < 6; i++) padded += i < suffix.length ? suffix[i] : TEMPLATE[i];
            resolvedName = prefix + padded;
          }

          currentName = resolvedName;
          currentRoom = room;
          logger.info({ id, name: resolvedName, room, host, port, isRelay }, "Remote proxy: join requested");
          proxy.sendJoin(resolvedName, room, message, password);
          sendJson(ws, { type: "joined", room, name: resolvedName, members: [] });
          logger.info({ id, name: resolvedName, room }, "Remote proxy: sent joined to browser");
          break;
        }
        case "ptt_start":
          // Cancel any pending tail timer from a previous PTT release
          if (pttTailTimer) { clearTimeout(pttTailTimer); pttTailTimer = null; }
          pttGranted = true;
          pcmAccum = new Int16Array(0); // reset accumulator
          // No separate PTT-announce packet in eQSO — the first [0x01][198 GSM] frame
          // announces PTT implicitly. Just stop the silence heartbeat.
          proxy.startTransmitting();
          sendJson(ws, { type: "ptt_granted" });
          logger.info({ name: currentName, room: currentRoom }, "Remote TX: PTT start (first voice frame will open channel)");
          break;
        case "ptt_end":
          // Notify browser immediately so UI updates, then wait for the FFmpeg
          // encoder to flush its remaining frames before releasing the eQSO channel.
          sendJson(ws, { type: "ptt_released" });
          pttTailTimer = setTimeout(() => {
            pttTailTimer = null;
            releasePtt();
          }, PTT_TAIL_MS);
          break;
        case "ping":
          sendJson(ws, { type: "pong" });
          break;
      }
    },

    onClose: () => {
      if (pttTailTimer) { clearTimeout(pttTailTimer); pttTailTimer = null; }
      if (pttGranted) proxy.sendPttEnd(); // release channel before disconnecting
      pttGranted = false;
      pcmAccum = new Int16Array(0);
      decoder.stop();
      encoder.stop();
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
