/**
 * eQSO Relay Daemon — punto de entrada principal
 *
 * Conecta como radioenlace (0R-) al servidor eQSO con reconexion automatica,
 * gestiona el audio ALSA y expone un servidor HTTP de control en localhost.
 *
 * Configuracion: /etc/eqso-relay/<instancia>.json  o env var CONFIG_FILE
 * Uso:           node dist/main.mjs
 * Como servicio: systemctl start eqso-relay@CB
 */

import { loadConfig } from "./config.js";
import { EqsoClient } from "./eqso-client.js";
import { AlsaAudio } from "./alsa-audio.js";
import { Vox } from "./vox.js";
import { startControlServer, RelayStatus } from "./control-server.js";
import { GSM_PACKET_BYTES } from "./gsm-codec.js";

const cfg = loadConfig();
const startTime = Date.now();

// ─── Estado compartido ────────────────────────────────────────────────────────
let eqsoClient: EqsoClient | null = null;
let pttActive = false;
let reconnectAttempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let rxPackets = 0;
let txPackets = 0;
let usersInRoom: string[] = [];
let forceReconnectRequested = false;

// ─── Inhibicion RX (anti-feedback acustico) ───────────────────────────────────
// Cuando la radio reproduce audio del servidor, inhibimos el VOX durante ese
// tiempo + 600 ms de margen para que el sonido del altavoz no active el micro.
let rxActive = false;
let rxInhibitTimer: ReturnType<typeof setTimeout> | null = null;
const RX_HANG_MS = 600; // ms de margen tras el ultimo paquete RX

function setRxActive(): void {
  rxActive = true;
  if (rxInhibitTimer) clearTimeout(rxInhibitTimer);
  rxInhibitTimer = setTimeout(() => {
    rxActive = false;
    rxInhibitTimer = null;
  }, RX_HANG_MS);
}

// ─── Audio y VOX ─────────────────────────────────────────────────────────────
const audio = new AlsaAudio(cfg.audio);
const vox   = new Vox(cfg.audio.voxThresholdRms, cfg.audio.voxHangMs);

// El audio emite chunks PCM crudos para que el VOX los analice
audio.on("pcm_chunk", (pcm: Int16Array) => {
  if (cfg.audio.vox && !rxActive) vox.processPcm(pcm);
});

// Cuando el VOX o control HTTP activan PTT
vox.on("ptt_start", () => {
  if (!eqsoClient?.connected || pttActive || rxActive) return;
  pttActive = true;
  eqsoClient.startTx();
  log("VOX: PTT activado — inicio transmision");
});

vox.on("ptt_end", () => {
  if (!eqsoClient?.connected || !pttActive) return;
  pttActive = false;
  audio.setTxEnabled(false);
  eqsoClient.endTx();
  log("VOX: PTT liberado — fin transmision");
});

// El audio emite paquetes GSM listos para enviar al servidor
audio.on("gsm_tx", (gsm: Buffer) => {
  if (!pttActive || !eqsoClient?.connected) return;
  eqsoClient.sendAudio(gsm);
  txPackets++;
});

// ─── Conexion al servidor eQSO ────────────────────────────────────────────────

