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
import { SerialPtt } from "./serial-ptt.js";
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
// tiempo + margen para que el sonido del altavoz no active el micro.
let rxActive = false;
let rxInhibitTimer: ReturnType<typeof setTimeout> | null = null;
// 400 ms: margen mínimo para que aplay drene su buffer ALSA antes de soltar
// el PTT hardware. Con AUDIO_PACE_MS=120ms el jitter de red es <100ms por lo
// que 400ms cubre cualquier rafaga de paquetes sin cortar el final del audio.
// Retardo total después de que el browser suelta PTT:
//   400ms hang + 500ms (kill aplay + reinicio arecord) = ~900ms hasta captura
const RX_HANG_MS = 400;

// ─── Supresion post-TX (anti-eco del servidor) ────────────────────────────────
// Tras liberarse el PTT, el servidor puede devolver los ultimos paquetes de
// audio buffereados (eco del propio relay). Descartamos mientras el servidor
// confirme que seguimos transmitiendo (serverOwnTx) o durante el margen de
// guarda. POST_TX_SUPPRESS_MS cubre la ventana entre endTx() local y que el
// servidor procese el 0x0d y mande ptt_released con nuestro callsign.
let postTxSuppressUntil = 0;
const POST_TX_SUPPRESS_MS = 800;
// Flag: el servidor nos ha confirmado que estamos transmitiendo (0x16 action=0x02
// con nuestro callsign). Mientras sea true, todos los paquetes de audio que
// recibamos son nuestro propio eco (el servidor re-emite nuestro audio a todos
// los clientes incluyendonos a nosotros mismos). Los descartamos sin reproducir.
let serverOwnTx = false;

// ─── Supresion post-RX (anti-feedback acustico tras reproduccion) ─────────────
// Tras terminar de reproducir audio del servidor (web client, etc.), el altavoz
// del CM108 deja eco residual en la sala. Cuando arecord se reanuda, el VOX
// puede capturar ese eco y disparar una transmision de ruido.
// Inhibimos el VOX durante este margen despues de que rxActive baje a false.
// 600 ms es suficiente para cubrir el reinicio de arecord (400 ms) + margen.
// Reducir de 1500 → 600 ms elimina el retraso excesivo de ~1.5 s.
let postRxVoxSuppressUntil = 0;
const POST_RX_SUPPRESS_MS = 600;

function setRxActive(): void {
  const wasActive = rxActive;
  rxActive = true;
  if (!wasActive) serialPtt.set(true); // activar PTT de la radio al inicio del RX
  if (rxInhibitTimer) clearTimeout(rxInhibitTimer);
  rxInhibitTimer = setTimeout(() => {
    rxActive = false;
    rxInhibitTimer = null;
    serialPtt.set(false); // liberar PTT de la radio al finalizar el RX
    audio.endRx();        // parar aplay para evitar underruns entre transmisiones
    // Extender inhibicion VOX: el altavoz deja eco residual en la sala que
    // arecord capturaría al reiniciarse (400ms) → VOX dispara ruido de fondo.
    postRxVoxSuppressUntil = Date.now() + POST_RX_SUPPRESS_MS;
  }, RX_HANG_MS);
}

// ─── PTT Serial (RTS/DTR en cable de control de la radio) ─────────────────────
const serialPtt = new SerialPtt(cfg.ptt);

// ─── Audio y VOX ─────────────────────────────────────────────────────────────
const audio = new AlsaAudio(cfg.audio);
const vox   = new Vox(cfg.audio.voxThresholdRms, cfg.audio.voxHangMs);

// Gate de transmision: nivel minimo para enviar audio al servidor.
// El VOX mantiene pttActive=true durante voxHangMs incluso cuando el nivel
// baja de voxThresholdRms. Durante ese hang, el audio puede estar en el rango
// 0-voxThreshold (ruido de fondo). Si se envía, el navegador acumula ruido en
// su cola y lo reproduce sobre el audio siguiente = "eco que pisa".
// TX_GATE = voxThreshold - 100: durante el hang prácticamente nada pasa
// (suelo RMS≈4-6), mientras que la voz activa (>voxThreshold) sí pasa.
// Derivarlo del config permite ajustar voxThreshold sin cambiar código.
const TX_GATE_RMS = Math.max(0, cfg.audio.voxThresholdRms - 100);
let latestPcmRms = 0;

// Errores de audio (ej: arecord crashea por ALSA no disponible).
// Sin este handler, Node.js lanzaría un uncaughtException → proceso crashea →
// systemd reinicia pero la conexion TCP al servidor se pierde temporalmente.
audio.on("error", (err: Error) => {
  log(`[audio] ERROR ALSA: ${err.message} — relay sigue activo, el audio se recuperará`);
  // No lanzar: arecord se reiniciará solo con backoff (2s) en alsa-audio.ts
});

