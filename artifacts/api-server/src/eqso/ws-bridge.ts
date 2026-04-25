import { IncomingMessage, Server as HttpServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "crypto";
import { logger } from "../lib/logger";
import { roomManager, RemoteConnectionInfo } from "./room-manager";
import { inactivityManager } from "./inactivity-manager";
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
import { pcmToFloat32Normalized } from "./pcm-utils";
import { moderationManager } from "./moderation-manager";
import {
  FfmpegGsmEncoder,
  FfmpegGsmDecoder,
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
  // FFmpeg GSM decoder for this client — same reference impl as remote mode.
  // Pre-warmed here so the first audio packet doesn't incur a 500 ms delay.
  const localDecoder = new FfmpegGsmDecoder();
  localDecoder.start();

  // FFmpeg GSM encoder for TX: browser Uint8 PCM → GSM → TCP relay-daemon.
  // Replaces the pure-JS gsm610.ts encoder which had LTP (long-term prediction)
  // bugs that corrupted voice audio, causing the CB radio to receive only noise.
  const localEncoder = new FfmpegGsmEncoder();
  localEncoder.start();

  // GSM accumulator: collect 6×33=198 bytes before sending [0x01][198] to TCP clients.
  // eQSO protocol mandates AUDIO_PAYLOAD_SIZE (198) bytes per audio packet.
  // Without this, 0R-CB receives 34-byte packets which corrupt its stream parser.
  let localGsmAccum = Buffer.alloc(0);

  // When the encoder produces a GSM packet, accumulate until we have a full
  // 198-byte payload, then broadcast to TCP relay-daemon clients.
  localEncoder.on("gsm", (gsm: Buffer) => {
    const client = roomManager.getClient(id);
    if (!client?.room) return;
    localGsmAccum = Buffer.concat([localGsmAccum, gsm.slice(0, 33)]);
    if (localGsmAccum.length >= AUDIO_PAYLOAD_SIZE) {
      const pkt = Buffer.allocUnsafe(1 + AUDIO_PAYLOAD_SIZE);
      pkt[0] = 0x01;
      localGsmAccum.copy(pkt, 1, 0, AUDIO_PAYLOAD_SIZE);
      roomManager.broadcastToTcpAndRelays(client.room, pkt, id);
      localGsmAccum = localGsmAccum.slice(AUDIO_PAYLOAD_SIZE);
    }
  });

  localDecoder.on("pcm", (pcm: Int16Array) => {
    const float32 = pcmToFloat32Normalized(pcm);
    const payload = Buffer.from(float32.buffer);
    const out = Buffer.allocUnsafe(1 + payload.length);
    out[0] = WS_AUDIO_REMOTE;
    payload.copy(out, 1);
    sendBin(ws, out);
  });

  const clientInfo = {
    id,
    name: `_WS_${id.slice(0, 6)}`,
    room: "",
    message: "",
    protocol: "ws" as const,
    connectedAt: Date.now(),
    txBytes: 0,
    rxBytes: 0,
    pingMs: 0,
    send: (data: Buffer) => {
      clientInfo.txBytes += data.length;

      // GSM audio packet from inactivity manager or TCP relay: [0x01][198 bytes GSM]
      // Feed into the per-connection FFmpeg decoder (same reference impl as remote mode).
      // El payload de 198 bytes = 6 × 33-byte frames: el decoder procesa 1 frame por llamada.
      if (data[0] === 0x01 && data.length === 1 + AUDIO_PAYLOAD_SIZE) {
        for (let off = 1; off + 33 <= data.length; off += 33) {
          localDecoder.decode(Buffer.from(data.buffer, data.byteOffset + off, 33));
        }
        return;
      }

      // eQSO 0x16 single-event packet: PTT start (action=0x02) / PTT release (action=0x03)
      // The action byte lives at offset 5, not offset 4 (client binary parser would misread it).
      // Convert to JSON so handleTextMessage picks it up — same path as remote mode.
      if (data[0] === 0x16 && data.length > 1 && data[1] === 0x01 && data.length >= 10) {
        const action = data[5];
        if (action === 0x02 || action === 0x03) {
          const nameLen = data[9];
          const name = data.slice(10, 10 + nameLen).toString("ascii");
          if (action === 0x02) {
            sendJson(ws, { type: "ptt_started", name });
          } else {
            sendJson(ws, { type: "ptt_released_remote", name });
          }
          return;
        }
      }

      sendBin(ws, data);
    },
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

  // Accumulate raw Int16 bytes from browser (opcode 0x05) for GSM encoding.
  // Each PCM_CHUNK_SAMPLES × 2 bytes = one GSM frame.
  let localInt16Accum = new Uint8Array(0);

  return {
    onMessage: (msg, rawBin) => {
      // 0x01: Uint8 PCM from another local browser — relay as-is to other WS clients.
      // No GSM encoding; this path is for browser-to-browser local audio monitoring only.
      if (rawBin && rawBin.length > 0 && rawBin[0] === 0x01) {
        const client = roomManager.getClient(id);
        if (client?.room && !moderationManager.isMuted(client.name)) {
          roomManager.broadcastBinToLocalWsClients(client.room, rawBin, id);
        }
        return;
      }

      // 0x05: Int16 signed PCM from the browser TX microphone.
      // Accumulate 320-byte (160 × Int16) chunks → feed to FFmpeg GSM encoder.
      // Encoder emits 33-byte GSM frames; localEncoder "gsm" handler accumulates
      // 6 frames (198 bytes) and broadcasts [0x01][198] to TCP relay daemons.
      if (rawBin && rawBin.length > 0 && rawBin[0] === 0x05) {
        const client = roomManager.getClient(id);
        if (client?.room && !moderationManager.isMuted(client.name)) {
          const newBytes = rawBin.slice(1); // strip 0x05 opcode
          const merged = new Uint8Array(localInt16Accum.length + newBytes.length);
          merged.set(localInt16Accum);
          merged.set(newBytes, localInt16Accum.length);
          localInt16Accum = merged;

          // PCM_CHUNK_SAMPLES × 2 bytes = 160 Int16 samples = one GSM frame input
          const frameBytes = PCM_CHUNK_SAMPLES * 2;
          while (localInt16Accum.length >= frameBytes) {
            const chunk = localInt16Accum.slice(0, frameBytes);
            localInt16Accum = localInt16Accum.slice(frameBytes);
            const int16 = new Int16Array(
              chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + frameBytes)
            );
            localEncoder.encode(int16);
          }
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

          // Apply 0R- prefix for relay users, suffix up to 10 chars
          if (isRelay) {
            const prefix = "0R-";
            const withPrefix = name.startsWith(prefix) ? name : `${prefix}${name}`;
            name = withPrefix.slice(0, 13); // "0R-" (3) + 10 chars max
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
          // Ban check
          if (moderationManager.isBanned(name)) {
            sendJson(ws, { type: "error", message: "Acceso denegado: indicativo baneado del servidor" });
            logger.warn({ id, name }, "WS client rejected: banned");
            ws.close();
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
            if (moderationManager.isMuted(client.name)) {
              sendJson(ws, { type: "ptt_denied", reason: "Silenciado por el administrador" });
              break;
            }
            const locked = roomManager.tryLockRoom(client.room, id);
            if (locked) {
              roomManager.broadcastToRoom(client.room, buildPttStarted(client.name), id);
              inactivityManager.recordActivity(client.room);
              sendJson(ws, { type: "ptt_granted" });
            } else {
              sendJson(ws, { type: "ptt_denied", reason: "Canal ocupado" });
            }
          }
          break;
        }

        case "ptt_end": {
          localInt16Accum = new Uint8Array(0); // discard partial PCM frame on PTT release
          localGsmAccum = Buffer.alloc(0);     // discard partial GSM accumulation on PTT release
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
      localInt16Accum = new Uint8Array(0);
      localGsmAccum = Buffer.alloc(0);
      localDecoder.stop();
      localEncoder.stop();
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

  // Register this outgoing connection in the room manager for monitoring
  const remoteConnInfo: RemoteConnectionInfo = {
    id, host, port, name: "", room: "",
    status: "connecting", connectedAt: Date.now(),
    txBytes: 0, rxBytes: 0, remoteMembers: [],
    wsSend: (data: object) => { try { sendJson(ws, data); } catch { /* ignore */ } },
    wsSendBin: (data: Buffer) => { try { sendBin(ws, data); } catch { /* ignore */ } },
  };
  roomManager.addRemoteConn(remoteConnInfo);

  // Local helpers to mutate the member list in place (no Map copy overhead)
  function rmAddMember(name: string, message: string): void {
    if (!remoteConnInfo.remoteMembers.find(m => m.name === name)) {
      remoteConnInfo.remoteMembers.push({ name, message, isTx: false });
    }
  }
  function rmRemoveMember(name: string): void {
    const idx = remoteConnInfo.remoteMembers.findIndex(m => m.name === name);
    if (idx !== -1) remoteConnInfo.remoteMembers.splice(idx, 1);
  }
  function rmSetTx(name: string, isTx: boolean): void {
    const m = remoteConnInfo.remoteMembers.find(m => m.name === name);
    if (m) m.isTx = isTx;
  }

  // PCM accumulation buffer for TX: browser sends Int16 PCM chunks
  let pcmAccum = new Int16Array(0);

  // PTT tail: flush FFmpeg encoder buffer before sending [0x0d] to eQSO.
  // GSM 06.10 encoding has ~120 ms pipeline latency; 300 ms tail ensures
  // the last voice frames make it through before the channel closes.
  const PTT_TAIL_MS = 300;

  // GSM frame rate limiter: eQSO protocol expects 1 frame every 20ms (50 fps).
  // ffmpeg batches 960 PCM samples → 6 GSM frames all at once (one burst per
  // browser AudioWorklet chunk = 120ms). Sending 6×33 bytes in a burst causes
  // Windows eQSO relay clients (e.g. 0R-ASORAPA) to disconnect.
  // Fix: queue frames and drain via setInterval at 20ms so each frame is
  // delivered at the correct protocol rate.
  const GSM_FRAME_INTERVAL_MS = 20;
  const gsmFrameQueue: Buffer[] = [];
  let gsmFrameTimer: ReturnType<typeof setInterval> | null = null;

  function startGsmFrameTimer(): void {
    if (gsmFrameTimer) return;
    gsmFrameTimer = setInterval(() => {
      const frame = gsmFrameQueue.shift();
      if (frame) {
        proxy.sendAudio(frame);
        roomManager.updateRemoteConn(id, {
          txBytes: (roomManager.getRemoteConn(id)?.txBytes ?? 0) + frame.length,
        });
        logger.info({ bytes: frame.length }, "Remote TX: sent GSM packet");
      } else {
        clearInterval(gsmFrameTimer!);
        gsmFrameTimer = null;
      }
    }, GSM_FRAME_INTERVAL_MS);
  }

  function stopGsmFrameTimer(): void {
    if (gsmFrameTimer) { clearInterval(gsmFrameTimer); gsmFrameTimer = null; }
    gsmFrameQueue.length = 0;
  }

  function releasePtt(): void {
    stopGsmFrameTimer();
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
    const float32 = pcmToFloat32Normalized(pcm);
    const header = Buffer.alloc(1);
    header[0] = WS_AUDIO_REMOTE;
    const payload = Buffer.from(float32.buffer);
    sendBin(ws, Buffer.concat([header, payload]));
  });

  // When encoder produces a GSM packet, queue it for rate-limited delivery.
  // Do NOT call proxy.sendAudio() directly — that would burst 6 frames at once
  // and disconnect Windows eQSO relay clients (see rate limiter comment above).
  encoder.on("gsm", (gsm: Buffer) => {
    if (!pttGranted) return; // discard if PTT released mid-frame
    gsmFrameQueue.push(Buffer.from(gsm));
    startGsmFrameTimer();
  });

  proxy.on("event", (ev: ProxyEvent) => {
    switch (ev.type) {
      case "connected":
        roomManager.updateRemoteConn(id, { status: "connected", connectedAt: Date.now() });
        sendJson(ws, { type: "server_info", message: `Conectado a ${host}:${port}` });
        break;
      case "server_info":
        sendJson(ws, { type: "error", message: String(ev.data) });
        break;
      case "disconnected":
        roomManager.updateRemoteConn(id, { status: "disconnected" });
        remoteConnInfo.remoteMembers = [];
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
      case "user_joined": {
        const joined = ev.data as { name: string; message: string };
        rmAddMember(joined.name, joined.message ?? "");
        sendJson(ws, { type: "user_joined", ...(ev.data as object) });
        break;
      }
      case "user_left": {
        const left = ev.data as { name: string };
        rmRemoveMember(left.name);
        sendJson(ws, { type: "user_left", ...(ev.data as object) });
        break;
      }
      case "ptt_started": {
        const txer = ev.data as { name: string };
        rmSetTx(txer.name, true);
        sendJson(ws, { type: "ptt_started", ...(ev.data as object) });
        // Broadcast to all other proxy clients in the same room so they show the speaker animation
        if (currentRoom) {
          roomManager.broadcastJsonToRemoteRoom(currentRoom, { type: "ptt_started", name: txer.name }, id);
        }
        break;
      }
      case "ptt_released": {
        const txer = ev.data as { name: string };
        rmSetTx(txer.name, false);
        sendJson(ws, { type: "ptt_released_remote", ...(ev.data as object) });
        // Broadcast release to all other proxy clients in the same room
        if (currentRoom) {
          roomManager.broadcastJsonToRemoteRoom(currentRoom, { type: "ptt_released_remote", name: txer.name }, id);
        }
        break;
      }
      case "audio": {
        // Incoming GSM packet from remote eQSO server: [0x01][198 bytes GSM]
        const pkt = ev.data as Buffer;
        if (pkt.length < 1 + AUDIO_PAYLOAD_SIZE) break;
        roomManager.updateRemoteConn(id, {
          rxBytes: (roomManager.getRemoteConn(id)?.rxBytes ?? 0) + pkt.length,
        });
        // Decodificar 6 × 33-byte GSM frames del paquete de 198 bytes.
        // El decoder procesa 1 frame por llamada.
        for (let off = 1; off + 33 <= pkt.length; off += 33) {
          decoder.decode(Buffer.from(pkt.buffer, pkt.byteOffset + off, 33));
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

          // Apply 0R- prefix for relay users, suffix up to 10 chars
          if (isRelay) {
            const prefix = "0R-";
            const withPrefix = resolvedName.startsWith(prefix) ? resolvedName : `${prefix}${resolvedName}`;
            resolvedName = withPrefix.slice(0, 13); // "0R-" (3) + 10 chars max
          }

          currentName = resolvedName;
          currentRoom = room;
          remoteConnInfo.remoteMembers = []; // reset list when joining a new room
          rmAddMember(resolvedName, message);    // add self to member list
          roomManager.updateRemoteConn(id, { name: resolvedName, room });
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
          rmSetTx(currentName, true);
          // No separate PTT-announce packet in eQSO — the first [0x01][198 GSM] frame
          // announces PTT implicitly. Just stop the silence heartbeat.
          proxy.startTransmitting();
          sendJson(ws, { type: "ptt_granted" });
          logger.info({ name: currentName, room: currentRoom }, "Remote TX: PTT start (first voice frame will open channel)");
          break;
        case "ptt_end":
          rmSetTx(currentName, false);
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
      stopGsmFrameTimer();
      if (pttGranted) proxy.sendPttEnd(); // release channel before disconnecting
      pttGranted = false;
      pcmAccum = new Int16Array(0);
      decoder.stop();
      encoder.stop();
      proxy.disconnect();
      roomManager.removeRemoteConn(id);
    },
  };
}

export function startWsBridge(httpServer: HttpServer): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

  wss.on("connection", (ws: WebSocket, _req: IncomingMessage) => {
    if (!roomManager.isEnabled()) {
      sendJson(ws, { type: "error", message: "Servidor desactivado temporalmente" });
      ws.close();
      return;
    }
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
        if (raw instanceof Buffer) {
          const ci = roomManager.getClient(id);
          if (ci) ci.rxBytes += raw.length;
        }
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
