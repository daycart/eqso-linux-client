import { createRequire } from 'module'; const require = createRequire(import.meta.url);

// src/config.ts
import fs from "fs";
var DEFAULTS = {
  callsign: "0R-IN70WN",
  room: "CB",
  password: "",
  message: "Radio Enlace",
  server: "193.152.83.229",
  port: 2172,
  reconnectMinMs: 2e3,
  reconnectMaxMs: 6e4,
  audio: {
    captureDevice: "plughw:1,0",
    playbackDevice: "plughw:1,0",
    vox: true,
    voxThresholdRms: 600,
    voxHangMs: 2500,
    txGateRms: 50,
    voxDebounceChunks: 1,
    startupVoxSuppressMs: 4e3,
    inputGain: 1,
    outputGain: 3
  },
  control: {
    enabled: true,
    port: 8009,
    host: "127.0.0.1"
  },
  ptt: {
    device: "/dev/ttyACM0",
    method: "rts",
    inverted: false
  }
};
function deepMerge(base, override) {
  const result = { ...base };
  for (const key of Object.keys(override)) {
    const val = override[key];
    const baseVal = base[key];
    if (val !== null && typeof val === "object" && !Array.isArray(val) && baseVal !== null && typeof baseVal === "object") {
      result[key] = deepMerge(baseVal, val);
    } else if (val !== void 0) {
      result[key] = val;
    }
  }
  return result;
}
function loadConfig() {
  const instance = process.env["RELAY_INSTANCE"] || "CB";
  const configFile = process.env["CONFIG_FILE"] ?? `/etc/eqso-relay/${instance}.json`;
  let fromFile = {};
  if (fs.existsSync(configFile)) {
    try {
      fromFile = JSON.parse(fs.readFileSync(configFile, "utf8"));
      console.log(`[config] Cargado: ${configFile}`);
    } catch (err) {
      console.error(`[config] Error al leer ${configFile}:`, err);
    }
  } else {
    console.warn(`[config] Archivo no encontrado: ${configFile} \u2014 usando valores por defecto`);
  }
  const merged = deepMerge(DEFAULTS, fromFile);
  if (process.env["RELAY_CALLSIGN"]) merged.callsign = process.env["RELAY_CALLSIGN"];
  if (process.env["RELAY_ROOM"]) merged.room = process.env["RELAY_ROOM"];
  if (process.env["RELAY_PASSWORD"]) merged.password = process.env["RELAY_PASSWORD"];
  if (process.env["RELAY_SERVER"]) merged.server = process.env["RELAY_SERVER"];
  if (process.env["RELAY_PORT"]) merged.port = parseInt(process.env["RELAY_PORT"], 10);
  if (process.env["CONTROL_PORT"]) merged.control.port = parseInt(process.env["CONTROL_PORT"], 10);
  console.log("[config] Configuracion activa:", JSON.stringify(merged, null, 2));
  return merged;
}

