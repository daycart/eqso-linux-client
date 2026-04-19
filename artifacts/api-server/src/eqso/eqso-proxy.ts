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

      // 0x08 — single-byte opcode (discard), same as 0x09
      if (cmd === 0x08) {
        this.acc = this.acc.slice(1);
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

    // count > 1: multiple action events bundled together.
    // Same per-entry format as count=1:
    //   Header:  [0x16][count][0x00 0x00 0x00]  (5 bytes total)
    //   Entry i: [action:1][0x00 0x00 0x00:3][nameLen:1][name:N bytes]
    //            (+[msgLen:1][msg:M][term:1] when action=0x00 join)
    if (this.acc.length < 5) return null;
    let off = 5; // skip [0x16][count][0x00 0x00 0x00]
    for (let i = 0; i < count; i++) {
      if (this.acc.length < off + 5) return null;
      const action = this.acc[off];
      off += 4; // action(1) + padding(3)
      const nameLen = this.acc[off++];
      if (this.acc.length < off + nameLen) return null;
      off += nameLen;
      if (action === 0x00) {
        // join entry: also has [msgLen][msg][terminator]
        if (this.acc.length < off + 1) return null;
        const msgLen = this.acc[off++];
        if (this.acc.length < off + msgLen + 1) return null;
        off += msgLen + 1; // msg + terminator
      }
    }
    const pkt = this.acc.slice(0, off);
    this.acc = this.acc.slice(off);
    return pkt;
  }
}

// ---------------------------------------------------------------------------
// EqsoProxy — connects to a remote eQSO TCP server and translates packets
// ---------------------------------------------------------------------------
// Silence frame interval — eQSO clients send 0x02 every ~150ms when idle.
// The server uses these to detect that a client is "ready" (not transmitting).
// Without them, the server may ignore PTT requests.
const SILENCE_INTERVAL_MS = 150;

interface PendingJoin {
  name: string;
  room: string;
  message: string;
  password: string;
}

export class EqsoProxy extends EventEmitter {
  private socket: net.Socket | null = null;
  private parser = new EqsoPacketParser();
  private handshakeDone = false;
  private host: string;
  private port: number;
  private connected = false;
  private silenceTimer: ReturnType<typeof setInterval> | null = null;
  private transmitting = false;
  private pendingJoin: PendingJoin | null = null;

  constructor(host: string, port: number) {
    super();
    this.host = host;
    this.port = port;
  }

  /** Start sending 0x02 silence frames (idle heartbeat). */
  private startSilenceFrames(): void {
    if (this.silenceTimer) return;
    this.silenceTimer = setInterval(() => {
      if (!this.transmitting) {
        this.socketWrite(Buffer.from([0x02]));
      }
    }, SILENCE_INTERVAL_MS);
  }

  /** Stop the silence frame timer (called when we disconnect). */
  private stopSilenceFrames(): void {
    if (this.silenceTimer) {
      clearInterval(this.silenceTimer);
      this.silenceTimer = null;
    }
  }

  connect(): void {
    const sock = new net.Socket();
    this.socket = sock;

    sock.connect(this.port, this.host, () => {
      logger.info({ host: this.host, port: this.port }, "eQSO proxy TCP connected");
      this.connected = true;
      sock.write(HANDSHAKE_CLIENT);
      logger.debug("eQSO proxy: sent handshake");
      // Silence heartbeat starts after handshake confirms (see 0x0a handler)
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
      this.stopSilenceFrames();
      this.emit("event", { type: "disconnected" } as ProxyEvent);
      logger.info({ host: this.host }, "eQSO proxy TCP closed");
    });

    sock.on("error", (err) => {
      this.connected = false;
      this.stopSilenceFrames();
      this.emit("event", { type: "error", data: (err as Error).message } as ProxyEvent);
      logger.warn({ err, host: this.host }, "eQSO proxy TCP error");
    });

    sock.setTimeout(90_000);
    sock.on("timeout", () => sock.destroy());
  }

