import net from "net";
import { randomUUID } from "crypto";
import { logger } from "../lib/logger";
import { roomManager, ClientInfo } from "./room-manager";
import { FfmpegGsmDecoder } from "./ffmpeg-gsm";
import { inactivityManager } from "./inactivity-manager";
import { moderationManager } from "./moderation-manager";
import {
  EQSO_COMMANDS,
  AUDIO_PAYLOAD_SIZE,
  HANDSHAKE_CLIENT,
  HANDSHAKE_SERVER,
  buildServerInfo,
  buildRoomList,
  buildUserList,
  buildUserJoined,
  buildUserLeft,
  buildPttStarted,
  buildPttReleased,
  buildErrorMessage,
  tryParseJoin,
  KEEPALIVE_PACKET,
} from "./protocol";

const SERVER_VERSION = "eQSO Linux Server v1.0";
const KEEPALIVE_INTERVAL_MS = 30_000;

// One FFmpeg GSM decoder per TCP client (keyed by client UUID)
const tcpDecoders = new Map<string, FfmpegGsmDecoder>();

interface TcpClientState {
  id: string;
  socket: net.Socket;
  buf: Buffer;
  readMultiByte: boolean;
  multiByteCmd: number;
  handshakeDone: boolean;
  disconnected: boolean; // guard against double-disconnect (error + close both fire)
  /** Drena inmediatamente los paquetes GSM pendientes en el pace queue.
   *  Llamado desde processSingleByte cuando el cliente envía RELEASE_PTT (0x0d),
   *  así los últimos frames llegan al navegador sin el retardo de 120ms/paquete. */
  flushPaceQueue?: () => void;
}

function sendRoomList(state: TcpClientState): void {
  const rooms = roomManager.getRooms();
  const pkt = buildRoomList(rooms);
  safeWrite(state, pkt);
}

function sendServerInfo(state: TcpClientState): void {
  const pkt = buildServerInfo(SERVER_VERSION);
  safeWrite(state, pkt);
}

function sendRoomMembers(state: TcpClientState): void {
  const client = roomManager.getClient(state.id);
  if (!client || !client.room) return;

  const members = roomManager.getRoomMembers(client.room);
  const pkt = buildUserList(members.map((m) => ({ name: m.name, message: m.message })));
  safeWrite(state, pkt);
}

function safeWrite(state: TcpClientState, data: Buffer): void {
  try {
    if (!state.socket.destroyed) {
      state.socket.write(data);
    }
  } catch (err) {
    logger.warn({ err, id: state.id }, "TCP write error");
  }
}

function handleHandshake(state: TcpClientState, chunk: Buffer): void {
  if (
    chunk.length >= 5 &&
    chunk.slice(0, 5).equals(HANDSHAKE_CLIENT)
  ) {
    safeWrite(state, HANDSHAKE_SERVER);
    state.handshakeDone = true;
    sendServerInfo(state);
    logger.info({ id: state.id }, "eQSO TCP client handshake complete");
  }
}

function processSingleByte(state: TcpClientState, byte: number): void {
  const client = roomManager.getClient(state.id);

  switch (byte) {
    case EQSO_COMMANDS.VOICE:
      if (client?.room && !moderationManager.isMuted(client.name)) {
        const ptt = buildPttStarted(client.name);
        roomManager.tryLockRoom(client.room, state.id);
        roomManager.broadcastToRoom(client.room, ptt, state.id);
        inactivityManager.recordActivity(client.room);
      }
      state.readMultiByte = true;
      state.multiByteCmd = EQSO_COMMANDS.VOICE;
      state.buf = Buffer.alloc(0);
      break;

    case EQSO_COMMANDS.IGNORE:
      break;

    case EQSO_COMMANDS.RELEASE_PTT:
      if (client?.room) {
        const rel = buildPttReleased(client.name);
        roomManager.broadcastToRoom(client.room, rel, state.id);
        safeWrite(state, Buffer.from([0x08]));
        safeWrite(state, Buffer.from([0x06, 0x00]));
        roomManager.unlockRoom(client.room, state.id);
        // Drena inmediatamente los paquetes GSM que quedaron en el pace queue.
        // Sin esto, los últimos 3-5 paquetes GSM del relay CB se entregan al
        // navegador 360-600ms tarde → suena como eco/cola de la voz.
        // Con flush: los paquetes llegan juntos (<1 tick de Node.js) y el
        // Web Audio del navegador los encola en nextPlayTimeRef sin solapamiento.
        state.flushPaceQueue?.();
      }
      break;

    case EQSO_COMMANDS.HANDSHAKE:
      state.readMultiByte = true;
      state.multiByteCmd = EQSO_COMMANDS.HANDSHAKE;
      state.buf = Buffer.from([byte]);
      break;

    case EQSO_COMMANDS.JOIN:
      state.readMultiByte = true;
      state.multiByteCmd = EQSO_COMMANDS.JOIN;
      state.buf = Buffer.alloc(0);
      break;

    case EQSO_COMMANDS.CLIENT_INFO:
      state.readMultiByte = true;
      state.multiByteCmd = EQSO_COMMANDS.CLIENT_INFO;
      state.buf = Buffer.from([byte]);
      break;

    default:
      break;
  }
}