// src/eqso-client.ts
import net from "net";
import { EventEmitter } from "events";
var HANDSHAKE_CLIENT = Buffer.from([10, 130, 0, 0, 0]);
var AUDIO_PAYLOAD_SIZE = 33;
var SOCKET_TIMEOUT_MS = 9e4;
var EqsoPacketParser = class {
  acc = Buffer.alloc(0);
  feed(data) {
    this.acc = Buffer.concat([this.acc, data]);
  }
  next() {
    while (this.acc.length > 0) {
      const cmd = this.acc[0];
      if (cmd === 12) {
        const p = this.acc.slice(0, 1);
        this.acc = this.acc.slice(1);
        return p;
      }
      if (cmd === 8 || cmd === 9) {
        this.acc = this.acc.slice(1);
        continue;
      }
      if (cmd === 6) {
        if (this.acc.length < 2) return null;
        const nlen = this.acc[1];
        if (this.acc.length < 2 + nlen) return null;
        this.acc = this.acc.slice(2 + nlen);
        continue;
      }
      if (cmd === 11) {
        if (this.acc.length < 2) return null;
        const tlen = this.acc[1];
        const total = 2 + tlen + 1;
        if (this.acc.length < total) return null;
        const isAscii = this.acc.slice(2, 2 + tlen).every((b) => b >= 32 && b <= 126);
        if (!isAscii) {
          this.acc = this.acc.slice(1);
          continue;
        }
        const p = this.acc.slice(0, total);
        this.acc = this.acc.slice(total);
        return p;
      }
      if (cmd === 10) {
        if (this.acc.length < 5) return null;
        const p = this.acc.slice(0, 5);
        this.acc = this.acc.slice(5);
        return p;
      }
      if (cmd === 20) {
        if (this.acc.length < 5) return null;
        const count = this.acc[1];
        let off = 5;
        for (let i = 0; i < count; i++) {
          if (off >= this.acc.length) return null;
          const nlen = this.acc[off++];
          if (off + nlen > this.acc.length) return null;
          off += nlen;
        }
        const p = this.acc.slice(0, off);
        this.acc = this.acc.slice(off);
        return p;
      }
      if (cmd === 22) {
        const r = this.parseUserUpdate();
        if (r === null) return null;
        if (r === false) continue;
        return r;
      }
      if (cmd === 1) {
        if (this.acc.length < 1 + AUDIO_PAYLOAD_SIZE) return null;
        const p = this.acc.slice(0, 1 + AUDIO_PAYLOAD_SIZE);
        this.acc = this.acc.slice(1 + AUDIO_PAYLOAD_SIZE);
        return p;
      }
      this.acc = this.acc.slice(1);
    }
    return null;
  }
  parseUserUpdate() {
    if (this.acc.length < 2) return null;
    const count = this.acc[1];
    if (count === 0) {
      if (this.acc.length < 4) return null;
      const p2 = this.acc.slice(0, 4);
      this.acc = this.acc.slice(4);
      return p2;
    }
    if (count === 1) {
      if (this.acc.length < 10) return null;
      const action = this.acc[5];
      const nameLen = this.acc[9];
      let off2 = 10 + nameLen;
      if (this.acc.length < off2) return null;
      if (action === 0) {
        if (this.acc.length < off2 + 1) return null;
        const msgLen = this.acc[off2++];
        off2 += msgLen;
        if (this.acc.length < off2 + 1) return null;
        off2++;
      }
      const p2 = this.acc.slice(0, off2);
      this.acc = this.acc.slice(off2);
      return p2;
    }
    if (count > 50) {
      this.acc = this.acc.slice(1);
      return false;
    }
    if (this.acc.length < 5) return null;
    let off = 5;
    for (let i = 0; i < count; i++) {
      if (this.acc.length < off + 5) return null;
      const action = this.acc[off];
      off += 4;
      const nameLen = this.acc[off++];
      if (this.acc.length < off + nameLen) return null;
      off += nameLen;
      if (action === 0) {
        if (this.acc.length < off + 1) return null;
        const msgLen = this.acc[off++];
        if (this.acc.length < off + msgLen + 1) return null;
        off += msgLen + 1;
      }
    }
    const p = this.acc.slice(0, off);
    this.acc = this.acc.slice(off);
    return p;
  }
};
var EqsoClient = class extends EventEmitter {
  constructor(host, port) {
    super();
    this.host = host;
    this.port = port;
  }
  socket = null;
  parser = new EqsoPacketParser();
  handshakeDone = false;
  transmitting = false;
  connected = false;
  txingStations = /* @__PURE__ */ new Set();
  connect() {
    const sock = new net.Socket();
    this.socket = sock;
    this.parser = new EqsoPacketParser();
    this.handshakeDone = false;
    this.transmitting = false;
    let hadError = false;
    sock.connect(this.port, this.host, () => {
      this.connected = true;
      log(`TCP conectado a ${this.host}:${this.port}`);
      sock.write(HANDSHAKE_CLIENT);
    });
    sock.on("data", (data) => {
      this.parser.feed(data);
      this.drainPackets();
    });
    sock.on("close", (hadHalfOpen) => {
      this.connected = false;
      this.stopSilence();
      const reason = hadError ? "tras error TCP" : "cierre limpio del servidor (FIN)";
      log(`TCP desconectado de ${this.host}:${this.port} \u2014 ${reason}`);
      this.emit("event", { type: "disconnected" });
    });
    sock.on("error", (err) => {
      hadError = true;
      this.connected = false;
      this.stopSilence();
      log(`TCP error: ${err.message} (${err.name})`);
      this.emit("event", { type: "error", data: err.message });
    });
    sock.setTimeout(SOCKET_TIMEOUT_MS);
    sock.on("timeout", () => {
      log("TCP timeout \u2014 destruyendo socket");
      sock.destroy();
    });
  }
  disconnect() {
    this.stopSilence();
    this.socket?.destroy();
    this.socket = null;
    this.connected = false;
  }
  sendJoin(name, room, message, password) {
    const nb = buf(name.slice(0, 20));
    const rb = buf(room.slice(0, 20));
    const mb = buf(message.slice(0, 100));
    const pb = buf(password.slice(0, 50));
    const pkt = Buffer.concat([
      Buffer.from([26]),
      Buffer.from([nb.length]),
      nb,
      Buffer.from([rb.length]),
      rb,
      Buffer.from([mb.length]),
      mb,
      Buffer.from([pb.length]),
      pb,
      Buffer.from([0])
    ]);
    this.write(pkt);
    log(`JOIN enviado: callsign="${name}" sala="${room}"`);
  }
  /** Anuncia PTT al servidor [0x09] y detiene el silence heartbeat síncronamente. */
  startTx() {
    this.stopSilence();
    this.transmitting = true;
    this.write(Buffer.from([9]));
    log("PTT anunciado [0x09]");
  }
  /** Envía un paquete GSM de 198 bytes al servidor. */
  sendAudio(gsm) {
    if (gsm.length < AUDIO_PAYLOAD_SIZE) {
      const padded = Buffer.alloc(AUDIO_PAYLOAD_SIZE);
      gsm.copy(padded);
      gsm = padded;
    }
    const pkt = Buffer.concat([Buffer.from([1]), gsm.slice(0, AUDIO_PAYLOAD_SIZE)]);
    this.write(pkt);
  }
  /** Termina la transmision y reanuda el silence heartbeat. */
  endTx() {
    this.transmitting = false;
    this.write(Buffer.from([13]));
    this.startSilence();
    log("PTT liberado [0x0d]");
  }
  // ── Privado ────────────────────────────────────────────────────────────────
  // No enviamos [0x02] — ver nota en el encabezado del modulo.
  startSilence() {
  }
  stopSilence() {
  }
  write(data) {
    if (this.socket && !this.socket.destroyed && this.connected) {
      try {
        this.socket.write(data);
      } catch {
      }
    }
  }
  drainPackets() {
    let pkt;
    while ((pkt = this.parser.next()) !== null) {
      this.handlePacket(pkt);
    }
  }
  handlePacket(pkt) {
    if (pkt.length === 0) return;
    const cmd = pkt[0];
    switch (cmd) {
      case 10: {
        if (!this.handshakeDone) {
          this.handshakeDone = true;
          log("Handshake recibido \u2014 conexion establecida");
          this.emit("event", { type: "connected" });
          this.startSilence();
        }
        break;
      }
      case 12: {
        this.write(Buffer.from([12]));
        this.emit("event", { type: "keepalive" });
        break;
      }
      case 11: {
        if (pkt.length >= 2) {
          const text = sanitize(pkt.slice(2, 2 + pkt[1]).toString("ascii"));
          log(`Mensaje del servidor: ${text}`);
          this.emit("event", { type: "server_msg", data: text });
        }
        break;
      }
      case 20: {
        const count = pkt[1];
        const rooms = [];
        let off = 5;
        for (let i = 0; i < count; i++) {
          if (off >= pkt.length) break;
          const len = pkt[off++];
          const name = sanitize(pkt.slice(off, off + len).toString("ascii"));
          if (name) rooms.push(name);
          off += len;
        }
        const preview = rooms.slice(0, 5).join(", ") + (rooms.length > 5 ? ` \u2026 (+${rooms.length - 5} mas)` : "");
        log(`Salas disponibles: ${rooms.length} salas [${preview}]`);
        this.emit("event", { type: "room_list", data: rooms });
        break;
      }
      case 22:
        this.handleUserUpdate(pkt);
        break;
      case 1:
        this.emit("event", { type: "audio", data: pkt });
        break;
      default:
        break;
    }
  }
  handleUserUpdate(pkt) {
    if (pkt.length < 5) return;
    const count = pkt[1];
    if (count === 0) return;
    if (count === 1) {
      const action = pkt[5];
      let off2 = 9;
      if (off2 >= pkt.length) return;
      const nameLen = pkt[off2++];
      if (off2 + nameLen > pkt.length) return;
      const name = sanitize(pkt.slice(off2, off2 + nameLen).toString("ascii"));
      off2 += nameLen;
      switch (action) {
        case 0: {
          const msgLen = off2 < pkt.length ? pkt[off2++] : 0;
          const msg = sanitize(pkt.slice(off2, off2 + msgLen).toString("ascii"));
          if (this.txingStations.has(name)) {
            this.txingStations.delete(name);
            this.emit("event", { type: "ptt_released", data: { name } });
          } else {
            this.emit("event", { type: "user_joined", data: { name, message: msg } });
          }
          break;
        }
        case 1:
          this.txingStations.delete(name);
          this.emit("event", { type: "user_left", data: { name } });
          break;
        case 2:
          if (!this.txingStations.has(name)) {
            this.txingStations.add(name);
            this.emit("event", { type: "ptt_started", data: { name } });
          }
          break;
        case 3:
          this.txingStations.delete(name);
          this.emit("event", { type: "ptt_released", data: { name } });
          break;
      }
      return;
    }
    let off = 5;
    for (let i = 0; i < count; i++) {
      if (off + 5 > pkt.length) break;
      const action = pkt[off];
      off += 4;
      const nameLen = pkt[off++];
      if (off + nameLen > pkt.length) break;
      const name = sanitize(pkt.slice(off, off + nameLen).toString("ascii"));
      off += nameLen;
      switch (action) {
        case 0: {
          const msgLen = off < pkt.length ? pkt[off++] : 0;
          const msg = sanitize(pkt.slice(off, off + msgLen).toString("ascii"));
          off += msgLen;
          if (off < pkt.length) off++;
          if (this.txingStations.has(name)) {
            this.txingStations.delete(name);
            this.emit("event", { type: "ptt_released", data: { name } });
          } else {
            this.emit("event", { type: "user_joined", data: { name, message: msg } });
          }
          break;
        }
        case 1:
          this.txingStations.delete(name);
          this.emit("event", { type: "user_left", data: { name } });
          break;
        case 2:
          if (!this.txingStations.has(name)) {
            this.txingStations.add(name);
            this.emit("event", { type: "ptt_started", data: { name } });
          }
          break;
        case 3:
          this.txingStations.delete(name);
          this.emit("event", { type: "ptt_released", data: { name } });
          break;
      }
    }
  }
};
function buf(s) {
  return Buffer.from(s, "ascii");
}
function log(msg) {
  console.log(`[eqso] ${(/* @__PURE__ */ new Date()).toISOString()} ${msg}`);
}
function sanitize(s) {
  return s.replace(/[\x00-\x1f\x7f]/g, "");
}

// src/alsa-audio.ts
import { spawn as spawn2, spawnSync } from "child_process";
import { EventEmitter as EventEmitter3 } from "events";

