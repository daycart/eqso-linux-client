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
// El relay NO recibe su propio audio de vuelta del servidor (el TCP server
// excluye al emisor de broadcastToTcpAndRelays con excludeId=state.id). Por
// tanto, el relay nunca reproduce su propio eco. Sin embargo, durante el
// voxHangMs (3s), el VOX mantiene pttActive=true y el TX_GATE impide enviar
// silencio. Cuando el VOX baja el PTT, el servidor puede tener paquetes del
// relay en el decoder queue de FFmpeg; con el flush del servidor esos paquetes
// llegan al navegador antes que ptt_released_remote. POST_TX_SUPPRESS_MS es
// el margen de guarda para descartar paquetes del servidor entre el 0x0d del
// relay y cualquier audio residual de red. 800ms es suficiente.
let postTxSuppressUntil = 0;
const POST_TX_SUPPRESS_MS = 800;

// ─── Supresion post-RX (anti-feedback acustico tras reproduccion) ─────────────
// Tras terminar de reproducir audio del servidor (web client, etc.), el altavoz
// del CM108 deja eco residual en la sala. Cuando arecord captura ese eco
// (full duplex: arecord siempre activo), el VOX puede dispararse con ruido.
// Inhibimos el VOX durante este margen despues de que rxActive baje a false.
let postRxVoxSuppressUntil = 0;
// 3000ms: 300ms drain aplay + ~700ms hardware + 2000ms margen acustico.
// Con 1500ms el relay volvía a transmitir demasiado pronto y el altavoz CB
// seguía con eco residual → bucle TX→RX→TX. Con 3s el eco se disipa
// completamente antes de re-habilitar el VOX.
const POST_RX_SUPPRESS_MS = 3000;

// ─── Supresion VOX post-TX propio (anti-eco de squelch y canal CB) ────────────
// Cuando el relay termina su propia TX (VOX ptt_end), la radio vuelve a modo
// RX y puede capturar:
//   1. El "clic" de squelch de la radio al abrir desde TX→RX (~100-300ms).
//   2. Eco residual del canal CB de la transmision anterior (~1-2s).
//   3. Eco acustico de la sala (altavoz → micro, ~200-500ms).
// Sin esta supresion, el VOX puede dispararse < 2s despues de soltar PTT y
// crear un bucle TX→silencio→TX que inunda el canal eQSO con ruido ("eco").
// Observado en logs: re-trigger a 1066ms pese a ventana de 1500ms → se sube
// a 5000ms para cubrir holgadamente todos los casos. En CB la pausa tipica
// entre transmisiones es >5s, por lo que no penaliza el uso normal.
const POST_TX_VOX_SUPPRESS_MS = 5000;

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
    // DIAGNÓSTICO: usar Math.max para NO reducir el suppress si post-TX lo fijó más largo.
    const rxSuppressUntil = Date.now() + POST_RX_SUPPRESS_MS;
    const prev = postRxVoxSuppressUntil;
    postRxVoxSuppressUntil = Math.max(postRxVoxSuppressUntil, rxSuppressUntil);
    log(`[rxInhibit] suppress: prev=${new Date(prev).toISOString()} new=${new Date(postRxVoxSuppressUntil).toISOString()}`);
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

  // Defensa en profundidad: doble verificacion del suppress.
  // El pcm_chunk verifica Date.now() > postRxVoxSuppressUntil antes de llamar
  // a vox.processPcm, pero puede haber una condicion de carrera si:
  //   1. rxInhibitTimer pone rxActive=false en el mismo tick que llega un pcm_chunk
  //   2. El suppress ya expiro pero el rxInhibitTimer lo extiende DESPUES del tick
  //   3. forcePttStart() desde control HTTP no verifica el suppress
  // En todos esos casos, bloqueamos aqui antes de abrir el TX.
  const now = Date.now();
  if (now < postRxVoxSuppressUntil) {
    log(`VOX: ptt_start BLOQUEADO — suppress activo hasta ${new Date(postRxVoxSuppressUntil).toISOString()} (restan ${postRxVoxSuppressUntil - now}ms)`);
    // Resetear VOX a false para que el proximo ciclo pueda re-evaluar cuando el suppress expire
    setTimeout(() => { if (!pttActive) vox.forcePttEnd(); }, 0);
    return;
  }

  pttActive = true;
  eqsoClient.startTx();
  log(`VOX: PTT activado — inicio transmision (suppress was ${new Date(postRxVoxSuppressUntil).toISOString()})`);
});

vox.on("ptt_end", () => {
  if (!eqsoClient?.connected || !pttActive) return;
  pttActive = false;
  audio.setTxEnabled(false);
  eqsoClient.endTx();
  // Descartar eco buffereado del servidor (800ms, sin afectar semi-duplex)
  postTxSuppressUntil = Date.now() + POST_TX_SUPPRESS_MS;
  // Suprimir VOX 5s tras TX propio (squelch + eco CB + eco sala).
  postRxVoxSuppressUntil = Math.max(postRxVoxSuppressUntil, Date.now() + POST_TX_VOX_SUPPRESS_MS);
  log(`VOX: PTT liberado — fin transmision (suppress hasta ${new Date(postRxVoxSuppressUntil).toISOString()})`);
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
  pttActive   = false;
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
        // Descartar si estamos en TX local (el servidor no nos manda nuestro
        // propio audio — excluye al emisor en broadcastToTcpAndRelays —, así
        // que el único audio que llega es de otros usuarios).
        // postTxSuppressUntil: guarda de 800ms tras endTx() por si el server
        // tiene paquetes de otros en tránsito que lleguen en ese momento.
        if (pttActive || Date.now() < postTxSuppressUntil) break;
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