function processMultiByte(state: TcpClientState, byte: number): void {
  state.buf = Buffer.concat([state.buf, Buffer.from([byte])]);

  switch (state.multiByteCmd) {
    case EQSO_COMMANDS.HANDSHAKE: {
      if (state.buf.length === 5) {
        // Accept any 5-byte handshake starting with 0x0a — different eQSO client
        // versions use different second bytes (0x82 for proxy, 0x78 for Windows client v1.13)
        if (state.buf[0] === EQSO_COMMANDS.HANDSHAKE) {
          safeWrite(state, HANDSHAKE_SERVER);
          state.handshakeDone = true;
          logger.info({ id: state.id, hex: state.buf.toString("hex") }, "eQSO TCP handshake complete — sending room list");
          sendRoomList(state);
        } else {
          logger.warn({ id: state.id, hex: state.buf.toString("hex") }, "eQSO TCP bad handshake bytes");
        }
        state.readMultiByte = false;
        state.multiByteCmd = 0;
        state.buf = Buffer.alloc(0);
      }
      break;
    }

    case EQSO_COMMANDS.CLIENT_INFO: {
      if (state.buf.length === 9) {
        state.readMultiByte = false;
        state.multiByteCmd = 0;
        state.buf = Buffer.alloc(0);
      }
      break;
    }

    case EQSO_COMMANDS.JOIN: {
      const parsed = tryParseJoin(state.buf);
      if (parsed) {
        logger.info(
          { id: state.id, name: parsed.name, room: parsed.room, bufLen: state.buf.length },
          "eQSO TCP JOIN parsed"
        );
        handleJoin(state, parsed.name, parsed.room, parsed.message, parsed.password);
        state.readMultiByte = false;
        state.multiByteCmd = 0;
        state.buf = Buffer.alloc(0);
      }
      break;
    }

    case EQSO_COMMANDS.VOICE: {
      if (state.buf.length >= AUDIO_PAYLOAD_SIZE) {
        const client = roomManager.getClient(state.id);
        if (client?.room && !moderationManager.isMuted(client.name)) {
          const gsmPayload = state.buf.slice(0, AUDIO_PAYLOAD_SIZE);

          // Send [0x01][GSM 198 bytes] to TCP clients and relay listeners
          const gsmPkt = Buffer.concat([Buffer.from([0x01]), gsmPayload]);
          roomManager.broadcastToTcpAndRelays(client.room, gsmPkt, state.id);

          // Feed to per-client FFmpeg decoder; WS broadcast happens in "pcm" event
          tcpDecoders.get(state.id)?.decode(Buffer.from(gsmPayload));
        }
        state.buf = state.buf.slice(AUDIO_PAYLOAD_SIZE);
        if (state.buf.length === 0) {
          state.readMultiByte = false;
          state.multiByteCmd = 0;
        }
      }
      break;
    }

    default:
      break;
  }
}