// src/gsm-codec.ts
import { spawn } from "child_process";
import { EventEmitter as EventEmitter2 } from "events";
var GSM_FRAME_BYTES = 33;
var GSM_FRAME_SAMPLES = 160;
var FRAMES_PER_PACKET = 1;
var GSM_PACKET_BYTES = GSM_FRAME_BYTES * FRAMES_PER_PACKET;
var PCM_PACKET_BYTES = GSM_FRAME_SAMPLES * FRAMES_PER_PACKET * 2;
var GsmDecoder = class extends EventEmitter2 {
  proc = null;
  accum = Buffer.alloc(0);
  ready = false;
  start() {
    if (this.proc) return;
    this.proc = spawn("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "quiet",
      "-probesize",
      "32",
      "-analyzeduration",
      "0",
      "-f",
      "gsm",
      "-ar",
      "8000",
      "-i",
      "pipe:0",
      "-f",
      "s16le",
      "-ar",
      "8000",
      "-fflags",
      "+flush_packets",
      "pipe:1"
    ], { stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stderr.on("data", () => {
    });
    this.proc.on("error", (err) => {
      console.error(`[gsm-dec] ffmpeg error: ${err.message}`);
    });
    this.proc.on("close", () => {
      this.proc = null;
      this.ready = false;
    });
    this.proc.stdout.on("data", (chunk) => {
      this.accum = Buffer.concat([this.accum, chunk]);
      while (this.accum.length >= PCM_PACKET_BYTES) {
        const pcmBuf = this.accum.slice(0, PCM_PACKET_BYTES);
        this.accum = this.accum.slice(PCM_PACKET_BYTES);
        const pcm = new Int16Array(
          pcmBuf.buffer.slice(pcmBuf.byteOffset, pcmBuf.byteOffset + PCM_PACKET_BYTES)
        );
        this.emit("pcm", pcm);
      }
    });
    setTimeout(() => {
      this.ready = true;
    }, 500);
  }
  decode(gsm) {
    if (!this.proc || !this.ready) return;
    if (gsm.length < GSM_PACKET_BYTES) return;
    try {
      this.proc.stdin.write(gsm.slice(0, GSM_PACKET_BYTES));
    } catch {
    }
  }
  stop() {
    try {
      this.proc?.stdin.end();
      this.proc?.kill("SIGTERM");
    } catch {
    }
    this.proc = null;
    this.ready = false;
    this.accum = Buffer.alloc(0);
  }
};
var GsmEncoder = class extends EventEmitter2 {
  proc = null;
  accum = Buffer.alloc(0);
  ready = false;
  lastGsmMs = 0;
  start() {
    if (this.proc) return;
    this.proc = spawn("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "quiet",
      "-probesize",
      "32",
      "-analyzeduration",
      "0",
      "-avioflags",
      "direct",
      "-f",
      "s16le",
      "-ar",
      "8000",
      "-ac",
      "1",
      "-i",
      "pipe:0",
      "-f",
      "gsm",
      "-ar",
      "8000",
      "-fflags",
      "+flush_packets",
      "pipe:1"
    ], { stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stderr.on("data", () => {
    });
    this.proc.on("error", (err) => {
      console.error(`[gsm-enc] ffmpeg error: ${err.message}`);
    });
    this.proc.on("close", () => {
      this.proc = null;
      this.ready = false;
    });
    this.proc.stdout.on("data", (chunk) => {
      this.accum = Buffer.concat([this.accum, chunk]);
      while (this.accum.length >= GSM_PACKET_BYTES) {
        const gsmBuf = Buffer.from(this.accum.slice(0, GSM_PACKET_BYTES));
        this.accum = this.accum.slice(GSM_PACKET_BYTES);
        const now = Date.now();
        if (this.lastGsmMs > 0 && now - this.lastGsmMs > 150) {
          console.log(`[gsm-enc] ${(/* @__PURE__ */ new Date()).toISOString()} GAP ${now - this.lastGsmMs}ms entre frames GSM de salida`);
        }
        this.lastGsmMs = now;
        this.emit("gsm", gsmBuf);
      }
    });
    setTimeout(() => {
      this.ready = true;
    }, 500);
  }
  encode(pcm) {
    if (!this.proc || !this.ready) return;
    const needed = GSM_FRAME_SAMPLES * FRAMES_PER_PACKET;
    if (pcm.length < needed) return;
    try {
      const chunk = pcm.length === needed ? pcm : pcm.slice(0, needed);
      const buf2 = Buffer.from(chunk.buffer, chunk.byteOffset, needed * 2);
      this.proc.stdin.write(buf2);
    } catch {
    }
  }
  stop() {
    try {
      this.proc?.stdin.end();
      this.proc?.kill("SIGTERM");
    } catch {
    }
    this.proc = null;
    this.ready = false;
    this.accum = Buffer.alloc(0);
  }
};

// src/alsa-audio.ts
function computeGsmSilenceFrame() {
  const pcm = Buffer.alloc(GSM_FRAME_SAMPLES * 2, 0);
  try {
    const r = spawnSync("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "quiet",
      "-f",
      "s16le",
      "-ar",
      "8000",
      "-ac",
      "1",
      "-i",
      "pipe:0",
      "-f",
      "gsm",
      "-ar",
      "8000",
      "pipe:1"
    ], { input: pcm, encoding: "buffer", timeout: 5e3 });
    if (r.stdout && r.stdout.length >= GSM_PACKET_BYTES) {
      console.log(`[audio] GSM silence precomputado: ${r.stdout.slice(0, GSM_PACKET_BYTES).toString("hex")}`);
      return r.stdout.slice(0, GSM_PACKET_BYTES);
    }
    console.error(`[audio] GSM silence: ffmpeg devolvio ${r.stdout?.length ?? 0} bytes (esperado ${GSM_PACKET_BYTES})`);
  } catch (e) {
    console.error(`[audio] GSM silence: fallo precomputo: ${e}`);
  }
  return Buffer.alloc(GSM_PACKET_BYTES, 0);
}
var GSM_SILENCE_FRAME = computeGsmSilenceFrame();
var PCM_CHUNK_SAMPLES = GSM_FRAME_SAMPLES * FRAMES_PER_PACKET;
var JITTER_PRE_BUFFER_SAMPLES = 1920;
var SILENCE_THRESHOLD_MS = 40;
var SILENCE_INJECT_BYTES = 8e3;
var AlsaAudio = class extends EventEmitter3 {
  constructor(cfg2) {
    super();
    this.cfg = cfg2;
  }
  recorder = null;
  player = null;
  encoder = new GsmEncoder();
  decoder = new GsmDecoder();
  pcmAccum = new Int16Array(0);
  jitterBuf = new Int16Array(0);
  // Semi-duplex state
  recorderSuspended = false;
  // rxActive: true cuando estamos en modo reproduccion RX (no silencio).
  // aplay arranca al inicio y NUNCA cierra — escribe silencio cuando no hay
  // audio RX para evitar el ciclo open/close que corrompe el estado USB de
  // VirtualBox. rxActive controla si playPcm escribe audio o sigue en pre-buffer.
  rxActive = false;
  stopping = false;
  // Metricas de nivel en captura
  levelPeakRms = 0;
  levelClipCount = 0;
  levelSamples = 0;
  levelTimer = null;
  // Inyeccion de silencio: previene underruns de aplay cuando hay gaps de red
  silenceTimer = null;
  lastAudioWriteMs = 0;
  // Diagnostico arecord: log tamaño de los primeros chunks (verifica period=160)
  arecordChunkCount = 0;
  lastArecordChunkMs = 0;
  // Jitter buffer de captura: absorbe las rafagas periodicas del CM108 USB y
  // entrega PCM al encoder GSM a ritmo constante de 20ms via captureTimer.
  // El CM108 batch-entrega ~750ms de audio cada segundo (firmware USB); sin
  // este buffer el encoder recibe rafagas y produce GSM bursty no transmisible.
  captureRingBuf = new Int16Array(0);
  captureTimer = null;
  // TX keepalive: rellena los gaps del CM108 con GSM_SILENCE_FRAME sin pasar
  // por ffmpeg (ffmpeg hace batching interno → frames de silencio llegan en
  // rafaga en lugar de cada 20ms → servidor desconecta con "Indicativo invalido").
  // El timer chequea cada 5ms si han pasado >20ms sin frame GSM emitido; si es
  // asi, emite directamente el frame de silencio precomputado.
  txActive = false;
  txKeepaliveTimer = null;
  lastGsmEmitMs = 0;
  start() {
    this.startDecoder();
    this.startEncoder();
    this.startRecorder();
    this.startCaptureTimer();
    this.levelTimer = setInterval(() => this.logLevel(), 5e3);
    this.startPlayerPermanent();
  }
  async stop() {
    this.stopping = true;
    if (this.captureTimer) {
      clearInterval(this.captureTimer);
      this.captureTimer = null;
    }
    this.captureRingBuf = new Int16Array(0);
    if (this.levelTimer) {
      clearInterval(this.levelTimer);
      this.levelTimer = null;
    }
    this.stopTxKeepalive();
    this.stopSilenceInjection();
    if (this.recorder) {
      const rec = this.recorder;
      this.recorder = null;
      await new Promise((resolve) => {
        const sigkill = setTimeout(() => {
          try {
            rec.kill("SIGKILL");
          } catch {
          }
        }, 800);
        const timeout = setTimeout(resolve, 1500);
        rec.once("close", () => {
          clearTimeout(sigkill);
          clearTimeout(timeout);
          resolve();
        });
        try {
          rec.kill("SIGTERM");
        } catch {
          resolve();
        }
      });
    }
    if (this.player) {
      const p = this.player;
      this.player = null;
      await new Promise((resolve) => {
        const sigterm = setTimeout(() => {
          try {
            p.kill("SIGTERM");
          } catch {
          }
        }, 500);
        const timeout = setTimeout(resolve, 1500);
        p.once("close", () => {
          clearTimeout(sigterm);
          clearTimeout(timeout);
          resolve();
        });
        try {
          p.stdin.end();
        } catch {
        }
      });
    }
    this.encoder.stop();
    this.decoder.stop();
  }
  rxGsmCount = 0;
  playGsm(gsm) {
    this.rxGsmCount++;
    if (this.rxGsmCount <= 3 || this.rxGsmCount % 50 === 0)
      log2(`[playGsm] pkt#${this.rxGsmCount} len=${gsm.length} decoder_ready=${this.decoder.ready} player=${this.player ? "running" : "null"} rxActive=${this.rxActive}`);
    this.decoder.decode(gsm);
  }
  endRx() {
    this.stopPlayer();
  }
  setTxEnabled(enabled) {
    this.txActive = enabled;
    if (enabled) {
      this.lastGsmEmitMs = Date.now();
      this.startTxKeepalive();
    } else {
      this.stopTxKeepalive();
      this.pcmAccum = new Int16Array(0);
      this.captureRingBuf = new Int16Array(0);
    }
  }
  // TX keepalive: emite GSM_SILENCE_FRAME directamente (sin pasar por ffmpeg)
  // para rellenar los gaps del CM108. ffmpeg hace batching interno y NO hace
  // flush frame a frame aunque se usen -avioflags direct/-fflags +flush_packets,
  // por lo que el approach de inyectar silencio via encoder no funciona.
  startTxKeepalive() {
    if (this.txKeepaliveTimer) return;
    this.txKeepaliveTimer = setInterval(() => {
      if (!this.txActive) return;
      const now = Date.now();
      if (now - this.lastGsmEmitMs >= 20) {
        this.lastGsmEmitMs = now;
        this.emit("gsm_tx", GSM_SILENCE_FRAME);
      }
    }, 5);
  }
  stopTxKeepalive() {
    if (this.txKeepaliveTimer) {
      clearInterval(this.txKeepaliveTimer);
      this.txKeepaliveTimer = null;
    }
  }
  // ── Encoder (micro → GSM) ─────────────────────────────────────────────────
  startEncoder() {
    this.encoder.start();
    this.encoder.on("gsm", (gsm) => {
      this.lastGsmEmitMs = Date.now();
      this.emit("gsm_tx", gsm);
    });
  }
  feedPcm(pcm) {
    const merged = new Int16Array(this.pcmAccum.length + pcm.length);
    merged.set(this.pcmAccum);
    merged.set(pcm, this.pcmAccum.length);
    this.pcmAccum = merged;
    this.emit("pcm_chunk", pcm);
    while (this.pcmAccum.length >= PCM_CHUNK_SAMPLES) {
      const chunk = this.pcmAccum.slice(0, PCM_CHUNK_SAMPLES);
      this.pcmAccum = this.pcmAccum.slice(PCM_CHUNK_SAMPLES);
      this.encoder.encode(chunk);
    }
  }
  // ── Decoder (GSM → aplay) ────────────────────────────────────────────────
  startDecoder() {
    this.decoder.start();
    this.decoder.on("pcm", (pcm) => {
      this.playPcm(pcm);
    });
  }
  applyGain(pcm) {
    const gain = this.cfg.outputGain;
    if (gain === 1) return pcm;
    const out = new Int16Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) {
      out[i] = Math.max(-32768, Math.min(32767, Math.round(pcm[i] * gain)));
    }
    return out;
  }
  pcmChunkCount = 0;
  playPcm(pcm) {
    const samples = this.applyGain(pcm);
    this.pcmChunkCount++;
    if (!this.rxActive) {
      const merged = new Int16Array(this.jitterBuf.length + samples.length);
      merged.set(this.jitterBuf);
      merged.set(samples, this.jitterBuf.length);
      this.jitterBuf = merged;
      if (this.pcmChunkCount <= 5)
        log2(`[playPcm] chunk#${this.pcmChunkCount} \u2192 jitterBuf=${this.jitterBuf.length} rxActive=false`);
      if (this.jitterBuf.length >= JITTER_PRE_BUFFER_SAMPLES) {
        this.startPlayer();
      }
      return;
    }
    if (this.pcmChunkCount <= 5)
      log2(`[playPcm] chunk#${this.pcmChunkCount} \u2192 escribiendo ${samples.length} muestras a aplay stdin`);
    const buf2 = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
    try {
      this.player?.stdin.write(buf2);
      this.lastAudioWriteMs = Date.now();
    } catch {
    }
  }
  // ── Jitter buffer de captura ─────────────────────────────────────────────
  /**
   * Timer que consume el captureRingBuf a ritmo constante (20ms = 160 muestras).
   * El CM108 USB entrega audio en rafagas periodicas (~750ms); este timer
   * distribuye las rafagas uniformemente antes de entregarlas al encoder GSM.
   * Resultado: encoder recibe 1 frame cada 20ms → GSM output sin gaps.
   *
   * Latencia adicional introducida: hasta ~750ms (tamano maximo de la rafaga).
   * Aceptable para radio PTT donde la latencia total ya supera 1-2 segundos.
   *
   * Log de diagnostico: si el ring buffer supera 3200 muestras (400ms de audio
   * acumulado) se registra un aviso para detectar deriva del timer.
   */
  startCaptureTimer() {
    if (this.captureTimer) clearInterval(this.captureTimer);
    const MAX_CAPTURE_SAMPLES = 16e3;
    let lastWarnMs = 0;
    let lastDrainMs = Date.now();
    this.captureTimer = setInterval(() => {
      if (this.captureRingBuf.length > MAX_CAPTURE_SAMPLES) {
        const now2 = Date.now();
        if (now2 - lastWarnMs > 3e4) {
          log2(`[captureTimer] WARN: ring buffer ${this.captureRingBuf.length} muestras \u2014 descartando exceso (deriva de timer)`);
          lastWarnMs = now2;
        }
        this.captureRingBuf = this.captureRingBuf.slice(this.captureRingBuf.length - 8e3);
        lastDrainMs = Date.now();
      }
      const now = Date.now();
      const elapsed = now - lastDrainMs;
      const framesToDrain = Math.max(1, Math.min(Math.round(elapsed / 20), 8));
      let drained = 0;
      while (drained < framesToDrain && this.captureRingBuf.length >= PCM_CHUNK_SAMPLES) {
        const chunk = this.captureRingBuf.slice(0, PCM_CHUNK_SAMPLES);
        this.captureRingBuf = this.captureRingBuf.slice(PCM_CHUNK_SAMPLES);
        this.feedPcm(chunk);
        drained++;
      }
      if (drained > 0) lastDrainMs += drained * 20;
    }, 20);
  }
  // ── arecord ───────────────────────────────────────────────────────────────
  // ── USB audio reset (CM108 VirtualBox) ──────────────────────────────────
  /**
   * Recarga el driver snd_usb_audio para recuperar el CM108 tras aplay.
   * En VirtualBox, cerrar aplay corrompe el estado USB interno del driver,
   * haciendo que arecord falle con 'Unable to install hw params'. El reload
   * resetea el estado y permite reiniciar arecord correctamente.
   * El servicio corre como root (sin User= en .service) → modprobe directo.
   */
  resetUsbAudio() {
    return new Promise((resolve) => {
      log2("[audio] USB reset: modprobe -r snd_usb_audio...");
      const unload = spawn2("modprobe", ["-r", "snd_usb_audio"]);
      unload.on("error", (e) => {
        log2("[audio] USB reset: error en modprobe -r: " + e.message + " \u2014 saliendo para que systemd reinicie limpio");
        process.exit(1);
      });
      unload.on("close", (code) => {
        if (code !== 0) {
          log2("[audio] USB reset: modprobe -r fall\xF3 (code " + code + ") \u2014 saliendo para reinicio limpio via systemd");
          process.exit(1);
        }
        log2("[audio] USB reset: descargado OK, recargando...");
        const load = spawn2("modprobe", ["snd_usb_audio"]);
        load.on("error", (e) => {
          log2("[audio] USB reset: error en modprobe load: " + e.message);
          resolve();
        });
        load.on("close", (code2) => {
          log2("[audio] USB reset: cargado (code " + code2 + "), esperando 1.5s...");
          setTimeout(resolve, 1500);
        });
      });
    });
  }
  startRecorder() {
    const captureDevice = this.cfg.captureDevice;
    const CAPTURE_RATE = 48e3;
    const CAPTURE_CHANNELS = 1;
    const PERIOD_FRAMES = 960;
    const BUFFER_FRAMES = 48e3;
    const DECIMATE = 6;
    const args = [
      "-D",
      captureDevice,
      "-f",
      "S16_LE",
      "-r",
      String(CAPTURE_RATE),
      "-c",
      String(CAPTURE_CHANNELS),
      "-q",
      `--period-size=${PERIOD_FRAMES}`,
      `--buffer-size=${BUFFER_FRAMES}`
    ];
    log2(`arecord ${args.join(" ")}`);
    this.recorder = spawn2("arecord", args, { stdio: ["ignore", "pipe", "pipe"] });
    this.recorder.stderr.on("data", (d) => {
      const msg = d.toString().trim();
      if (msg) log2(`[arecord] ${msg}`);
    });
    this.recorder.on("error", (err) => {
      log2(`[arecord] Error: ${err.message}`);
      this.emit("error", err);
    });
    this.recorder.on("close", (code) => {
      log2(`[arecord] Terminado (code ${code})`);
      this.recorder = null;
      if (!this.recorderSuspended && !this.stopping) {
        setTimeout(() => {
          if (!this.recorderSuspended && !this.stopping && this.recorder === null) {
            this.emit("recorder_restarted");
            this.startRecorder();
          }
        }, 2e3);
      }
    });
    let accumBuf = Buffer.alloc(0);
    this.recorder.stdout.on("data", (rawChunk) => {
      accumBuf = Buffer.concat([accumBuf, rawChunk]);
      const BYTES_PER_STEREO_FRAME = CAPTURE_CHANNELS * 2;
      const BYTES_PER_DECIMATE_GROUP = BYTES_PER_STEREO_FRAME * DECIMATE;
      const numOutputSamples = Math.floor(accumBuf.length / BYTES_PER_DECIMATE_GROUP);
      if (numOutputSamples === 0) return;
      const consumedBytes = numOutputSamples * BYTES_PER_DECIMATE_GROUP;
      this.arecordChunkCount++;
      const now = Date.now();
      const gain = this.cfg.inputGain;
      if (this.arecordChunkCount <= 8)
        log2(`[arecord] chunk#${this.arecordChunkCount}: ${rawChunk.length} bytes brutos \u2192 ${numOutputSamples} muestras 8kHz (decimate\xD7${DECIMATE})`);
      const gapMs = this.lastArecordChunkMs > 0 ? now - this.lastArecordChunkMs : 0;
      if (gapMs > 50)
        log2(`[arecord] GAP ${gapMs}ms (chunk#${this.arecordChunkCount}, ${numOutputSamples} muestras)`);
      this.lastArecordChunkMs = now;
      const pcm = new Int16Array(numOutputSamples);
      let sumSq = 0;
      const drive = 1.5;
      const BYTES_PER_SAMPLE = CAPTURE_CHANNELS * 2;
      for (let i = 0; i < numOutputSamples; i++) {
        const base = i * BYTES_PER_DECIMATE_GROUP;
        let sum = 0;
        for (let d = 0; d < DECIMATE; d++) {
          sum += accumBuf.readInt16LE(base + d * BYTES_PER_SAMPLE);
        }
        const mono = sum / DECIMATE;
        const norm = mono * gain / 32768;
        const limited = Math.tanh(norm * drive) / Math.tanh(drive);
        const s = Math.round(limited * 32767);
        pcm[i] = s;
        sumSq += s * s;
        if (Math.abs(s) > 3e4) this.levelClipCount++;
      }
      accumBuf = accumBuf.subarray(consumedBytes);
      const rms = Math.sqrt(sumSq / numOutputSamples);
      if (rms > this.levelPeakRms) this.levelPeakRms = rms;
      this.levelSamples += numOutputSamples;
      const merged = new Int16Array(this.captureRingBuf.length + pcm.length);
      merged.set(this.captureRingBuf);
      merged.set(pcm, this.captureRingBuf.length);
      this.captureRingBuf = merged;
    });
  }
  stopRecorder() {
    try {
      this.recorder?.kill("SIGTERM");
    } catch {
    }
    this.recorder = null;
  }
  logLevel() {
    if (this.levelSamples === 0) return;
    const peakDb = this.levelPeakRms > 0 ? (20 * Math.log10(this.levelPeakRms / 32768)).toFixed(1) : "-inf";
    const clipPct = (this.levelClipCount / this.levelSamples * 100).toFixed(2);
    const clipping = this.levelClipCount > 0 ? ` SATURACION: ${this.levelClipCount} muestras (${clipPct}%)` : "";
    log2(`[nivel] pico RMS=${Math.round(this.levelPeakRms)} (${peakDb} dBFS)  VOXumbral=${this.cfg.voxThresholdRms}  gain=${this.cfg.inputGain}${clipping}`);
    this.levelPeakRms = 0;
    this.levelClipCount = 0;
    this.levelSamples = 0;
  }
  // ── aplay ────────────────────────────────────────────────────────────────
  /**
   * Activa modo RX (reproduccion): aplay ya esta corriendo con silencio.
   * Vuelca el jitter pre-buffer y activa rxActive para que playPcm escriba
   * audio directamente en lugar de seguir acumulando en el jitter buffer.
   * Semi-duplex: mata arecord para evitar realimentacion altavoz→microfono.
   */
  startPlayer() {
    if (this.rxActive) return;
    this.rxActive = true;
    this.stopSilenceInjection();
    if (this.jitterBuf.length > 0 && this.player && !this.player.killed) {
      const buf2 = Buffer.from(this.jitterBuf.buffer, this.jitterBuf.byteOffset, this.jitterBuf.byteLength);
      try {
        this.player.stdin.write(buf2);
      } catch {
      }
      this.jitterBuf = new Int16Array(0);
    }
    this.startSilenceInjection();
    if (this.recorder) {
      log2("[audio] Semi-duplex: matando arecord \u2014 evitar realimentacion altavoz\u2192micro");
      this.recorderSuspended = true;
      this.captureRingBuf = new Int16Array(0);
      const rec = this.recorder;
      this.recorder = null;
      const watchdog = setTimeout(() => {
        try {
          rec.kill("SIGKILL");
        } catch {
        }
      }, 800);
      rec.once("close", () => clearTimeout(watchdog));
      try {
        rec.kill("SIGTERM");
      } catch {
        clearTimeout(watchdog);
      }
    }
  }
  /**
   * Arranca aplay de forma permanente (al inicio del daemon y tras caidas).
   * aplay lee de su stdin y NUNCA se cierra voluntariamente durante operacion
   * normal. La inyeccion de silencio mantiene el stream USB activo entre RX.
   * Esto evita el ciclo open/close que corrompe el device USB en VirtualBox.
   */
  startPlayerPermanent() {
    if (this.stopping) return;
    const args = [
      "-D",
      this.cfg.playbackDevice,
      "-f",
      "S16_LE",
      "-r",
      "8000",
      "-c",
      "1",
      "-q",
      "--buffer-size=24000",
      // 3s a 8kHz — absorbe jitter del scheduler VirtualBox
      "--period-size=800"
      // 100ms por periodo
    ];
    log2(`aplay ${args.join(" ")}`);
    this.player = spawn2("aplay", args, { stdio: ["pipe", "ignore", "pipe"] });
    const p = this.player;
    p.stderr.on("data", (d) => {
      const msg = d.toString().trim();
      if (msg) log2(`[aplay] ${msg}`);
    });
    p.on("error", (err) => {
      log2(`[aplay] Error: ${err.message}`);
    });
    p.on("close", (code) => {
      log2(`[aplay] Terminado (code ${code})`);
      if (this.player === p) {
        this.player = null;
        this.rxActive = false;
        this.stopSilenceInjection();
        if (!this.stopping) {
          if (this.recorderSuspended) {
            this.recorderSuspended = false;
            this.emit("playback_ended");
            this.startRecorder();
          }
          log2("[aplay] Caida inesperada \u2014 reiniciando en 2s...");
          setTimeout(() => {
            if (!this.stopping && !this.player) this.startPlayerPermanent();
          }, 2e3);
        }
      }
    });
    this.startSilenceInjection();
  }
  stopPlayer() {
    if (!this.rxActive && !this.recorderSuspended) return;
    this.rxActive = false;
    if (this.jitterBuf.length > 0 && this.player && !this.player.killed) {
      const buf2 = Buffer.from(this.jitterBuf.buffer, this.jitterBuf.byteOffset, this.jitterBuf.byteLength);
      try {
        this.player.stdin.write(buf2);
      } catch {
      }
      this.jitterBuf = new Int16Array(0);
    }
    this.stopSilenceInjection();
    this.startSilenceInjection();
    if (this.recorderSuspended && !this.stopping) {
      this.recorderSuspended = false;
      this.emit("playback_ended");
      log2("[audio] RX terminado \u2014 reanudando arecord (aplay sigue activo con silencio)");
      this.startRecorder();
    }
  }
  // ── Inyeccion de silencio ─────────────────────────────────────────────────
  /**
   * Arranca un timer que, si no llega audio real en SILENCE_THRESHOLD_MS ms,
   * escribe silencio en aplay stdin para mantener el buffer DMA lleno.
   * Esto previene los underruns causados por jitter de red o gaps entre
   * transmisiones, que se manifestaban como silencios de hasta 2s audibles.
   */
  startSilenceInjection() {
    this.stopSilenceInjection();
    this.lastAudioWriteMs = Date.now();
    this.silenceTimer = setInterval(() => {
      if (!this.player || this.player.killed) {
        this.stopSilenceInjection();
        return;
      }
      const gap = Date.now() - this.lastAudioWriteMs;
      if (gap >= SILENCE_THRESHOLD_MS) {
        const silence = Buffer.alloc(SILENCE_INJECT_BYTES, 0);
        try {
          this.player.stdin.write(silence);
          this.lastAudioWriteMs = Date.now();
        } catch {
          this.stopSilenceInjection();
        }
      }
    }, 60);
  }
  stopSilenceInjection() {
    if (this.silenceTimer) {
      clearInterval(this.silenceTimer);
      this.silenceTimer = null;
    }
  }
};
function log2(msg) {
  console.log(`[audio] ${(/* @__PURE__ */ new Date()).toISOString()} ${msg}`);
}