function connect(): void {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

  log(`Conectando a ${cfg.server}:${cfg.port} como "${cfg.callsign}" en sala "${cfg.room}"…`);

  const client = new EqsoClient(cfg.server, cfg.port);
  eqsoClient = client;
  pttActive  = false;
  usersInRoom = [];

  client.on("event", (ev: { type: string; data?: unknown }) => {
    switch (ev.type) {

      case "connected":
        reconnectAttempts = 0;
        log("Conectado — enviando JOIN…");
        client.sendJoin(cfg.callsign, cfg.room, cfg.message, cfg.password);
        break;

      case "room_list":
        log(`Salas: ${(ev.data as string[]).join(", ")}`);
        break;

      case "user_joined": {
        const u = ev.data as { name: string; message: string };
        if (!usersInRoom.includes(u.name)) usersInRoom.push(u.name);
        log(`Sala: ${u.name} se ha unido`);
        break;
      }

      case "user_left": {
        const u = ev.data as { name: string };
        usersInRoom = usersInRoom.filter(n => n !== u.name);
        log(`Sala: ${u.name} ha salido`);
        break;
      }

      case "ptt_started": {
        const u = ev.data as { name: string };
        log(`TX: ${u.name} transmitiendo`);
        break;
      }

      case "ptt_released": {
        const u = ev.data as { name: string };
        log(`TX: ${u.name} libero canal`);
        break;
      }

      case "audio": {
        const pkt = ev.data as Buffer;
        if (pkt.length < 1 + GSM_PACKET_BYTES) break;
        rxPackets++;
        // Inhibir VOX mientras reproducimos para evitar feedback acustico
        setRxActive();
        // Extraer 198 bytes GSM (sin el byte 0x01 del opcode)
        const gsm = Buffer.from(pkt.buffer, pkt.byteOffset + 1, GSM_PACKET_BYTES);
        audio.playGsm(gsm);
        break;
      }

      case "server_msg":
        log(`Mensaje servidor: ${ev.data}`);
        break;

      case "keepalive":
        // silencioso
        break;

      case "disconnected":
        log("Desconectado del servidor eQSO");
        scheduleReconnect();
        break;

      case "error":
        log(`Error TCP: ${ev.data}`);
        scheduleReconnect();
        break;
    }
  });

  client.connect();
}

function scheduleReconnect(): void {
  if (reconnectTimer) return; // ya programado
  eqsoClient = null;
  pttActive  = false;
  usersInRoom = [];
  reconnectAttempts++;

  const delay = Math.min(
    cfg.reconnectMinMs * Math.pow(2, Math.min(reconnectAttempts - 1, 5)),
    cfg.reconnectMaxMs
  );
  log(`Reintento #${reconnectAttempts} en ${Math.round(delay / 1000)}s…`);
  reconnectTimer = setTimeout(connect, delay);
}

// ─── Servidor de control HTTP ─────────────────────────────────────────────────

if (cfg.control.enabled) {
  startControlServer(cfg.control, {
    getStatus: (): RelayStatus => ({
      connected:          eqsoClient?.connected ?? false,
      callsign:           cfg.callsign,
      room:               cfg.room,
      server:             cfg.server,
      port:               cfg.port,
      pttActive,
      voxEnabled:         cfg.audio.vox,
      reconnectAttempts,
      uptimeMs:           Date.now() - startTime,
      rxPackets,
      txPackets,
      usersInRoom:        [...usersInRoom],
    }),
    forcePttStart: () => {
      log("Control HTTP: PTT ON forzado");
      vox.forcePttStart();
    },
    forcePttEnd: () => {
      log("Control HTTP: PTT OFF forzado");
      vox.forcePttEnd();
    },
    forceReconnect: () => {
      log("Control HTTP: reconexion forzada");
      eqsoClient?.disconnect();
      scheduleReconnect();
    },
  });
}

// ─── Arranque ─────────────────────────────────────────────────────────────────

log("=".repeat(60));
log(`eQSO Relay Daemon arrancado`);
log(`  Callsign : ${cfg.callsign}`);
log(`  Sala     : ${cfg.room}`);
log(`  Servidor : ${cfg.server}:${cfg.port}`);
log(`  VOX      : ${cfg.audio.vox ? `ON (umbral=${cfg.audio.voxThresholdRms} hang=${cfg.audio.voxHangMs}ms)` : "OFF"}`);
log(`  Captura  : ${cfg.audio.captureDevice}`);
log(`  Playback : ${cfg.audio.playbackDevice}`);
log("=".repeat(60));

audio.start();
connect();

// ─── Señales del sistema ──────────────────────────────────────────────────────

function shutdown(sig: string): void {
  log(`Señal ${sig} recibida — apagando…`);
  if (pttActive) { eqsoClient?.endTx(); }
  eqsoClient?.disconnect();
  audio.stop();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));

// Reconexion manual via SIGUSR1 (ej: kill -USR1 <pid>)
process.on("SIGUSR1", () => {
  log("SIGUSR1: reconexion manual");
  eqsoClient?.disconnect();
  scheduleReconnect();
});

function log(msg: string): void {
  console.log(`[main] ${new Date().toISOString()} ${msg}`);
}