function handleJoin(
  state: TcpClientState,
  name: string,
  room: string,
  message: string,
  password: string
): void {
  const existing = roomManager.getClient(state.id);
  const oldRoom = existing?.room ?? "";

  // Ban check
  if (moderationManager.isBanned(name)) {
    safeWrite(state, buildErrorMessage("Acceso denegado: indicativo baneado del servidor"));
    logger.warn({ id: state.id, name }, "TCP client rejected: banned");
    state.socket.destroy();
    return;
  }

  const serverPassword = process.env.EQSO_PASSWORD ?? "";
  if (serverPassword && password !== serverPassword) {
    safeWrite(state, buildErrorMessage("Acceso denegado: contrasena incorrecta"));
    logger.warn({ id: state.id, name }, "TCP client rejected: wrong password");
    state.socket.destroy();
    return;
  }

  if (!name || name.length > 30) {
    safeWrite(state, buildErrorMessage("Indicativo invalido (max 30 chars)"));
    logger.warn({ id: state.id, name, len: name?.length }, "TCP client rejected: invalid callsign");
    state.socket.destroy();
    return;
  }
  if (!room || room.length > 30) {
    safeWrite(state, buildErrorMessage("Nombre de sala invalido (max 30 chars)"));
    logger.warn({ id: state.id, room }, "TCP client rejected: invalid room");
    state.socket.destroy();
    return;
  }
  if (roomManager.isNameTaken(name, state.id)) {
    safeWrite(state, buildErrorMessage(`Indicativo "${name}" ya en uso`));
    logger.warn({ id: state.id, name }, "TCP client rejected: callsign already in use — destroying socket");
    state.socket.destroy(); // destroy so the anonymous connection does not linger for 2 minutes
    return;
  }

  const client = roomManager.getClient(state.id);
  if (client) {
    client.name = name;
    client.message = message;
  }

  const oldMembers = oldRoom ? roomManager.getRoomMembers(oldRoom) : [];
  roomManager.joinRoom(state.id, room);

  if (oldRoom && oldRoom !== room) {
    const leftPkt = buildUserLeft(name);
    for (const m of oldMembers) {
      if (m.id !== state.id) m.send(leftPkt);
    }
  }

  const members = roomManager.getRoomMembers(room);
  const memberList = buildUserList(
    members.map((m) => ({ name: m.name, message: m.message }))
  );
  logger.info(
    { id: state.id, name, room, memberCount: members.length, members: members.map(m => m.name), hex: memberList.toString("hex") },
    "eQSO TCP sending user list to joining client"
  );
  safeWrite(state, memberList);

  const joinedPkt = buildUserJoined(name, message);
  for (const m of members) {
    if (m.id !== state.id) {
      logger.info({ to: m.name, joining: name }, "eQSO TCP notifying existing member of new join");
      m.send(joinedPkt);
    }
  }

  logger.info({ id: state.id, name, room, memberCount: members.length }, "TCP client joined room");
}

function handleData(state: TcpClientState, data: Buffer): void {
  for (let i = 0; i < data.length; i++) {
    const byte = data[i];
    if (!state.readMultiByte) {
      processSingleByte(state, byte);
    } else {
      processMultiByte(state, byte);
    }
  }
}

function handleDisconnect(state: TcpClientState): void {
  if (state.disconnected) return; // guard: error event is always followed by close event
  state.disconnected = true;

  const decoder = tcpDecoders.get(state.id);
  if (decoder) {
    decoder.stop();
    tcpDecoders.delete(state.id);
  }

  const client = roomManager.getClient(state.id);
  if (client?.room) {
    const leftPkt = buildUserLeft(client.name);
    roomManager.broadcastToRoom(client.room, leftPkt, state.id);
    logger.info({ id: state.id, name: client.name, room: client.room }, "TCP eQSO client left room");
  }
  roomManager.removeClient(state.id);
  logger.info({ id: state.id }, "TCP eQSO client disconnected");
}