// src/vox.ts
import { EventEmitter as EventEmitter4 } from "events";
var Vox = class extends EventEmitter4 {
  // chunks consecutivos sobre umbral
  constructor(thresholdRms, hangMs, debounceChunks = 1) {
    super();
    this.thresholdRms = thresholdRms;
    this.hangMs = hangMs;
    this.debounceChunks = debounceChunks;
  }
  active = false;
  hangTimer = null;
  consecutiveAbove = 0;
  /** Alimentar muestras PCM — llamado por AlsaAudio en cada chunk. */
  processPcm(pcm) {
    const rms = calcRms(pcm);
    if (rms >= this.thresholdRms) {
      if (this.hangTimer) {
        clearTimeout(this.hangTimer);
        this.hangTimer = null;
      }
      this.consecutiveAbove++;
      if (!this.active && this.consecutiveAbove >= this.debounceChunks) {
        this.active = true;
        this.consecutiveAbove = 0;
        this.emit("ptt_start");
      }
    } else {
      this.consecutiveAbove = 0;
      if (this.active && !this.hangTimer) {
        this.hangTimer = setTimeout(() => {
          this.hangTimer = null;
          this.active = false;
          this.emit("ptt_end");
        }, this.hangMs);
      }
    }
  }
  /** Forzar PTT activo (control manual desde HTTP). */
  forcePttStart() {
    if (this.hangTimer) {
      clearTimeout(this.hangTimer);
      this.hangTimer = null;
    }
    this.consecutiveAbove = 0;
    if (!this.active) {
      this.active = true;
      this.emit("ptt_start");
    }
  }
  /** Forzar PTT inactivo (control manual desde HTTP). */
  forcePttEnd() {
    if (this.hangTimer) {
      clearTimeout(this.hangTimer);
      this.hangTimer = null;
    }
    this.consecutiveAbove = 0;
    if (this.active) {
      this.active = false;
      this.emit("ptt_end");
    }
  }
  /**
   * Resetear estado interno del VOX sin emitir ptt_end.
   * Usar cuando queremos cancelar un ciclo de activacion bloqueado.
   */
  resetState() {
    if (this.hangTimer) {
      clearTimeout(this.hangTimer);
      this.hangTimer = null;
    }
    this.consecutiveAbove = 0;
    this.active = false;
  }
  get isActive() {
    return this.active;
  }
};
function calcRms(pcm) {
  if (pcm.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) {
    sum += pcm[i] * pcm[i];
  }
  return Math.sqrt(sum / pcm.length);
}

