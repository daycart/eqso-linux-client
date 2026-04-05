import net from "net";
import { EventEmitter } from "events";
import { logger } from "../lib/logger";
import {
  HANDSHAKE_CLIENT,
  HANDSHAKE_SERVER,
  buildPttStarted,
  buildPttReleased,
  buildUserJoined,
  buildUserLeft,
  tryParseJoin,
  EQSO_COMMANDS,
  AUDIO_PAYLOAD_SIZE,
  KEEPALIVE_PACKET,
} from "./protocol";

function buildJoinPacket(name: string, room: string, message: string, password: string): Buffer {
  const nb = Buffer.from(name, "ascii");
  const rb = Buffer.from(room, "ascii");
  const mb = Buffer.from(message, "ascii");
  const pb = Buffer.from(password, "ascii");
  return Buffer.concat([
    Buffer.from([0x1a]),
    Buffer.from([nb.length]), nb,
    Buffer.from([rb.length]), rb,
    Buffer.from([mb.length]), mb,
    Buffer.from([pb.length]), pb,
    Buffer.from([0x00]),
  ]);
}

export interface ProxyEvent {
  type:
    | "connected"
    | "disconnected"
    | "error"
    | "room_list"
    | "server_info"
    | "members"
    | "user_joined"
    | "user_left"
    | "ptt_started"
    | "ptt_released"
    | "audio"
    | "keepalive";
  data?: unknown;
}

export class EqsoProxy extends EventEmitter {
  private socket: net.Socket | null = null;
  private buf = Buffer.alloc(0);
  private readMultiByte = false;
  private multiByteCmd = 0;
  private multiByteBuf = Buffer.alloc(0);
  private handshakeDone = false;
  private host: string;
  private port: number;
  private connected = false;

  constructor(host: string, port: number) {
    super();
    this.host = host;
    this.port = port;
  }

  connect(): void {
    const sock = new net.Socket();
    this.socket = sock;

    sock.connect(this.port, this.host, () => {
      logger.info({ host: this.host, port: this.port }, "eQSO proxy TCP connected");
      this.connected = true;
      sock.write(HANDSHAKE_CLIENT);
    });

    sock.on("data", (data: Buffer) => {
      this.processData(data);
    });

    sock.on("close", () => {
      this.connected = false;
      this.emit("event", { type: "disconnected" } as ProxyEvent);
      logger.info({ host: this.host }, "eQSO proxy TCP closed");
    });

    sock.on("error", (err) => {
      this.connected = false;
      this.emit("event", { type: "error", data: (err as Error).message } as ProxyEvent);
      logger.warn({ err, host: this.host }, "eQSO proxy TCP error");
    });

    sock.setTimeout(90_000);
    sock.on("timeout", () => sock.destroy());
  }

  disconnect(): void {
    this.socket?.destroy();
    this.socket = null;
    this.connected = false;
  }

  sendJoin(name: string, room: string, message: string, password = ""): void {
    const pkt = buildJoinPacket(name, room, message, password);
    this.socketWrite(pkt);
  }

  sendPttStart(): void {
    this.socketWrite(Buffer.from([0x01, ...new Array(AUDIO_PAYLOAD_SIZE).fill(0)]));
  }

  sendPttEnd(): void {
    this.socketWrite(Buffer.from([0x0d]));
  }

  sendAudio(data: Buffer): void {
    const payload = data.slice(0, AUDIO_PAYLOAD_SIZE);
    const pkt = Buffer.concat([Buffer.from([0x01]), payload]);
    this.socketWrite(pkt);
  }

  private socketWrite(data: Buffer): void {
    if (this.socket && !this.socket.destroyed && this.connected) {
      try {
        this.socket.write(data);
      } catch {
      }
    }
  }