export function startTcpServer(port: number): net.Server {
  const server = net.createServer((socket) => {
    const id = randomUUID();
    logger.info({ id, addr: socket.remoteAddress }, "New TCP eQSO connection");

    const state: TcpClientState = {
      id,
      socket,
      buf: Buffer.alloc(0),
      readMultiByte: false,
      multiByteCmd: 0,
      handshakeDone: false,
      disconnected: false,
    };

    if (!roomManager.isEnabled()) {
      socket.write(buildErrorMessage("Servidor desactivado temporalmente"));
      socket.destroy();
      return;
    }

    const clientInfo: ClientInfo = {
      id,
      name: `_ANON_${id.slice(0, 6)}`,
      room: "",
      message: "",
      protocol: "tcp",
      connectedAt: Date.now(),
      txBytes: 0,
      rxBytes: 0,
      pingMs: 0,
      send: (data: Buffer) => { clientInfo.txBytes += data.length; safeWrite(state, data); },
      close: () => socket.destroy(),
    };

    roomManager.addClient(clientInfo);
    logger.info({ id, addr: socket.remoteAddress }, "eQSO TCP client registered — waiting for handshake");

    // Spawn per-client FFmpeg GSM decoder.  The 500ms startup warmup happens here
    // so the process is ready by the time the client starts transmitting audio.
    const decoder = new FfmpegGsmDecoder();
    tcpDecoders.set(id, decoder);

    // Cola de paquetes PCM con limitador de tasa: un paquete cada AUDIO_PACE_MS.
    // Sin esto, FFmpeg puede emitir varios paquetes en el mismo tick de Node.js
    // (rafaga), el navegador los recibe todos a la vez y el scheduler Web Audio
    // API desborda → solapamiento / "bucle".
    // 120ms = duración exacta de un paquete GSM (960 samples a 8000 Hz).
    // Usar 110ms causaba que el scheduler del navegador se adelantara ~10ms por
    // paquete → en 12 segundos = ~1s de "cola fantasma" que se reproducía como
    // eco de lo ya hablado tras terminar la transmisión.
    const AUDIO_PACE_MS = 120; // igual a la duración real del paquete GSM
    const audioPaceQueue: Buffer[] = [];
    let audioPaceTimer: ReturnType<typeof setTimeout> | null = null;

    const sendNextAudioPkt = () => {
      const pkt = audioPaceQueue.shift();
      if (!pkt) { audioPaceTimer = null; return; }
      const room = roomManager.getClient(id)?.room;
      if (room) roomManager.broadcastBinToLocalWsClients(room, pkt, id);
      audioPaceTimer = setTimeout(sendNextAudioPkt, AUDIO_PACE_MS);
    };

    // Cuando el cliente envía RELEASE_PTT (0x0d), drenamos el pace queue sin
    // esperar los 120ms entre paquetes. Los últimos N paquetes GSM del relay CB
    // llegan en el mismo tick de Node.js; el navegador los encola secuencialmente
    // en su nextPlayTimeRef (sin solapamiento) pero sin el retardo del pace timer.
    // Efecto: el final de la transmisión llega al cliente sin cola de eco.
    state.flushPaceQueue = () => {
      if (audioPaceTimer) { clearTimeout(audioPaceTimer); audioPaceTimer = null; }
      const room = roomManager.getClient(id)?.room;
      if (!room) { audioPaceQueue.length = 0; return; }
      while (audioPaceQueue.length > 0) {
        const pkt = audioPaceQueue.shift()!;
        roomManager.broadcastBinToLocalWsClients(room, pkt, id);
      }
    };

    decoder.on("pcm", (pcm: Int16Array) => {
      const cli = roomManager.getClient(id);
      if (!cli?.room) return;
      const float32 = new Float32Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) {
        float32[i] = Math.max(-0.45, Math.min(0.45, pcm[i] / 32768.0));
      }
      const wsPkt = Buffer.concat([Buffer.from([0x11]), Buffer.from(float32.buffer)]);
      audioPaceQueue.push(wsPkt);
      if (!audioPaceTimer) sendNextAudioPkt(); // primer paquete sale inmediatamente
    });
    decoder.start();

    const keepaliveTimer = setInterval(() => {
      if (socket.destroyed) {
        clearInterval(keepaliveTimer);
        return;
      }
      safeWrite(state, KEEPALIVE_PACKET);
    }, KEEPALIVE_INTERVAL_MS);

    socket.on("data", (data: Buffer) => {
      const ci = roomManager.getClient(id);
      if (ci) ci.rxBytes += data.length;
      handleData(state, data);
    });

    socket.on("close", () => {
      clearInterval(keepaliveTimer);
      handleDisconnect(state);
    });

    socket.on("error", (err) => {
      logger.warn({ err, id }, "TCP socket error");
      clearInterval(keepaliveTimer);
      handleDisconnect(state);
    });

    socket.setTimeout(120_000);
    socket.on("timeout", () => {
      socket.destroy();
    });
  });

  server.listen(port, "0.0.0.0", () => {
    logger.info({ port }, "eQSO TCP server listening");
  });

  server.on("error", (err) => {
    logger.error({ err }, "eQSO TCP server error");
  });

  return server;
}