// src/serial-ptt.ts
import { spawn as spawn3 } from "child_process";
import { EventEmitter as EventEmitter5 } from "events";
import { fileURLToPath } from "url";
import path from "path";
var SerialPtt = class extends EventEmitter5 {
  constructor(cfg2) {
    super();
    this.cfg = cfg2;
    this.enabled = Boolean(cfg2.device);
  }
  proc = null;
  ready = false;
  enabled = false;
  pendingCmd = null;
  start() {
    if (!this.enabled || this.proc) return;
    const helperPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "ptt-helper.py"
    );
    log3(`Iniciando PTT serial: ${this.cfg.device} (${this.cfg.method})`);
    this.proc = spawn3("python3", [
      helperPath,
      this.cfg.device,
      this.cfg.method,
      String(this.cfg.inverted)
    ], { stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stdout.on("data", (data) => {
      const msg = data.toString().trim();
      if (msg === "ready") {
        this.ready = true;
        log3(`PTT serial listo (${this.cfg.device}, ${this.cfg.method})`);
        if (this.pendingCmd !== null) {
          this._write(this.pendingCmd);
          this.pendingCmd = null;
        }
      }
    });
    this.proc.stderr.on("data", (data) => {
      const msg = data.toString().trim();
      if (msg) log3(`[ptt-helper] ${msg}`);
    });
    this.proc.on("error", (err) => {
      log3(`PTT serial: no se pudo iniciar python3 \u2014 ${err.message}. PTT serial deshabilitado.`);
      this.proc = null;
      this.ready = false;
    });
    this.proc.on("close", (code) => {
      log3(`PTT serial: proceso terminado (code ${code})`);
      this.proc = null;
      this.ready = false;
    });
  }
  /** Activar (true) o desactivar (false) el PTT. */
  set(active) {
    const cmd = active ? "1" : "0";
    if (!this.enabled) {
      log3(`PTT set(${active}) ignorado \u2014 PTT serial deshabilitado (device vacio en config)`);
      return;
    }
    if (!this.proc) {
      log3(`PTT set(${active}) \u2192 helper caido, reiniciando...`);
      this.start();
    }
    if (!this.ready) {
      log3(`PTT set(${active}) \u2192 pendingCmd=${cmd} (helper no listo aun)`);
      this.pendingCmd = cmd;
      return;
    }
    log3(`PTT set(${active}) \u2192 escribiendo "${cmd}" al helper`);
    this._write(cmd);
  }
  stop() {
    if (this.proc) {
      try {
        this._write("0");
      } catch {
      }
      try {
        this.proc.stdin.end();
        this.proc.kill("SIGTERM");
      } catch {
      }
    }
    this.proc = null;
    this.ready = false;
  }
  _write(cmd) {
    try {
      this.proc?.stdin.write(cmd + "\n");
    } catch {
    }
  }
};
function log3(msg) {
  console.log(`[ptt] ${(/* @__PURE__ */ new Date()).toISOString()} ${msg}`);
}

// src/control-server.ts
import http from "http";
function startControlServer(cfg2, cb) {
  const server = http.createServer((req, res) => {
    const method = req.method ?? "GET";
    const url = req.url ?? "/";
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (method === "GET" && url === "/status") {
      res.writeHead(200);
      res.end(JSON.stringify(cb.getStatus(), null, 2));
      return;
    }
    if (method === "POST" && url === "/ptt/start") {
      cb.forcePttStart();
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, action: "ptt_start" }));
      return;
    }
    if (method === "POST" && url === "/ptt/end") {
      cb.forcePttEnd();
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, action: "ptt_end" }));
      return;
    }
    if (method === "POST" && url === "/reconnect") {
      cb.forceReconnect();
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, action: "reconnect" }));
      return;
    }
    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: "not found" }));
  });
  server.listen(cfg2.port, cfg2.host, () => {
    log4(`Control HTTP escuchando en http://${cfg2.host}:${cfg2.port}`);
  });
  server.on("error", (err) => {
    log4(`Error al iniciar servidor de control: ${err.message}`);
  });
  return server;
}
function log4(msg) {
  console.log(`[control] ${(/* @__PURE__ */ new Date()).toISOString()} ${msg}`);
}

