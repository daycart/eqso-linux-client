import net from "net";
import { randomUUID } from "crypto";
import { logger } from "../lib/logger";
import { roomManager, ClientInfo } from "./room-manager";
import { GsmFfmpegDecoder } from "./gsm-decoder-ffmpeg";
import { inactivityManager } from "./inactivity-manager";
import { moderationManager } from "./moderation-manager";
import { courtesyBeepManager } from "./courtesy-beep-manager";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { pcmToFloat32Normalized } from "./pcm-utils";
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

// Un decoder GSM FFmpeg por cliente TCP (stateful, clave = UUID del cliente).
// Se crea al conectar y se destruye al desconectar.
const tcpDecoders = new Map<string, GsmFfmpegDecoder>();

interface TcpClientState {
  id: string;
  socket: net.Socket;
  buf: Buffer;
  readMultiByte: boolean;
  multiByteCmd: number;
  handshakeDone: boolean;
  disconnected: boolean; // guard against double-disconnect (error + close both fire)
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
        // Solo emitir ptt_started en el PRIMER paquete de cada sesión TX.
        // tryLockRoom devuelve true tanto si acaba de bloquear como si ya estaba
        // bloqueado por este cliente, así que usamos isLockedBy para detectar
        // si el lock ya era nuestro antes de esta llamada.
        // Sin esta guarda, ptt_started se emitía cada 120ms (un broadcast por
        // cada paquete GSM), lo que hacía que los clientes eQSO externos
        // (Windows ASORAPA) los recibieran como ráfagas y desconectaran.
        const wasAlreadyOurs = roomManager.isLockedBy(client.room, state.id);
        roomManager.tryLockRoom(client.room, state.id);
        if (!wasAlreadyOurs) {
          roomManager.broadcastToRoom(client.room, buildPttStarted(client.name), state.id);
        }
        inactivityManager.recordActivity(client.room);
      }
      state.readMultiByte = true;
      state.multiByteCmd = EQSO_COMMANDS.VOICE;
      state.buf = Buffer.alloc(0);
      break;

    case EQSO_COMMANDS.IGNORE:
      // [0x02] silence frame — el relay-daemon lo envía como 1 BYTE solo (cada 150ms).
      // Lo reenviamos inmediatamente a todos los demás miembros de la sala.
      // Los relays Windows eQSO usan este byte como indicador "servidor vivo":
      // si no reciben datos en ~10-15s, se desconectan. Con 7 frames/s (150ms)
      // el timer de desconexión Windows nunca se dispara.
      // NOTA: NO entramos en modo multi-byte — consumir los 4 [0x02] siguientes
      // como "payload" retrasaba el broadcast a 750ms y enviaba 4 bytes [0x00]
      // extra que podían corromper el parser de los relays Windows.
      if (client?.room) {
        roomManager.broadcastToRoom(client.room, Buffer.from([0x02]), state.id);
      }
      break;

    case EQSO_COMMANDS.KEEPALIVE:
      // El cliente nos envió [0x0c]: NO hacemos eco de vuelta.
      // El servidor envía [0x0c] PROACTIVO cada 8s (ver setInterval más abajo).
      // Hacer eco de vuelta del [0x0c] del cliente creaba un bucle de ping-pong
      // [0x0c]→[0x0c]→[0x0c] que causaba drops en los relays Windows cada 30-60s.
      break;

    case EQSO_COMMANDS.RELEASE_PTT:
      if (client?.room) {
        const rel = buildPttReleased(client.name);
        roomManager.broadcastToRoom(client.room, rel, state.id);
        // Solo [0x08] (canal liberado OK). El [0x06, 0x00] que enviábamos antes
        // hacía que los relays Windows eQSO se desconectaran 17ms después de
        // liberar PTT (lo interpretaban como "expulsado de sala").
        safeWrite(state, Buffer.from([0x08]));
        roomManager.unlockRoom(client.room, state.id);

        // Tono de cortesía: solo si es un cliente relay (radio CB).
        // El relay-daemon tiene POST_TX_SUPPRESS_MS=100ms. Con 300ms de espera
        // el beep llega 200ms después de que expire la ventana de supresión.
        if (client.isRelay) {
          const beepPackets = courtesyBeepManager.getPackets();
          if (beepPackets.length > 0) {
            let i = 0;
            const sendBeep = () => {
              if (state.disconnected || i >= beepPackets.length) return;
              safeWrite(state, beepPackets[i++]!);
              if (i < beepPackets.length) setTimeout(sendBeep, 120);
            };
            setTimeout(sendBeep, 300);
          }
        }
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
        handleJoin(state, parsed.name, parsed.room, parsed.message, parsed.password)
          .catch(err => logger.error({ err }, "handleJoin async error"));
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

          // Decode GSM → Float32 vía FFmpeg (asíncrono).
          // El handler del evento "pcm" (registrado al conectar) envía a clientes WS.
          tcpDecoders.get(state.id)?.decode(gsmPayload);
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

async function handleJoin(
  state: TcpClientState,
  name: string,
  room: string,
  message: string,
  password: string
): Promise<void> {
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
    state.socket.destroy();
    return;
  }

  // Detect relay: callsigns starting with "0R-" are always relays (eQSO convention).
  // Also check the DB users table for manually-flagged relays.
  let isRelay = name.toUpperCase().startsWith("0R-");
  if (!isRelay) {
    try {
      const [user] = await db.select({ isRelay: usersTable.isRelay })
        .from(usersTable)
        .where(eq(usersTable.callsign, name.toUpperCase()))
        .limit(1);
      isRelay = user?.isRelay ?? false;
    } catch (err) {
      logger.warn({ err, name }, "TCP handleJoin: DB isRelay lookup failed");
    }
  }

  const client = roomManager.getClient(state.id);
  if (client) {
    client.name = name;
    client.message = message;
    client.isRelay = isRelay;
    if (isRelay) logger.info({ id: state.id, name }, "TCP client identified as relay");
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

  const dec = tcpDecoders.get(state.id);
  if (dec) { dec.stop(); tcpDecoders.delete(state.id); }

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

    // Decoder GSM vía FFmpeg por cliente TCP (async, event-based).
    // Cuando el relay daemon envía GSM, ffmpeg lo decodifica a PCM y emite
    // el evento "pcm" que aquí se reenvía a los clientes WS del navegador.
    const tcpDecoder = new GsmFfmpegDecoder();
    let lastPcmMs = 0;
    let pktCount = 0;
    tcpDecoder.on("pcm", (pcm: Int16Array) => {
      const client = roomManager.getClient(state.id);
      if (client?.room) {
        const nowMs = Date.now();
        pktCount++;
        if (lastPcmMs > 0) {
          const gap = nowMs - lastPcmMs;
          // Log si el intervalo se desvía más de 40ms del ideal 120ms
          if (gap > 160 || gap < 80) {
            logger.warn({ pkt: pktCount, gap, client: client.name }, "pcm gap fuera de rango (esperado ~120ms)");
          }
        }
        lastPcmMs = nowMs;
        const float32 = pcmToFloat32Normalized(pcm);
        const wsPkt = Buffer.concat([Buffer.from([0x11]), Buffer.from(float32.buffer)]);
        roomManager.broadcastBinToLocalWsClients(client.room, wsPkt, state.id);
      }
    });
    tcpDecoder.start();
    tcpDecoders.set(id, tcpDecoder);

    // TCP keepalive a nivel kernel: tras 30s de inactividad de aplicacion, el
    // OS envía probes TCP al extremo remoto. Si este responde (connection alive),
    // el kernel resetea el timer y el socket permanece abierto indefinidamente
    // aunque no haya trafico eQSO durante horas (caso habitual en CB con poca
    // actividad). Si el remoto no responde a los probes (maquina apagada, red
    // cortada), el kernel cierra el socket tras ~9 reintentos × 75s ≈ 11 min.
    //
    // IMPORTANTE: socket.setTimeout() mide inactividad a nivel de aplicacion
    // (datos Node.js) — los probes TCP del kernel NO lo resetean. Por eso NO
    // usamos setTimeout: un relay silencioso horas enteras dispararía el timeout
    // aunque la conexion TCP este perfectamente viva gracias al keepalive OS.
    socket.setKeepAlive(true, 30_000);

    // Keepalive proactivo [0x0c] cada 8s: los relays Windows eQSO (JN11BK,
    // IN53SI, ASORAPA) desconectan si no reciben ningún dato durante ~13s.
    // El relay-daemon envía [0x02] cada 150ms pero esos son cliente→servidor;
    // lo que los Windows relays necesitan es datos SERVIDOR→cliente.
    // [0x0c] = keepalive estándar eQSO; lo enviamos cada 8s sin esperar
    // respuesta (el eco del cliente se silencia en el case KEEPALIVE arriba).
    const keepaliveInterval = setInterval(() => {
      if (!state.disconnected) safeWrite(state, KEEPALIVE_PACKET);
    }, 8_000);

    socket.on("data", (data: Buffer) => {
      const ci = roomManager.getClient(id);
      if (ci) ci.rxBytes += data.length;
      handleData(state, data);
    });

    socket.on("close", () => {
      clearInterval(keepaliveInterval);
      handleDisconnect(state);
    });

    socket.on("error", (err) => {
      clearInterval(keepaliveInterval);
      logger.warn({ err, id }, "TCP socket error");
      handleDisconnect(state);
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