  private processData(data: Buffer): void {
    this.buf = Buffer.concat([this.buf, data]);

    let i = 0;
    while (i < this.buf.length) {
      const byte = this.buf[i];

      if (!this.readMultiByte) {
        switch (byte) {
          case EQSO_COMMANDS.KEEPALIVE:
            this.emit("event", { type: "keepalive" } as ProxyEvent);
            i++;
            break;

          case EQSO_COMMANDS.HANDSHAKE:
            if (this.buf.length - i >= 5) {
              const chunk = this.buf.slice(i, i + 5);
              if (chunk.equals(HANDSHAKE_SERVER)) {
                if (!this.handshakeDone) {
                  this.handshakeDone = true;
                  this.emit("event", { type: "connected" } as ProxyEvent);
                }
              }
              i += 5;
            } else {
              break;
            }
            break;

          case EQSO_COMMANDS.ROOM_LIST: {
            const start = i;
            if (this.buf.length < i + 2) { i = this.buf.length; break; }
            const count = this.buf[i + 1];
            let off = i + 5;
            const rooms: string[] = [];
            for (let r = 0; r < count; r++) {
              if (off >= this.buf.length) break;
              const len = this.buf[off++];
              if (off + len > this.buf.length) { off = this.buf.length; break; }
              rooms.push(this.buf.slice(off, off + len).toString("ascii"));
              off += len;
            }
            if (rooms.length >= 0) {
              this.emit("event", { type: "room_list", data: rooms } as ProxyEvent);
              i = off;
            } else {
              i = this.buf.length;
            }
            break;
          }

          case EQSO_COMMANDS.USER_UPDATE:
            this.readMultiByte = true;
            this.multiByteCmd = EQSO_COMMANDS.USER_UPDATE;
            this.multiByteBuf = Buffer.from([byte]);
            i++;
            break;

          case EQSO_COMMANDS.VOICE:
            this.readMultiByte = true;
            this.multiByteCmd = EQSO_COMMANDS.VOICE;
            this.multiByteBuf = Buffer.alloc(0);
            i++;
            break;

          case 0x08:
          case 0x06:
            i++;
            if (byte === 0x06 && i < this.buf.length && this.buf[i] === 0x00) i++;
            break;

          default:
            i++;
            break;
        }

        if (this.readMultiByte) continue;
        if (i > 0 && i <= this.buf.length) {
          this.buf = this.buf.slice(i);
          i = 0;
        }
      } else {
        this.multiByteBuf = Buffer.concat([this.multiByteBuf, Buffer.from([byte])]);
        i++;

        switch (this.multiByteCmd) {
          case EQSO_COMMANDS.USER_UPDATE: {
            if (this.multiByteBuf.length < 2) break;
            const count = this.multiByteBuf[1];

            if (count === 1 && this.multiByteBuf.length >= 9) {
              const action = this.multiByteBuf[4];
              let off = 8;
              if (off >= this.multiByteBuf.length) break;
              const nameLen = this.multiByteBuf[off++];
              if (off + nameLen > this.multiByteBuf.length) break;
              const name = this.multiByteBuf.slice(off, off + nameLen).toString("ascii");
              off += nameLen;

              if (action === 0x00) {
                if (off >= this.multiByteBuf.length) break;
                const msgLen = this.multiByteBuf[off++];
                if (off + msgLen > this.multiByteBuf.length) break;
                const msg = this.multiByteBuf.slice(off, off + msgLen).toString("ascii");
                off += msgLen;
                if (off >= this.multiByteBuf.length || this.multiByteBuf[off] !== 0x00) break;
                off++;
                this.emit("event", { type: "user_joined", data: { name, message: msg } } as ProxyEvent);
              } else if (action === 0x01) {
                if (off >= this.multiByteBuf.length || this.multiByteBuf[off] !== 0x00) break;
                this.emit("event", { type: "user_left", data: { name } } as ProxyEvent);
                off++;
              } else if (action === 0x02) {
                if (off >= this.multiByteBuf.length || this.multiByteBuf[off] !== 0x00) break;
                this.emit("event", { type: "ptt_started", data: { name } } as ProxyEvent);
                off++;
              } else if (action === 0x03) {
                if (off >= this.multiByteBuf.length || this.multiByteBuf[off] !== 0x00) break;
                this.emit("event", { type: "ptt_released", data: { name } } as ProxyEvent);
                off++;
              }

              this.readMultiByte = false;
              this.buf = Buffer.concat([this.buf.slice(i), this.buf.slice(i)]);
              this.buf = this.buf.slice(i);
              this.multiByteBuf = Buffer.alloc(0);
              i = 0;
            } else if (count > 1 && this.multiByteBuf.length > 4) {
              let off = 4;
              const members: Array<{ name: string; message: string }> = [];
              let complete = true;
              for (let r = 0; r < count; r++) {
                if (off + 5 >= this.multiByteBuf.length) { complete = false; break; }
                off += 5;
                if (off >= this.multiByteBuf.length) { complete = false; break; }
                const nameLen = this.multiByteBuf[off++];
                if (off + nameLen >= this.multiByteBuf.length) { complete = false; break; }
                const name = this.multiByteBuf.slice(off, off + nameLen).toString("ascii");
                off += nameLen;
                const msgLen = this.multiByteBuf[off++];
                if (off + msgLen > this.multiByteBuf.length) { complete = false; break; }
                const msg = this.multiByteBuf.slice(off, off + msgLen).toString("ascii");
                off += msgLen;
                members.push({ name, message: msg });
              }
              if (complete && off < this.multiByteBuf.length && this.multiByteBuf[off] === 0x00) {
                this.emit("event", { type: "members", data: members } as ProxyEvent);
                this.readMultiByte = false;
                this.buf = this.buf.slice(i);
                this.multiByteBuf = Buffer.alloc(0);
                i = 0;
              }
            }
            break;
          }

          case EQSO_COMMANDS.VOICE: {
            if (this.multiByteBuf.length >= AUDIO_PAYLOAD_SIZE) {
              const audioPkt = Buffer.concat([
                Buffer.from([0x01]),
                this.multiByteBuf.slice(0, AUDIO_PAYLOAD_SIZE),
              ]);
              this.emit("event", { type: "audio", data: audioPkt } as ProxyEvent);
              this.multiByteBuf = this.multiByteBuf.slice(AUDIO_PAYLOAD_SIZE);
              if (this.multiByteBuf.length === 0) {
                this.readMultiByte = false;
                this.buf = this.buf.slice(i);
                i = 0;
              }
            }
            break;
          }
        }
      }
    }

    if (i > 0 && i <= this.buf.length) {
      this.buf = this.buf.slice(i);
    }
  }
}