// src/main.ts
var cfg = loadConfig();
var startTime = Date.now();
var eqsoClient = null;
var pttActive = false;
var reconnectAttempts = 0;
var reconnectTimer = null;
var rxPackets = 0;
var txPackets = 0;
var usersInRoom = [];
var lastPttIgnoredLogMs = 0;
var IDLE_RECONNECT_MS = 28e3;
var idleReconnectTimer = null;
function resetIdleTimer() {
  if (idleReconnectTimer) clearTimeout(idleReconnectTimer);
  idleReconnectTimer = setTimeout(() => {
    idleReconnectTimer = null;
    if (pttActive) return;
    log5("Reconectando por inactividad prolongada (prevenir timeout servidor)\u2026");
    eqsoClient?.disconnect();
  }, IDLE_RECONNECT_MS);
}
function cancelIdleTimer() {
  if (idleReconnectTimer) {
    clearTimeout(idleReconnectTimer);
    idleReconnectTimer = null;
  }
}
var rxActive = false;
var rxInhibitTimer = null;
var RX_HANG_MS = 400;
var postTxSuppressUntil = 0;
var POST_TX_SUPPRESS_MS = 1500;
var postRxVoxSuppressUntil = 0;
var POST_APLAY_VOX_SUPPRESS_MS = 2500;
var POST_TX_VOX_SUPPRESS_MS = 2500;
var startupSuppressUntil = Date.now() + cfg.audio.startupVoxSuppressMs;
function setRxActive() {
  const wasActive = rxActive;
  rxActive = true;
  if (!wasActive) serialPtt.set(true);
  if (rxInhibitTimer) clearTimeout(rxInhibitTimer);
  rxInhibitTimer = setTimeout(() => {
    rxActive = false;
    rxInhibitTimer = null;
    serialPtt.set(false);
    audio.endRx();
    const rxSuppressUntil = Date.now() + POST_APLAY_VOX_SUPPRESS_MS;
    const prev = postRxVoxSuppressUntil;
    postRxVoxSuppressUntil = Math.max(postRxVoxSuppressUntil, rxSuppressUntil);
    log5(`[rxInhibit] suppress: prev=${new Date(prev).toISOString()} new=${new Date(postRxVoxSuppressUntil).toISOString()}`);
  }, RX_HANG_MS);
}
var serialPtt = new SerialPtt(cfg.ptt);
var audio = new AlsaAudio(cfg.audio);
var vox = new Vox(cfg.audio.voxThresholdRms, cfg.audio.voxHangMs, cfg.audio.voxDebounceChunks ?? 5);
var TX_GATE_RMS = cfg.audio.txGateRms ?? 50;
var latestPcmRms = 0;
audio.on("error", (err) => {
  log5(`[audio] ERROR ALSA: ${err.message} \u2014 relay sigue activo, el audio se recuperar\xE1`);
});
audio.on("playback_ended", () => {
  const suppUntil = Date.now() + POST_APLAY_VOX_SUPPRESS_MS;
  const prev = postRxVoxSuppressUntil;
  postRxVoxSuppressUntil = Math.max(postRxVoxSuppressUntil, suppUntil);
  log5(`[rxInhibit] playback_ended: suppress extendido \u2192 ${new Date(postRxVoxSuppressUntil).toISOString()} (prev=${new Date(prev).toISOString()})`);
});
audio.on("recorder_restarted", () => {
  startupSuppressUntil = Date.now() + cfg.audio.startupVoxSuppressMs;
  log5(`[vox] arecord reiniciado \u2014 startup suppress reseteado hasta ${new Date(startupSuppressUntil).toISOString()}`);
});
audio.on("pcm_chunk", (pcm) => {
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
  latestPcmRms = Math.sqrt(sum / pcm.length);
  if (cfg.audio.vox && !rxActive && Date.now() > postRxVoxSuppressUntil && Date.now() > startupSuppressUntil) {
    vox.processPcm(pcm);
  }
});
vox.on("ptt_start", () => {
  if (!eqsoClient?.connected) {
    vox.resetState();
    const nowMs = Date.now();
    if (nowMs - lastPttIgnoredLogMs > 1e3) {
      lastPttIgnoredLogMs = nowMs;
      log5("VOX: ptt_start ignorado \u2014 sin conexion, reseteando estado VOX");
    }
    return;
  }
  if (pttActive || rxActive) return;
  const now = Date.now();
  if (now < postRxVoxSuppressUntil) {
    log5(`VOX: ptt_start BLOQUEADO \u2014 suppress activo hasta ${new Date(postRxVoxSuppressUntil).toISOString()} (restan ${postRxVoxSuppressUntil - now}ms)`);
    vox.resetState();
    return;
  }
  pttActive = true;
  cancelIdleTimer();
  audio.setTxEnabled(true);
  eqsoClient.startTx();
  log5(`VOX: PTT activado \u2014 inicio transmision (suppress was ${new Date(postRxVoxSuppressUntil).toISOString()})`);
});
vox.on("ptt_end", () => {
  if (!eqsoClient?.connected || !pttActive) return;
  pttActive = false;
  audio.setTxEnabled(false);
  eqsoClient.endTx();
  postTxSuppressUntil = Date.now() + POST_TX_SUPPRESS_MS;
  postRxVoxSuppressUntil = Math.max(postRxVoxSuppressUntil, Date.now() + POST_TX_VOX_SUPPRESS_MS);
  resetIdleTimer();
  log5(`VOX: PTT liberado \u2014 fin transmision (suppress hasta ${new Date(postRxVoxSuppressUntil).toISOString()})`);
});
audio.on("gsm_tx", (gsm) => {
  if (!pttActive || !eqsoClient?.connected) return;
  if (latestPcmRms < TX_GATE_RMS) return;
  eqsoClient.sendAudio(gsm);
  txPackets++;
});
function connect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  log5(`Conectando a ${cfg.server}:${cfg.port} como "${cfg.callsign}" en sala "${cfg.room}"\u2026`);
  const client = new EqsoClient(cfg.server, cfg.port);
  eqsoClient = client;
  pttActive = false;
  usersInRoom = [];
  client.on("event", (ev) => {
    switch (ev.type) {
      case "connected":
        reconnectAttempts = 0;
        log5("Conectado \u2014 enviando JOIN\u2026");
        client.sendJoin(cfg.callsign, cfg.room, cfg.message, cfg.password);
        resetIdleTimer();
        break;
      case "room_list":
        log5(`Salas: ${ev.data.join(", ")}`);
        break;
      case "user_joined": {
        const u = ev.data;
        if (!usersInRoom.includes(u.name)) usersInRoom.push(u.name);
        log5(`Sala: ${u.name} se ha unido`);
        break;
      }
      case "user_left": {
        const u = ev.data;
        usersInRoom = usersInRoom.filter((n) => n !== u.name);
        log5(`Sala: ${u.name} ha salido`);
        break;
      }
      case "ptt_started": {
        const u = ev.data;
        log5(`TX: ${u.name} transmitiendo`);
        break;
      }
      case "ptt_released": {
        const u = ev.data;
        log5(`TX: ${u.name} libero canal`);
        break;
      }
      case "audio": {
        const pkt = ev.data;
        if (pkt.length < 1 + GSM_PACKET_BYTES) {
          log5(`[audio] pkt demasiado corto: ${pkt.length} bytes (esperado ${1 + GSM_PACKET_BYTES})`);
          break;
        }
        rxPackets++;
        if (pttActive) {
          if (rxPackets <= 3 || rxPackets % 20 === 0)
            log5(`[audio] pkt#${rxPackets} DESCARTADO \u2014 pttActive=true (TX local activo)`);
          break;
        }
        const suppRestMs = postTxSuppressUntil - Date.now();
        if (suppRestMs > 0) {
          if (rxPackets <= 3 || rxPackets % 20 === 0)
            log5(`[audio] pkt#${rxPackets} DESCARTADO \u2014 postTxSuppress en ${suppRestMs}ms`);
          break;
        }
        if (cfg.audio.outputGain === 0) break;
        setRxActive();
        const gsm = Buffer.from(pkt.buffer, pkt.byteOffset + 1, GSM_PACKET_BYTES);
        audio.playGsm(gsm);
        if (rxPackets <= 3 || rxPackets % 50 === 0)
          log5(`[audio] pkt#${rxPackets} \u2192 playGsm OK (pttActive=${pttActive} rxActive=${rxActive})`);
        break;
      }
      case "server_msg":
        log5(`Mensaje servidor: ${ev.data}`);
        break;
      case "keepalive":
        log5("Keepalive recibido del servidor [0x0c]");
        resetIdleTimer();
        break;
      case "disconnected":
        cancelIdleTimer();
        log5("Desconectado del servidor eQSO");
        if (pttActive) {
          pttActive = false;
          audio.setTxEnabled(false);
          vox.resetState();
          log5("[vox] Estado PTT reseteado por desconexion durante TX");
        }
        scheduleReconnect();
        break;
      case "error":
        log5(`Error TCP: ${ev.data}`);
        scheduleReconnect();
        break;
    }
  });
  client.connect();
}
function scheduleReconnect() {
  if (reconnectTimer) return;
  eqsoClient = null;
  pttActive = false;
  usersInRoom = [];
  reconnectAttempts++;
  const delay = Math.min(
    cfg.reconnectMinMs * Math.pow(2, Math.min(reconnectAttempts - 1, 5)),
    cfg.reconnectMaxMs
  );
  log5(`Reintento #${reconnectAttempts} en ${Math.round(delay / 1e3)}s\u2026`);
  reconnectTimer = setTimeout(connect, delay);
}
if (cfg.control.enabled) {
  startControlServer(cfg.control, {
    getStatus: () => ({
      connected: eqsoClient?.connected ?? false,
      callsign: cfg.callsign,
      room: cfg.room,
      server: cfg.server,
      port: cfg.port,
      pttActive,
      voxEnabled: cfg.audio.vox,
      reconnectAttempts,
      uptimeMs: Date.now() - startTime,
      rxPackets,
      txPackets,
      usersInRoom: [...usersInRoom]
    }),
    forcePttStart: () => {
      log5("Control HTTP: PTT ON forzado");
      vox.forcePttStart();
    },
    forcePttEnd: () => {
      log5("Control HTTP: PTT OFF forzado");
      vox.forcePttEnd();
    },
    forceReconnect: () => {
      log5("Control HTTP: reconexion forzada");
      eqsoClient?.disconnect();
      scheduleReconnect();
    }
  });
}
log5("=".repeat(60));
log5(`eQSO Relay Daemon arrancado`);
log5(`  Callsign : ${cfg.callsign}`);
log5(`  Sala     : ${cfg.room}`);
log5(`  Servidor : ${cfg.server}:${cfg.port}`);
log5(`  VOX      : ${cfg.audio.vox ? `ON (umbral=${cfg.audio.voxThresholdRms} hang=${cfg.audio.voxHangMs}ms debounce=${cfg.audio.voxDebounceChunks ?? 5}chunks)` : "OFF"}`);
log5(`  Captura  : ${cfg.audio.captureDevice}`);
log5(`  Playback : ${cfg.audio.playbackDevice}`);
log5(`  PTT Ser. : ${cfg.ptt.device ? `${cfg.ptt.device} (${cfg.ptt.method}${cfg.ptt.inverted ? ", invertido" : ""})` : "deshabilitado"}`);
log5(`  VOX Sup. : startup suppress ${cfg.audio.startupVoxSuppressMs}ms activo hasta ${new Date(startupSuppressUntil).toISOString()}`);
log5("=".repeat(60));
if (cfg.ptt.device) serialPtt.start();
audio.start();
connect();
async function shutdown(sig) {
  log5(`Se\xF1al ${sig} recibida \u2014 apagando (graceful)\u2026`);
  if (pttActive) {
    eqsoClient?.endTx();
  }
  eqsoClient?.disconnect();
  serialPtt.stop();
  await audio.stop();
  log5("Apagado completado.");
  process.exit(0);
}
process.on("SIGTERM", () => {
  shutdown("SIGTERM").catch(() => process.exit(1));
});
process.on("SIGINT", () => {
  shutdown("SIGINT").catch(() => process.exit(1));
});
process.on("SIGUSR1", () => {
  log5("SIGUSR1: reconexion manual");
  eqsoClient?.disconnect();
  scheduleReconnect();
});
function log5(msg) {
  console.log(`[main] ${(/* @__PURE__ */ new Date()).toISOString()} ${msg}`);
}
//# sourceMappingURL=main.mjs.map
