/**
 * eQSO TCP client — implementacion completa del protocolo eQSO 2.x
 * Compatible con el servidor eQSO de Windows (puerto 2171).
 *
 * Flujo:
 *  1. connect() → TCP socket → HANDSHAKE_CLIENT [0x0a 0x82 0x00 0x00 0x00]
 *  2. Server responde [0x0a 0xfa …] → emitimos "connected"
 *  3. Empezamos silence frames [0x02] cada 150ms (heartbeat de idle)
 *  4. sendJoin() → empezamos a recibir USER_UPDATE y AUDIO
 *  5. KEEPALIVE [0x0c] lo contestamos con [0x0c]
 *  6. TX: startTx() pausa silence, sendAudio() envía [0x01][198 GSM], endTx() → [0x0d]
 */

import net from "net";
import { EventEmitter } from "events";

const HANDSHAKE_CLIENT = Buffer.from([0x0a, 0x82, 0x00, 0x00, 0x00]);
const AUDIO_PAYLOAD_SIZE = 198;
const SILENCE_INTERVAL_MS = 150;
const SOCKET_TIMEOUT_MS = 90_000;

// ─── Packet parser ────────────────────────────────────────────────────────────

class EqsoPacketParser {
  private acc = Buffer.alloc(0);

  feed(data: Buffer): void {
    this.acc = Buffer.concat([this.acc, data]);
  }

  next(): Buffer | null {
    while (this.acc.length > 0) {
      const cmd = this.acc[0];

      if (cmd === 0x0c) { const p = this.acc.slice(0, 1); this.acc = this.acc.slice(1); return p; }
      if (cmd === 0x08 || cmd === 0x09) { this.acc = this.acc.slice(1); continue; }
      if (cmd === 0x06) {
        if (this.acc.length < 2) return null;
        const nlen = this.acc[1];
        if (this.acc.length < 2 + nlen) return null;
        this.acc = this.acc.slice(2 + nlen); continue;
      }
      if (cmd === 0x0b) {
        if (this.acc.length < 2) return null;
        const tlen = this.acc[1];
        const total = 2 + tlen + 1;
        if (this.acc.length < total) return null;
        const p = this.acc.slice(0, total); this.acc = this.acc.slice(total); return p;
      }
      if (cmd === 0x0a) {
        if (this.acc.length < 5) return null;
        const p = this.acc.slice(0, 5); this.acc = this.acc.slice(5); return p;
      }
      if (cmd === 0x14) {
        if (this.acc.length < 5) return null;
        const count = this.acc[1]; let off = 5;
        for (let i = 0; i < count; i++) {
          if (off >= this.acc.length) return null;
          const nlen = this.acc[off++];
          if (off + nlen > this.acc.length) return null;
          off += nlen;
        }
        const p = this.acc.slice(0, off); this.acc = this.acc.slice(off); return p;
      }
      if (cmd === 0x16) {
        const r = this.parseUserUpdate();
        if (r === null) return null;
        if (r === false) continue;
        return r;
      }
      if (cmd === 0x01) {
        if (this.acc.length < 1 + AUDIO_PAYLOAD_SIZE) return null;
        const p = this.acc.slice(0, 1 + AUDIO_PAYLOAD_SIZE);
        this.acc = this.acc.slice(1 + AUDIO_PAYLOAD_SIZE); return p;
      }
      // unknown byte
      this.acc = this.acc.slice(1);
    }
    return null;
  }

  private parseUserUpdate(): Buffer | null | false {
    if (this.acc.length < 2) return null;
    const count = this.acc[1];
    if (count === 0) {
      if (this.acc.length < 4) return null;
      const p = this.acc.slice(0, 4); this.acc = this.acc.slice(4); return p;
    }
    if (count === 1) {
      if (this.acc.length < 10) return null;
      const action = this.acc[5];
      const nameLen = this.acc[9];
      let off = 10 + nameLen;
      if (this.acc.length < off) return null;
      if (action === 0x00) {
        if (this.acc.length < off + 1) return null;
        const msgLen = this.acc[off++];
        off += msgLen;
        if (this.acc.length < off + 1) return null;
        off++;
      }
      const p = this.acc.slice(0, off); this.acc = this.acc.slice(off); return p;
    }
    if (this.acc.length < 5) return null;
    let off = 5;
    for (let i = 0; i < count; i++) {
      if (this.acc.length < off + 5) return null;
      const action = this.acc[off]; off += 4;
      const nameLen = this.acc[off++];
      if (this.acc.length < off + nameLen) return null;
      off += nameLen;
      if (action === 0x00) {
        if (this.acc.length < off + 1) return null;
        const msgLen = this.acc[off++];
        if (this.acc.length < off + msgLen + 1) return null;
        off += msgLen + 1;
      }
    }
    const p = this.acc.slice(0, off); this.acc = this.acc.slice(off); return p;
  }
}

