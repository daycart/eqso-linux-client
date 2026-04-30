/**
 * eQSO TCP client — implementacion completa del protocolo eQSO 2.x
 * Compatible con el servidor eQSO de Windows (puerto 2171).
 *
 * Flujo:
 *  1. connect() → TCP socket → HANDSHAKE_CLIENT [0x0a 0x82 0x00 0x00 0x00]
 *  2. Server responde [0x0a 0xfa …] → emitimos "connected"
 *  3. sendJoin() → empezamos a recibir USER_UPDATE y AUDIO
 *  4. KEEPALIVE [0x0c] lo contestamos con [0x0c] — mantiene la sesion viva
 *  5. TX: startTx() [0x09], sendAudio() [0x01][33 GSM], endTx() [0x0d]
 *
 * NOTA: NO enviamos [0x02] (silence frame). El servidor externo 193.152.83.229
 * lo interpreta como comando JOIN, respondiendo con "Salas disponibles" y
 * luego parseando los bytes GSM del audio como callsign → "Indicativo invalido".
 * La sesion se mantiene viva mediante: respuesta [0x0c] a los keepalives del
 * servidor + reconexion automatica por idle en main.ts (IDLE_RECONNECT_MS).
 */

import net from "net";
import { EventEmitter } from "events";

const HANDSHAKE_CLIENT = Buffer.from([0x0a, 0x82, 0x00, 0x00, 0x00]);
const AUDIO_PAYLOAD_SIZE = 33;
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
      // 0x08 = servidor señala "canal ocupado / PTT denegado" → emitir como paquete
      if (cmd === 0x08) { const p = this.acc.slice(0, 1); this.acc = this.acc.slice(1); return p; }
      if (cmd === 0x09) { this.acc = this.acc.slice(1); continue; }
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
        // Validar que el texto sea ASCII imprimible (0x20-0x7e).
        // Si contiene bytes binarios es un falso-0x0b causado por desalineación del
        // parser (bytes de payload GSM siendo interpretados como comandos).  En ese
        // caso descartamos solo el byte 0x0b y continuamos el re-sincronizado.
        const isAscii = this.acc.slice(2, 2 + tlen).every(b => b >= 0x20 && b <= 0x7e);
        if (!isAscii) { this.acc = this.acc.slice(1); continue; }
        const p = this.acc.slice(0, total); this.acc = this.acc.slice(total); return p;
      }
      if (cmd === 0x0a) {
        if (this.acc.length < 5) return null;
        const p = this.acc.slice(0, 5); this.acc = this.acc.slice(5); return p;
      }
      if (cmd === 0x14) {
        // Sanity: un servidor eQSO tipico tiene <20 salas con nombres ASCII <30b.
        // Si count o nlen son grandes, el parser se desincrono (bytes de audio GSM
        // interpretados como 0x14) → descartar solo el byte 0x14 para re-sincronizar.
        if (this.acc.length < 5) return null;
        const count = this.acc[1];
        if (count > 32) { this.acc = this.acc.slice(1); continue; } // garbled
        let off = 5; let garbled = false;
        for (let i = 0; i < count; i++) {
          if (off >= this.acc.length) return null;
          const nlen = this.acc[off++];
          if (nlen > 50) { garbled = true; break; }
          if (off + nlen > this.acc.length) return null;
          // Verificar que el nombre sea ASCII imprimible
          for (let j = 0; j < nlen; j++) {
            if (this.acc[off + j] < 0x20 || this.acc[off + j] > 0x7e) { garbled = true; break; }
          }
          if (garbled) break;
          off += nlen;
        }
        if (garbled) { this.acc = this.acc.slice(1); continue; } // re-sync
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
    // Safety: counts larger than a realistic room size indicate a corrupt/unknown packet.
    // Skip the leading 0x16 byte rather than waiting forever for data that won't come.
    if (count > 50) { this.acc = this.acc.slice(1); return false; }
    if (this.acc.length < 5) return null;
    // Per-entry format from api-server (protocol.ts buildUserList):
    //   [action:1][pad×3][nameLen:1][name:N][msgLen:1][msg:M][term:1]  (action=0x00 join/idle)
    //   [action:1][pad×3][nameLen:1][name:N]                           (action=0x01/02/03)
    let off = 5;
    for (let i = 0; i < count; i++) {
      if (this.acc.length < off + 5) return null; // action(1)+pad(3)+nameLen(1)
      const action = this.acc[off];
      off += 4; // skip action + 3 padding bytes
      const nameLen = this.acc[off++];
      if (this.acc.length < off + nameLen) return null;
      off += nameLen;
      if (action === 0x00) {
        if (this.acc.length < off + 1) return null;
        const msgLen = this.acc[off++];
        if (this.acc.length < off + msgLen + 1) return null;
        off += msgLen + 1; // msg + terminator
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
    | "keepalive"
    | "channel_busy";
  data?: unknown;
}

// ─── Cliente principal ────────────────────────────────────────────────────────

export class EqsoClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private parser = new EqsoPacketParser();
  private handshakeDone = false;
  private transmitting = false;
  public connected = false;
  // joinAccepted=true when the server confirms JOIN (room_list received).
  // PTT [0x09] must NOT be sent before JOIN is accepted — the server will reject
  // with "Indicativo invalido" and close the connection.
  public joinAccepted = false;
  private txingStations = new Set<string>();
  // Debug raw TX/RX bytes — log first N events after PTT to trace server behavior
  private txDbgCount = 0;
  private readonly TX_DBG_MAX = 8;

  /** Returns true only when the connection is fully ready for TX (handshake done + JOIN accepted). */
  isReady(): boolean {
    return this.connected && this.handshakeDone && this.joinAccepted;
  }

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
    this.joinAccepted = false;
    this.transmitting = false;
    let hadError = false;

    sock.connect(this.port, this.host, () => {
      this.connected = true;
      log(`TCP conectado a ${this.host}:${this.port}`);
      sock.write(HANDSHAKE_CLIENT);
    });

    sock.on("data", (data: Buffer) => {
      if (this.transmitting && this.txDbgCount < this.TX_DBG_MAX) {
        this.txDbgCount++;
        log(`[raw-rx #${this.txDbgCount}] ${data.length}b: ${data.slice(0, 48).toString("hex")}`);
      }
      this.parser.feed(data);
      this.drainPackets();
    });

    sock.on("close", (hadHalfOpen?: boolean) => {
      this.connected = false;
      this.handshakeDone = false;
      this.joinAccepted = false;
      this.stopSilence();
      const reason = hadError ? "tras error TCP" : "cierre limpio del servidor (FIN)";
      log(`TCP desconectado de ${this.host}:${this.port} — ${reason}`);
      this.emit("event", { type: "disconnected" } satisfies EqsoEvent);
    });

    sock.on("error", (err: Error) => {
      hadError = true;
      this.connected = false;
      this.handshakeDone = false;
      this.joinAccepted = false;
      this.stopSilence();
      log(`TCP error: ${err.message} (${err.name})`);
      this.emit("event", { type: "error", data: err.message } satisfies EqsoEvent);
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

  /** Anuncia PTT al servidor [0x09] y detiene el silence heartbeat síncronamente. */
  startTx(): void {
    // Guard: require full JOIN acceptance before sending [0x09].
    // Sending [0x09] before JOIN causes "Indicativo invalido" + disconnect.
    if (!this.isReady()) {
      log("startTx() ignorado — joinAccepted=false (handshake o JOIN pendiente)");
      return;
    }
    this.stopSilence();        // Detener timer ANTES del PTT para evitar race [0x02][0x09]
    this.transmitting = true;
    this.txDbgCount = 0;       // Reset debug counter para nueva sesion TX
    this.write(Buffer.from([0x09]));
    log("PTT anunciado [0x09]");
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
    this.startSilence();        // Reiniciar heartbeat tras fin de TX
    log("PTT liberado [0x0d]");
  }

  /** Renueva la sesion durante TX: JOIN + PTT sin interrumpir el pipeline de audio.
   *  El servidor 193.152.83.229 tiene un timer de sesion que expira cada ~4-9s.
   *  Cuando expira, el servidor busca 0x1a en el stream de audio GSM y parsea
   *  los bytes siguientes como callsign/sala → "Indicativo/Nombre invalido" → FIN.
   *  Solución: re-enviar JOIN (0x1a) + PTT (0x09) de forma proactiva cada 2.5s.
   *  No llama startTx() para no resetear txDbgCount ni emitir logs redundantes.
   */
  renewTxSession(name: string, room: string, message: string, password: string): void {
    if (!this.connected || !this.transmitting) return;
    this.sendJoin(name, room, message, password);
    this.write(Buffer.from([0x09]));
    log("[session] Sesion TX renovada [0x1a JOIN + 0x09 PTT]");
  }

  // ── Privado ────────────────────────────────────────────────────────────────

  // No enviamos [0x02] — ver nota en el encabezado del modulo.
  private startSilence(): void { /* no-op */ }
  private stopSilence(): void { /* no-op */ }

  private write(data: Buffer): void {
    if (this.socket && !this.socket.destroyed && this.connected) {
      if (this.transmitting && this.txDbgCount === 0) {
        // Log first outgoing packet right after PTT [0x09]
        log(`[raw-tx ptt] ${data.length}b: ${data.toString("hex")}`);
      }
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
      case 0x08: {
        // Canal ocupado / PTT denegado — servidor rechaza nuestra transmisión
        // porque otro usuario ya tiene el canal.
        log("[0x08] Canal ocupado — ceder TX al otro usuario");
        this.emit("event", { type: "channel_busy" } satisfies EqsoEvent);
        break;
      }
      case 0x0b: {
        if (pkt.length >= 2) {
          const text = sanitize(pkt.slice(2, 2 + pkt[1]).toString("ascii"));
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
          const name = sanitize(pkt.slice(off, off + len).toString("ascii"));
          if (name) rooms.push(name);
          off += len;
        }
        const preview = rooms.slice(0, 5).join(", ") + (rooms.length > 5 ? ` … (+${rooms.length - 5} mas)` : "");
        log(`Salas disponibles: ${rooms.length} salas [${preview}]`);
        // JOIN accepted — server confirmed our callsign. PTT [0x09] is now safe to send.
        this.joinAccepted = true;
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
      const name = sanitize(pkt.slice(off, off + nameLen).toString("ascii"));
      off += nameLen;
      switch (action) {
        case 0x00: {
          const msgLen = off < pkt.length ? pkt[off++] : 0;
          const msg = sanitize(pkt.slice(off, off + msgLen).toString("ascii"));
          // action=0x00 tras TX = PTT release (protocolo eQSO original usa idle/join para señalar fin de TX)
          if (this.txingStations.has(name)) {
            this.txingStations.delete(name);
            this.emit("event", { type: "ptt_released", data: { name } } satisfies EqsoEvent);
          } else {
            this.emit("event", { type: "user_joined", data: { name, message: msg } } satisfies EqsoEvent);
          }
          break;
        }
        case 0x01:
          this.txingStations.delete(name);
          this.emit("event", { type: "user_left",    data: { name } } satisfies EqsoEvent);
          break;
        case 0x02:
          // Deduplicate: only emit ptt_started the FIRST time a station enters TX.
          // The external eQSO server sends action=0x02 keepalives every ~250ms while
          // someone is TX'ing — without this guard we'd emit (and log) a ptt_started
          // hundreds of times per TX session.
          if (!this.txingStations.has(name)) {
            this.txingStations.add(name);
            this.emit("event", { type: "ptt_started",  data: { name } } satisfies EqsoEvent);
          }
          break;
        case 0x03:
          this.txingStations.delete(name);
          this.emit("event", { type: "ptt_released", data: { name } } satisfies EqsoEvent);
          break;
      }
      return;
    }

    // Per-entry format: [action:1][pad×3][nameLen:1][name:N] + [msgLen][msg][term] if action=0x00
    let off = 5;
    for (let i = 0; i < count; i++) {
      if (off + 5 > pkt.length) break;
      const action = pkt[off];
      off += 4; // skip action + 3 padding bytes
      const nameLen = pkt[off++];
      if (off + nameLen > pkt.length) break;
      const name = sanitize(pkt.slice(off, off + nameLen).toString("ascii"));
      off += nameLen;
      switch (action) {
        case 0x00: {
          const msgLen = off < pkt.length ? pkt[off++] : 0;
          const msg = sanitize(pkt.slice(off, off + msgLen).toString("ascii"));
          off += msgLen;
          if (off < pkt.length) off++; // terminator
          if (this.txingStations.has(name)) {
            this.txingStations.delete(name);
            this.emit("event", { type: "ptt_released", data: { name } } satisfies EqsoEvent);
          } else {
            this.emit("event", { type: "user_joined", data: { name, message: msg } } satisfies EqsoEvent);
          }
          break;
        }
        case 0x01:
          this.txingStations.delete(name);
          this.emit("event", { type: "user_left",    data: { name } } satisfies EqsoEvent);
          break;
        case 0x02:
          // Deduplicate: only emit ptt_started the FIRST time (same rationale as count=1 above).
          if (!this.txingStations.has(name)) {
            this.txingStations.add(name);
            this.emit("event", { type: "ptt_started",  data: { name } } satisfies EqsoEvent);
          }
          break;
        case 0x03:
          this.txingStations.delete(name);
          this.emit("event", { type: "ptt_released", data: { name } } satisfies EqsoEvent);
          break;
      }
    }
  }
}

function buf(s: string): Buffer { return Buffer.from(s, "ascii"); }
function log(msg: string): void { console.log(`[eqso] ${new Date().toISOString()} ${msg}`); }
/** Strip control chars (incl. null terminators) so journald never sees binary output */
function sanitize(s: string): string { return s.replace(/[\x00-\x1f\x7f]/g, ""); }
