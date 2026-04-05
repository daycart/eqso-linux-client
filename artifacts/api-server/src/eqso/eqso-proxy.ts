import net from "net";
import { EventEmitter } from "events";
import { logger } from "../lib/logger";
import { AUDIO_PAYLOAD_SIZE } from "./protocol";

const HANDSHAKE_CLIENT = Buffer.from([0x0a, 0x82, 0x00, 0x00, 0x00]);

function buildJoinPacket(name: string, room: string, message: string, password: string): Buffer {
  const nb = Buffer.from(name.slice(0, 20), "ascii");
  const rb = Buffer.from(room.slice(0, 20), "ascii");
  const mb = Buffer.from(message.slice(0, 100), "ascii");
  const pb = Buffer.from(password.slice(0, 50), "ascii");
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

// ---------------------------------------------------------------------------
// Packet parser — accumulates bytes and tries to extract complete packets
// ---------------------------------------------------------------------------
class EqsoPacketParser {
  private acc = Buffer.alloc(0);

  feed(data: Buffer): void {
    this.acc = Buffer.concat([this.acc, data]);
  }

  /**
   * Try to pull the next complete packet from the accumulator.
   * Returns a Buffer (the full packet including opcode) or null if not enough data.
   */
  next(): Buffer | null {
    while (this.acc.length > 0) {
      const cmd = this.acc[0];

      // 0x0c  keepalive  — 1 byte
      if (cmd === 0x0c) {
        const pkt = this.acc.slice(0, 1);
        this.acc = this.acc.slice(1);
        return pkt;
      }

      // 0x08 PTT release 1 — [0x08][nameLen][name]
      if (cmd === 0x08) {
        if (this.acc.length < 2) return null;
        const nameLen = this.acc[1];
        const total = 2 + nameLen;
        if (this.acc.length < total) return null;
        this.acc = this.acc.slice(total);
        continue; // discard
      }

      // 0x06 PTT release 2 — [0x06][nameLen][name]
      if (cmd === 0x06) {
        if (this.acc.length < 2) return null;
        const nameLen = this.acc[1];
        const total = 2 + nameLen;
        if (this.acc.length < total) return null;
        this.acc = this.acc.slice(total);
        continue; // discard
      }

      // 0x09 unknown signal — 1 byte
      if (cmd === 0x09) {
        this.acc = this.acc.slice(1);
        continue; // discard
      }

      // 0x0b server text message — [0x0b] [len] [text...] [0x03]
      if (cmd === 0x0b) {
        if (this.acc.length < 2) return null;
        const textLen = this.acc[1];
        const total = 2 + textLen + 1; // cmd + len + text + terminator
        if (this.acc.length < total) return null;
        const pkt = this.acc.slice(0, total);
        this.acc = this.acc.slice(total);
        return pkt;
      }

      // 0x0a HANDSHAKE — 5 bytes
      if (cmd === 0x0a) {
        if (this.acc.length < 5) return null;
        const pkt = this.acc.slice(0, 5);
        this.acc = this.acc.slice(5);
        return pkt;
      }

      // 0x14 ROOM LIST — 0x14 count [0x00 0x00 0x00] [len name]*
      if (cmd === 0x14) {
        if (this.acc.length < 5) return null;
        const count = this.acc[1];
        let off = 5;
        for (let i = 0; i < count; i++) {
          if (off >= this.acc.length) return null;
          const nameLen = this.acc[off++];
          if (off + nameLen > this.acc.length) return null;
          off += nameLen;
        }
        const pkt = this.acc.slice(0, off);
        this.acc = this.acc.slice(off);
        return pkt;
      }

      // 0x16 USER UPDATE — variable
      if (cmd === 0x16) {
        const result = this.tryParseUserUpdate();
        if (result === null) return null;
        if (result === false) continue; // discard, already consumed
        return result;
      }

      // 0x01 AUDIO — 0x01 + AUDIO_PAYLOAD_SIZE bytes
      if (cmd === 0x01) {
        if (this.acc.length < 1 + AUDIO_PAYLOAD_SIZE) return null;
        const pkt = this.acc.slice(0, 1 + AUDIO_PAYLOAD_SIZE);
        this.acc = this.acc.slice(1 + AUDIO_PAYLOAD_SIZE);
        return pkt;
      }

      // Unknown byte — skip
      logger.debug({ cmd: cmd.toString(16) }, "eQSO proxy: unknown byte, skipping");
      this.acc = this.acc.slice(1);
    }
    return null;
  }

  /**
   * Try to parse a complete 0x16 USER_UPDATE packet.
   * Returns the packet Buffer if complete, null if need more data, false to discard.
   */
  private tryParseUserUpdate(): Buffer | null | false {
    if (this.acc.length < 2) return null;
    const count = this.acc[1];

    if (count === 0) {
      // Empty list — just the 4-byte header
      if (this.acc.length < 4) return null;
      const pkt = this.acc.slice(0, 4);
      this.acc = this.acc.slice(4);
      return pkt;
    }

    if (count === 1) {
      // Single action event:
      //   [0x16][0x01][0x00][0x00][0x00][action][0x00][0x00][0x00][nameLen][name...]
      //   action 0x00 (join) adds: [msgLen][msg][0x00]
      //   other actions (ptt/leave): no message, no terminator
      if (this.acc.length < 10) return null;
      const action = this.acc[5];
      const nameLen = this.acc[9];
      let off = 10 + nameLen;
      if (this.acc.length < off) return null;
      if (action === 0x00) {
        // join: msgLen + msg + terminator
        if (this.acc.length < off + 1) return null;
        const msgLen = this.acc[off++];
        off += msgLen;
        if (this.acc.length < off + 1) return null;
        off++; // terminator
      }
      const pkt = this.acc.slice(0, off);
      this.acc = this.acc.slice(off);
      return pkt;
    }

    // count > 1: member list
    // Header: [0x16][count][0x00][0x00] (4 bytes)
    // Each entry: [5 flag bytes][nameLen][name][msgLen][msg]  (no per-entry terminator)
    // Final: [0x00] (single packet terminator)
    if (this.acc.length < 4) return null;
    let off = 4;
    for (let i = 0; i < count; i++) {
      // need 5 flags + nameLen byte
      if (this.acc.length < off + 6) return null;
      off += 5; // skip 5 flag bytes
      const nameLen = this.acc[off++];
      if (this.acc.length < off + nameLen + 1) return null; // need name + msgLen byte
      off += nameLen;
      const msgLen = this.acc[off++];
      if (this.acc.length < off + msgLen) return null;
      off += msgLen;
    }
    // Single terminator byte at the end
    if (this.acc.length < off + 1) return null;
    off++;
    const pkt = this.acc.slice(0, off);
    this.acc = this.acc.slice(off);
    return pkt;
  }
}

// ---------------------------------------------------------------------------
// EqsoProxy — connects to a remote eQSO TCP server and translates packets
// ---------------------------------------------------------------------------
export class EqsoProxy extends EventEmitter {
  private socket: net.Socket | null = null;
  private parser = new EqsoPacketParser();
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
      logger.debug("eQSO proxy: sent handshake");
    });

    sock.on("data", (data: Buffer) => {
      logger.info(
        { bytes: data.length, hex: data.toString("hex") },
        "eQSO proxy: received TCP data"
      );
      this.parser.feed(data);
      this.drainPackets();
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
    logger.info(
      { name, room, hex: pkt.toString("hex") },
      "eQSO proxy: sending join packet"
    );
    this.socketWrite(pkt);
  }

  sendPttStart(audioData?: Buffer): void {
    const payload = audioData
      ? audioData.slice(0, AUDIO_PAYLOAD_SIZE)
      : Buffer.alloc(AUDIO_PAYLOAD_SIZE);
    const pkt = Buffer.concat([Buffer.from([0x01]), payload]);
    this.socketWrite(pkt);
  }

  sendPttEnd(): void {
    this.socketWrite(Buffer.from([0x0d]));
  }

  sendAudio(data: Buffer): void {
    if (data.length < AUDIO_PAYLOAD_SIZE) {
      const padded = Buffer.alloc(AUDIO_PAYLOAD_SIZE);
      data.copy(padded);
      data = padded;
    }
    const pkt = Buffer.concat([Buffer.from([0x01]), data.slice(0, AUDIO_PAYLOAD_SIZE)]);
    this.socketWrite(pkt);
  }

  private socketWrite(data: Buffer): void {
    if (this.socket && !this.socket.destroyed && this.connected) {
      try {
        this.socket.write(data);
      } catch (err) {
        logger.warn({ err }, "eQSO proxy: socket write error");
      }
    } else {
      logger.debug(
        { connected: this.connected, destroyed: this.socket?.destroyed },
        "eQSO proxy: tried to write but socket not ready"
      );
    }
  }

  private drainPackets(): void {
    let pkt: Buffer | null;
    while ((pkt = this.parser.next()) !== null) {
      this.handlePacket(pkt);
    }
  }

  private handlePacket(pkt: Buffer): void {
    if (pkt.length === 0) return;
    const cmd = pkt[0];

    switch (cmd) {
      // SERVER TEXT MESSAGE (error, announcement)
      case 0x0b: {
        if (pkt.length >= 2) {
          const textLen = pkt[1];
          const text = pkt.slice(2, 2 + textLen).toString("ascii");
          logger.info({ text }, "eQSO proxy: server text message");
          this.emit("event", { type: "server_info", data: text } as ProxyEvent);
        }
        break;
      }

      // KEEPALIVE — echo back to keep the session alive
      case 0x0c:
        this.socketWrite(Buffer.from([0x0c]));
        this.emit("event", { type: "keepalive" } as ProxyEvent);
        break;

      // HANDSHAKE response
      case 0x0a:
        if (!this.handshakeDone) {
          this.handshakeDone = true;
          logger.info({ hex: pkt.toString("hex") }, "eQSO proxy: handshake from server");
          this.emit("event", { type: "connected" } as ProxyEvent);
        }
        break;

      // ROOM LIST
      case 0x14: {
        const count = pkt[1];
        const rooms: string[] = [];
        let off = 5;
        for (let i = 0; i < count; i++) {
          if (off >= pkt.length) break;
          const len = pkt[off++];
          if (off + len > pkt.length) break;
          rooms.push(pkt.slice(off, off + len).toString("ascii"));
          off += len;
        }
        logger.info({ rooms }, "eQSO proxy: room list received");
        this.emit("event", { type: "room_list", data: rooms } as ProxyEvent);
        break;
      }

      // USER UPDATE
      case 0x16:
        this.handleUserUpdate(pkt);
        break;

      // AUDIO
      case 0x01: {
        const audioPkt = pkt; // full buffer including 0x01 opcode
        this.emit("event", { type: "audio", data: audioPkt } as ProxyEvent);
        break;
      }

      default:
        logger.debug({ cmd: cmd.toString(16) }, "eQSO proxy: unhandled packet opcode");
        break;
    }
  }

  private handleUserUpdate(pkt: Buffer): void {
    if (pkt.length < 5) return;
    const count = pkt[1];
    logger.info({ count, hex: pkt.toString("hex") }, "eQSO proxy: user update packet");

    if (count === 0) return;

    // Parse single-entry packets (action events)
    if (count === 1) {
      const action = pkt[5]; // byte at position 5 is the action for single-entry packets
      let off = 9; // 1(cmd) + 1(count) + 2(?) + 1(?) + 4(flags before name) = different layout

      // Layout: [0x16] [count=1] [0x00 0x00] [0x00] [action] [0x00 0x00 0x00] [nameLen] [name] [msgLen?/0x00] [0x00]
      // position: 0      1        2    3       4      5        6    7    8       9
      if (off >= pkt.length) return;
      const nameLen = pkt[off++];
      if (off + nameLen > pkt.length) return;
      const name = pkt.slice(off, off + nameLen).toString("ascii");
      off += nameLen;

      switch (action) {
        case 0x00: { // join with message
          if (off >= pkt.length) return;
          const msgLen = pkt[off++];
          const msg = off + msgLen <= pkt.length
            ? pkt.slice(off, off + msgLen).toString("ascii")
            : "";
          logger.info({ name, msg, action }, "eQSO proxy: user joined");
          this.emit("event", { type: "user_joined", data: { name, message: msg } } as ProxyEvent);
          break;
        }
        case 0x01:
          logger.info({ name }, "eQSO proxy: user left");
          this.emit("event", { type: "user_left", data: { name } } as ProxyEvent);
          break;
        case 0x02:
          logger.info({ name }, "eQSO proxy: PTT started");
          this.emit("event", { type: "ptt_started", data: { name } } as ProxyEvent);
          break;
        case 0x03:
          logger.info({ name }, "eQSO proxy: PTT released");
          this.emit("event", { type: "ptt_released", data: { name } } as ProxyEvent);
          break;
        default:
          logger.debug({ action, name }, "eQSO proxy: unknown user action");
          break;
      }
      return;
    }

    // Multi-entry: member list (after join)
    const members: Array<{ name: string; message: string }> = [];
    let off = 4; // cmd(1) + count(1) + 2 bytes header = 4

    for (let i = 0; i < count; i++) {
      // each entry: 5 bytes flags, nameLen, name, msgLen, msg
      if (off + 5 >= pkt.length) break;
      off += 5; // skip flags
      if (off >= pkt.length) break;
      const nameLen = pkt[off++];
      if (off + nameLen > pkt.length) break;
      const name = pkt.slice(off, off + nameLen).toString("ascii");
      off += nameLen;
      if (off >= pkt.length) break;
      const msgLen = pkt[off++];
      const msg = off + msgLen <= pkt.length
        ? pkt.slice(off, off + msgLen).toString("ascii")
        : "";
      off += msgLen;
      members.push({ name, message: msg });
    }
    logger.info({ count: members.length, members }, "eQSO proxy: member list received");
    this.emit("event", { type: "members", data: members } as ProxyEvent);
  }
}