  disconnect(): void {
    this.stopSilenceFrames();
    this.socket?.destroy();
    this.socket = null;
    this.connected = false;
    this.handshakeDone = false;
    this.pendingJoin = null;
  }

  sendJoin(name: string, room: string, message: string, password = ""): void {
    if (!this.handshakeDone) {
      this.pendingJoin = { name, room, message, password };
      logger.info({ name, room }, "eQSO proxy: join queued — waiting for TCP handshake");
      return;
    }
    const pkt = buildJoinPacket(name, room, message, password);
    logger.info(
      { name, room, hex: pkt.toString("hex") },
      "eQSO proxy: sending join packet"
    );
    this.socketWrite(pkt);
  }

  /**
   * Signal PTT start to the eQSO server.
   * In the eQSO protocol there is no separate PTT-announce opcode.
   * The first [0x01][198 bytes GSM] voice frame itself announces PTT.
   * We only need to stop the silence heartbeat so the channel is free.
   */
  startTransmitting(): void {
    this.transmitting = true;
    logger.info("eQSO proxy: TX started — silence heartbeat paused");
  }

  sendPttEnd(): void {
    this.transmitting = false;
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

      // HANDSHAKE response — start idle silence frames once confirmed
      case 0x0a:
        if (!this.handshakeDone) {
          this.handshakeDone = true;
          logger.info({ hex: pkt.toString("hex") }, "eQSO proxy: handshake from server");
          this.emit("event", { type: "connected" } as ProxyEvent);
          // Start sending 0x02 silence heartbeats now that handshake is done
          this.startSilenceFrames();
          // Flush any join that arrived before the handshake was complete
          if (this.pendingJoin) {
            const pj = this.pendingJoin;
            this.pendingJoin = null;
            logger.info({ name: pj.name, room: pj.room }, "eQSO proxy: flushing queued join after handshake");
            this.sendJoin(pj.name, pj.room, pj.message, pj.password);
          }
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
        logger.info({ payloadBytes: audioPkt.length - 1 }, "eQSO proxy: audio packet from server");
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

    // Multi-entry: multiple action events bundled (same per-entry format as count=1)
    // Header: [0x16][count][0x00 0x00 0x00] (5 bytes)
    // Entry:  [action:1][0x00 0x00 0x00:3][nameLen:1][name:N]
    let off = 5;
    for (let i = 0; i < count; i++) {
      if (off + 5 > pkt.length) break;
      const action = pkt[off];
      off += 4; // action(1) + padding(3)
      const nameLen = pkt[off++];
      if (off + nameLen > pkt.length) break;
      const name = pkt.slice(off, off + nameLen).toString("ascii");
      off += nameLen;

      switch (action) {
        case 0x00: {
          if (off >= pkt.length) break;
          const msgLen = pkt[off++];
          const msg = off + msgLen <= pkt.length
            ? pkt.slice(off, off + msgLen).toString("ascii") : "";
          off += msgLen;
          if (off < pkt.length) off++; // terminator
          logger.info({ name, msg }, "eQSO proxy: user joined (multi)");
          this.emit("event", { type: "user_joined", data: { name, message: msg } } as ProxyEvent);
          break;
        }
        case 0x01:
          logger.info({ name }, "eQSO proxy: user left (multi)");
          this.emit("event", { type: "user_left", data: { name } } as ProxyEvent);
          break;
        case 0x02:
          logger.info({ name }, "eQSO proxy: PTT started (multi)");
          this.emit("event", { type: "ptt_started", data: { name } } as ProxyEvent);
          break;
        case 0x03:
          logger.info({ name }, "eQSO proxy: PTT released (multi)");
          this.emit("event", { type: "ptt_released", data: { name } } as ProxyEvent);
          break;
        default:
          logger.debug({ action, name }, "eQSO proxy: unknown action (multi)");
          break;
      }
    }
  }
}