// ─── Tipos de eventos emitidos ────────────────────────────────────────────────

export interface EqsoEvent {
  type:
    | "connected"
    | "disconnected"
    | "error"
    | "room_list"
    | "server_msg"
    | "user_joined"
    | "user_left"
    | "ptt_started"
    | "ptt_released"
    | "audio"
    | "keepalive";
  data?: unknown;
}

// ─── Cliente principal ────────────────────────────────────────────────────────

export class EqsoClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private parser = new EqsoPacketParser();
  private handshakeDone = false;
  private silenceTimer: ReturnType<typeof setInterval> | null = null;
  private transmitting = false;
  public connected = false;

  constructor(
    private readonly host: string,
    private readonly port: number,
  ) {
    super();
  }

  connect(): void {
    const sock = new net.Socket();
    this.socket = sock;
    this.parser = new EqsoPacketParser();
    this.handshakeDone = false;
    this.transmitting = false;

    sock.connect(this.port, this.host, () => {
      this.connected = true;
      log(`TCP conectado a ${this.host}:${this.port}`);
      sock.write(HANDSHAKE_CLIENT);
    });

    sock.on("data", (data: Buffer) => {
      this.parser.feed(data);
      this.drainPackets();
    });

    sock.on("close", () => {
      this.connected = false;
      this.stopSilence();
      this.emit("event", { type: "disconnected" } satisfies EqsoEvent);
      log(`TCP desconectado de ${this.host}:${this.port}`);
    });

    sock.on("error", (err: Error) => {
      this.connected = false;
      this.stopSilence();
      this.emit("event", { type: "error", data: err.message } satisfies EqsoEvent);
      log(`TCP error: ${err.message}`);
    });

    sock.setTimeout(SOCKET_TIMEOUT_MS);
    sock.on("timeout", () => {
      log("TCP timeout — destruyendo socket");
      sock.destroy();
    });
  }

  disconnect(): void {
    this.stopSilence();
    this.socket?.destroy();
    this.socket = null;
    this.connected = false;
  }

  sendJoin(name: string, room: string, message: string, password: string): void {
    const nb = buf(name.slice(0, 20));
    const rb = buf(room.slice(0, 20));
    const mb = buf(message.slice(0, 100));
    const pb = buf(password.slice(0, 50));
    const pkt = Buffer.concat([
      Buffer.from([0x1a]),
      Buffer.from([nb.length]), nb,
      Buffer.from([rb.length]), rb,
      Buffer.from([mb.length]), mb,
      Buffer.from([pb.length]), pb,
      Buffer.from([0x00]),
    ]);
    this.write(pkt);
    log(`JOIN enviado: callsign="${name}" sala="${room}"`);
  }

  /** Pausa el silence heartbeat para que podamos transmitir. */
  startTx(): void {
    this.transmitting = true;
  }

  /** Envía un paquete GSM de 198 bytes al servidor. */
  sendAudio(gsm: Buffer): void {
    if (gsm.length < AUDIO_PAYLOAD_SIZE) {
      const padded = Buffer.alloc(AUDIO_PAYLOAD_SIZE);
      gsm.copy(padded);
      gsm = padded;
    }
    const pkt = Buffer.concat([Buffer.from([0x01]), gsm.slice(0, AUDIO_PAYLOAD_SIZE)]);
    this.write(pkt);
  }

  /** Termina la transmision y reanuda el silence heartbeat. */
  endTx(): void {
    this.transmitting = false;
    this.write(Buffer.from([0x0d]));
    log("PTT liberado [0x0d]");
  }

  // ── Privado ────────────────────────────────────────────────────────────────

  private startSilence(): void {
    if (this.silenceTimer) return;
    this.silenceTimer = setInterval(() => {
      if (!this.transmitting) this.write(Buffer.from([0x02]));
    }, SILENCE_INTERVAL_MS);
  }

  private stopSilence(): void {
    if (this.silenceTimer) { clearInterval(this.silenceTimer); this.silenceTimer = null; }
  }

  private write(data: Buffer): void {
    if (this.socket && !this.socket.destroyed && this.connected) {
      try { this.socket.write(data); } catch { /* ignore */ }
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
      case 0x0a: {
        if (!this.handshakeDone) {
          this.handshakeDone = true;
          log("Handshake recibido — conexion establecida");
          this.emit("event", { type: "connected" } satisfies EqsoEvent);
          this.startSilence();
        }
        break;
      }
      case 0x0c: {
        this.write(Buffer.from([0x0c]));
        this.emit("event", { type: "keepalive" } satisfies EqsoEvent);
        break;
      }
      case 0x0b: {
        if (pkt.length >= 2) {
          const text = pkt.slice(2, 2 + pkt[1]).toString("ascii");
          log(`Mensaje del servidor: ${text}`);
          this.emit("event", { type: "server_msg", data: text } satisfies EqsoEvent);
        }
        break;
      }
      case 0x14: {
        const count = pkt[1];
        const rooms: string[] = [];
        let off = 5;
        for (let i = 0; i < count; i++) {
          if (off >= pkt.length) break;
          const len = pkt[off++];
          rooms.push(pkt.slice(off, off + len).toString("ascii"));
          off += len;
        }
        log(`Salas disponibles: ${rooms.join(", ")}`);
        this.emit("event", { type: "room_list", data: rooms } satisfies EqsoEvent);
        break;
      }
      case 0x16:
        this.handleUserUpdate(pkt);
        break;
      case 0x01:
        this.emit("event", { type: "audio", data: pkt } satisfies EqsoEvent);
        break;
      default:
        break;
    }
  }

  private handleUserUpdate(pkt: Buffer): void {
    if (pkt.length < 5) return;
    const count = pkt[1];
    if (count === 0) return;

    if (count === 1) {
      const action = pkt[5];
      let off = 9;
      if (off >= pkt.length) return;
      const nameLen = pkt[off++];
      if (off + nameLen > pkt.length) return;
      const name = pkt.slice(off, off + nameLen).toString("ascii");
      off += nameLen;
      switch (action) {
        case 0x00: {
          const msgLen = off < pkt.length ? pkt[off++] : 0;
          const msg = pkt.slice(off, off + msgLen).toString("ascii");
          this.emit("event", { type: "user_joined", data: { name, message: msg } } satisfies EqsoEvent);
          break;
        }
        case 0x01: this.emit("event", { type: "user_left",    data: { name } } satisfies EqsoEvent); break;
        case 0x02: this.emit("event", { type: "ptt_started",  data: { name } } satisfies EqsoEvent); break;
        case 0x03: this.emit("event", { type: "ptt_released", data: { name } } satisfies EqsoEvent); break;
      }
      return;
    }

    let off = 5;
    for (let i = 0; i < count; i++) {
      if (off + 5 > pkt.length) break;
      const action = pkt[off]; off += 4;
      const nameLen = pkt[off++];
      if (off + nameLen > pkt.length) break;
      const name = pkt.slice(off, off + nameLen).toString("ascii");
      off += nameLen;
      switch (action) {
        case 0x00: {
          const msgLen = off < pkt.length ? pkt[off++] : 0;
          const msg = pkt.slice(off, off + msgLen).toString("ascii");
          off += msgLen;
          if (off < pkt.length) off++;
          this.emit("event", { type: "user_joined", data: { name, message: msg } } satisfies EqsoEvent);
          break;
        }
        case 0x01: this.emit("event", { type: "user_left",    data: { name } } satisfies EqsoEvent); break;
        case 0x02: this.emit("event", { type: "ptt_started",  data: { name } } satisfies EqsoEvent); break;
        case 0x03: this.emit("event", { type: "ptt_released", data: { name } } satisfies EqsoEvent); break;
      }
    }
  }
}

function buf(s: string): Buffer { return Buffer.from(s, "ascii"); }
function log(msg: string): void { console.log(`[eqso] ${new Date().toISOString()} ${msg}`); }