// El audio emite chunks PCM crudos para que el VOX los analice
audio.on("pcm_chunk", (pcm: Int16Array) => {
  // Calcular RMS para el gate de transmision
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
  latestPcmRms = Math.sqrt(sum / pcm.length);

  if (cfg.audio.vox && !rxActive && Date.now() > postRxVoxSuppressUntil) {
    vox.processPcm(pcm);
  }
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
  // Marcar ventana de supresion para descartar el eco buffereado del servidor
  // sin activar el semi-duplex (que pararía arecord y cortaría la siguiente TX)
  postTxSuppressUntil = Date.now() + POST_TX_SUPPRESS_MS;
  log("VOX: PTT liberado — fin transmision");
});

// El audio emite paquetes GSM listos para enviar al servidor
audio.on("gsm_tx", (gsm: Buffer) => {
  if (!pttActive || !eqsoClient?.connected) return;
  // Gate de transmision: no enviar ruido de fondo durante el colgado del VOX.
  // Impide acumulacion de silencio en el buffer del navegador.
  if (latestPcmRms < TX_GATE_RMS) return;
  eqsoClient.sendAudio(gsm);
  txPackets++;
});

// ─── Conexion al servidor eQSO ────────────────────────────────────────────────

function connect(): void {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

  log(`Conectando a ${cfg.server}:${cfg.port} como "${cfg.callsign}" en sala "${cfg.room}"…`);

  const client = new EqsoClient(cfg.server, cfg.port);
  eqsoClient = client;
  pttActive    = false;
  serverOwnTx  = false;  // reset en cada reconexion: nueva sesion, sin eco previo
  usersInRoom  = [];

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
        // Si el servidor confirma que NOSOTROS estamos transmitiendo, los
        // paquetes de audio que lleguen a continuacion son nuestro propio eco
        // (el servidor re-distribuye a todos los clientes, incluyendonos).
        if (u.name === cfg.callsign) {
          serverOwnTx = true;
          log("ECO: servidor confirma TX propio — descartando audio entrante");
        }
        break;
      }

      case "ptt_released": {
        const u = ev.data as { name: string };
        log(`TX: ${u.name} libero canal`);
        // El servidor ha confirmado que terminamos de transmitir. Armamos la
        // ventana de guarda (POST_TX_SUPPRESS_MS) por si llegan paquetes
        // residuales entre este evento y el siguiente paquete de audio real.
        if (u.name === cfg.callsign) {
          serverOwnTx = false;
          postTxSuppressUntil = Date.now() + POST_TX_SUPPRESS_MS;
          log("ECO: servidor confirma TX liberado — ventana post-TX activa");
        }
        break;
      }

      case "audio": {
        const pkt = ev.data as Buffer;
        if (pkt.length < 1 + GSM_PACKET_BYTES) break;
        rxPackets++;
        // Descartar eco propio: durante TX local o mientras el servidor confirme
        // que seguimos en TX (serverOwnTx) o en ventana post-TX.
        // pttActive: TX local ya iniciado pero quizas el servidor no ha mandado
        //            ptt_started aun (race condition de red).
        // serverOwnTx: el servidor nos ha confirmado en TX → todos los paquetes
        //              de audio que llegan son nuestro propio eco devuelto.
        // postTxSuppressUntil: guarda de 800ms tras ptt_released del servidor,
        //              por si llegan paquetes residuales ya en transito.
        if (pttActive || serverOwnTx || Date.now() < postTxSuppressUntil) break;
        // Modo sin altavoz (outputGain=0): descartar silenciosamente sin activar
        // el semi-duplex ni el temporizador RX. arecord corre continuamente y
        // el VOX detecta la radio CB sin ningun retraso ni inhibicion.
        if (cfg.audio.outputGain === 0) break;
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
log(`  PTT Ser. : ${cfg.ptt.device ? `${cfg.ptt.device} (${cfg.ptt.method}${cfg.ptt.inverted ? ", invertido" : ""})` : "deshabilitado"}`);
log("=".repeat(60));

if (cfg.ptt.device) serialPtt.start();
audio.start();
connect();

// ─── Señales del sistema ──────────────────────────────────────────────────────

function shutdown(sig: string): void {
  log(`Señal ${sig} recibida — apagando…`);
  if (pttActive) { eqsoClient?.endTx(); }
  eqsoClient?.disconnect();
  serialPtt.stop();
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
