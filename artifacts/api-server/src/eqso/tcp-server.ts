import net from "net";
import { randomUUID } from "crypto";
import { logger } from "../lib/logger";
import { roomManager, ClientInfo } from "./room-manager";
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

interface TcpClientState {
  id: string;
  socket: net.Socket;
  buf: Buffer;
  readMultiByte: boolean;
  multiByteCmd: number;
  handshakeDone: boolean;
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
      if (client?.room) {
        const ptt = buildPttStarted(client.name);
        roomManager.tryLockRoom(client.room, state.id);
        roomManager.broadcastToRoom(client.room, ptt, state.id);
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
        if (state.buf.equals(HANDSHAKE_CLIENT)) {
          safeWrite(state, HANDSHAKE_SERVER);
          state.handshakeDone = true;
          sendServerInfo(state);
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
        if (client?.room) {
          const audioPkt = Buffer.concat([Buffer.from([0x01]), state.buf.slice(0, AUDIO_PAYLOAD_SIZE)]);
          roomManager.broadcastToRoom(client.room, audioPkt, state.id);
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

  const serverPassword = process.env.EQSO_PASSWORD ?? "";
  if (serverPassword && password !== serverPassword) {
    safeWrite(state, buildErrorMessage("Acceso denegado: contraseña incorrecta"));
    logger.warn({ id: state.id, name }, "TCP client rejected: wrong password");
    state.socket.destroy();
    return;
  }

  if (!name || name.length > 20) {
    safeWrite(state, buildErrorMessage("Invalid callsign (max 20 chars)"));
    return;
  }
  if (!room || room.length > 20) {
    safeWrite(state, buildErrorMessage("Invalid room name (max 20 chars)"));
    return;
  }
  if (roomManager.isNameTaken(name, state.id)) {
    safeWrite(state, buildErrorMessage(`Callsign "${name}" already in use`));
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
    members.filter((m) => m.id !== state.id).map((m) => ({ name: m.name, message: m.message }))
  );
  safeWrite(state, memberList);

  const joinedPkt = buildUserJoined(name, message);
  for (const m of members) {
    if (m.id !== state.id) m.send(joinedPkt);
  }

  logger.info({ id: state.id, name, room }, "TCP client joined room");
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
  const client = roomManager.getClient(state.id);
  if (client?.room) {
    const leftPkt = buildUserLeft(client.name);
    roomManager.broadcastToRoom(client.room, leftPkt, state.id);
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
    };

    const clientInfo: ClientInfo = {
      id,
      name: `_ANON_${id.slice(0, 6)}`,
      room: "",
      message: "",
      send: (data: Buffer) => safeWrite(state, data),
      close: () => socket.destroy(),
    };

    roomManager.addClient(clientInfo);
    sendRoomList(state);

    const keepaliveTimer = setInterval(() => {
      if (socket.destroyed) {
        clearInterval(keepaliveTimer);
        return;
      }
      safeWrite(state, KEEPALIVE_PACKET);
    }, KEEPALIVE_INTERVAL_MS);

    socket.on("data", (data: Buffer) => {
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
