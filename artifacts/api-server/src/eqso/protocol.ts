export const EQSO_COMMANDS = {
  VOICE: 0x01,
  IGNORE: 0x02,
  KEEPALIVE: 0x0c,
  RELEASE_PTT: 0x0d,
  HANDSHAKE: 0x0a,
  ROOM_LIST: 0x14,
  CLIENT_INFO: 0x15,
  USER_UPDATE: 0x16,
  JOIN: 0x1a,
  PTT_RELEASE_1: 0x08,
  PTT_RELEASE_2: 0x06,
} as const;

export const SERVER_NAME = "_SERVER_";
export const ROOM_ALL = "_ALL_";
// eQSO audio: GSM 06.10 full-rate codec (libgsm), 6 frames × 33 bytes = 198 bytes
// Each frame encodes 20 ms at 8 kHz → 120 ms per packet (~8.3 packets/s)
// GSM magic nibble 0xd appears at byte offsets 0, 33, 66, 99, 132, 165 of every packet
export const AUDIO_PAYLOAD_SIZE = 198;

export const HANDSHAKE_CLIENT = Buffer.from([0x0a, 0x82, 0x00, 0x00, 0x00]);
export const HANDSHAKE_SERVER = Buffer.from([0x0a, 0xfa, 0x00, 0x00, 0x00]);
export const KEEPALIVE_PACKET = Buffer.from([0x0c]);

export function buildServerInfo(serverMsg: string): Buffer {
  const nameBytes = Buffer.from(SERVER_NAME, "ascii");
  const msgBytes = Buffer.from(serverMsg, "ascii");
  return Buffer.concat([
    Buffer.from([0x16, 0x01, 0x00, 0x00]),
    Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00]),
    Buffer.from([nameBytes.length]),
    nameBytes,
    Buffer.from([msgBytes.length]),
    msgBytes,
    Buffer.from([0x00]),
  ]);
}

export function buildRoomList(rooms: string[]): Buffer {
  const parts: Buffer[] = [
    Buffer.from([0x14, rooms.length & 0xff, 0x00, 0x00, 0x00]),
  ];
  for (const room of rooms) {
    const rb = Buffer.from(room, "ascii");
    parts.push(Buffer.from([rb.length]), rb);
  }
  return Buffer.concat(parts);
}

export function buildUserList(
  clients: Array<{ name: string; message: string }>
): Buffer {
  const parts: Buffer[] = [
    Buffer.from([0x16, clients.length & 0xff, 0x00, 0x00]),
  ];
  for (const c of clients) {
    const nb = Buffer.from(c.name, "ascii");
    const mb = Buffer.from(c.message, "ascii");
    parts.push(
      Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00]),
      Buffer.from([nb.length]),
      nb,
      Buffer.from([mb.length]),
      mb
    );
  }
  parts.push(Buffer.from([0x00]));
  return Buffer.concat(parts);
}

export function buildUserJoined(name: string, message: string): Buffer {
  const nb = Buffer.from(name, "ascii");
  const mb = Buffer.from(message, "ascii");
  return Buffer.concat([
    Buffer.from([0x16, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
    Buffer.from([nb.length]),
    nb,
    Buffer.from([mb.length]),
    mb,
    Buffer.from([0x00]),
  ]);
}

export function buildUserLeft(name: string): Buffer {
  const nb = Buffer.from(name, "ascii");
  return Buffer.concat([
    Buffer.from([0x16, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00]),
    Buffer.from([nb.length]),
    nb,
    Buffer.from([0x00]),
  ]);
}

export function buildPttStarted(name: string): Buffer {
  const nb = Buffer.from(name, "ascii");
  return Buffer.concat([
    Buffer.from([0x16, 0x01, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00]),
    Buffer.from([nb.length]),
    nb,
    Buffer.from([0x00]),
  ]);
}

export function buildPttReleased(name: string): Buffer {
  const nb = Buffer.from(name, "ascii");
  return Buffer.concat([
    Buffer.from([0x16, 0x01, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00]),
    Buffer.from([nb.length]),
    nb,
    Buffer.from([0x00]),
  ]);
}

export function buildErrorMessage(msg: string): Buffer {
  const errName = Buffer.from("!Error!", "ascii");
  const msgBuf = Buffer.from(msg, "ascii");
  return Buffer.concat([
    Buffer.from([0x16, 0x01, 0x00, 0x00]),
    Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00]),
    Buffer.from([errName.length]),
    errName,
    Buffer.from([msgBuf.length]),
    msgBuf,
    Buffer.from([0x00]),
  ]);
}

export interface JoinPacket {
  name: string;
  room: string;
  message: string;
  password: string;
}

export function tryParseJoin(buf: Buffer): JoinPacket | null {
  try {
    let off = 0;
    if (buf.length < 1) return null;

    const nickLen = buf[off++];
    if (buf.length < off + nickLen + 1) return null;
    const name = buf.slice(off, off + nickLen).toString("ascii");
    off += nickLen;

    const roomLen = buf[off++];
    if (buf.length < off + roomLen + 1) return null;
    const room = buf.slice(off, off + roomLen).toString("ascii");
    off += roomLen;

    const msgLen = buf[off++];
    if (buf.length < off + msgLen + 1) return null;
    const message = buf.slice(off, off + msgLen).toString("ascii");
    off += msgLen;

    const pwdLen = buf[off++];
    if (buf.length < off + pwdLen) return null;
    const password = buf.slice(off, off + pwdLen).toString("ascii");

    return { name, room, message, password };
  } catch {
    return null;
  }
}
