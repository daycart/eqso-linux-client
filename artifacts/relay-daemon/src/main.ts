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

// ─── Supresion post-TX (descartar audio del servidor tras soltar VOX) ─────────
// El relay NO recibe su propio eco (broadcastToTcpAndRelays excluye al emisor).
// PERO sí recibe el pitido de cortesía del servidor. Medido en logs: llega entre
// 600-800ms tras el 0x0d (jitter de red + procesamiento del servidor variable).
// Con 1500ms descartamos el pitido de cortesía con margen de seguridad amplio.
// Sin esta ventana: pitido → setRxActive() → aplay → squelch click → falso VOX
// → segundo pitido de cortesía (doble beep audible en el cliente web).
let postTxSuppressUntil = 0;
const POST_TX_SUPPRESS_MS = 1500;

// ─── Supresion post-RX (anti-feedback acustico tras reproduccion) ─────────────
// Tras terminar de reproducir audio del servidor, la radio CB necesita tiempo
// para volver a RX y que arecord se reinicie (~350ms).
// El suppress se calcula en dos etapas:
//   1. POST_RX_SUPPRESS_MS (800ms) desde que el rxInhibitTimer dispara.
//      Cubre el tiempo de drain de aplay y reinicio de arecord (~750ms).
//   2. POST_APLAY_VOX_SUPPRESS_MS (3000ms) desde que aplay REALMENTE cierra
//      (evento "playback_ended"). Cubre la cola de squelch de la radio CB
//      (~2-3s de ruido cuando vuelve a RX) que provoca falsos VOX.
// Medido en logs: RMS=13883 durante 2-3s tras fin de aplay con 1500ms no era
// suficiente (suppress expiraba antes de que el squelch de la CB cerrara).
let postRxVoxSuppressUntil = 0;
const POST_RX_SUPPRESS_MS          = 800;   // desde rxInhibitTimer
const POST_APLAY_VOX_SUPPRESS_MS   = 5000;  // desde cierre real de aplay (antes 3000ms)

// ─── Supresion VOX post-TX propio (anti-eco de squelch y canal CB) ────────────
// Cuando el relay termina su propia TX (VOX ptt_end), la radio vuelve a RX y
// puede capturar la cola de squelch CB (~2-3s de ruido/carrier residual).
// Medido en logs: RMS=11130 a los 3s de soltar PTT → trigger falso con 3000ms.
// El squelch de la CB tarda >3s en cerrarse completamente; 5000ms lo cubre.
const POST_TX_VOX_SUPPRESS_MS = 5000;  // antes 3000ms

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
const vox   = new Vox(cfg.audio.voxThresholdRms, cfg.audio.voxHangMs, cfg.audio.voxDebounceChunks ?? 5);

// Gate de transmision: nivel mínimo para enviar un paquete.
// Evita enviar silencio absoluto durante el colgado del VOX.
// Valor por defecto 50 (muy bajo): no corta voz suave pero descarta silencio
// total (suelo RMS≈4-6 sin señal). Configurable en txGateRms.
const TX_GATE_RMS = cfg.audio.txGateRms ?? 50;
let latestPcmRms = 0;

// Errores de audio (ej: arecord crashea por ALSA no disponible).
// Sin este handler, Node.js lanzaría un uncaughtException → proceso crashea →
// systemd reinicia pero la conexion TCP al servidor se pierde temporalmente.
audio.on("error", (err: Error) => {
  log(`[audio] ERROR ALSA: ${err.message} — relay sigue activo, el audio se recuperará`);
  // No lanzar: arecord se reiniciará solo con backoff (2s) en alsa-audio.ts
});

// Cuando aplay termina REALMENTE y arecord va a reiniciarse:
// extender suppress VOX 1.5s desde ese momento exacto para cubrir la cola
// de squelch de la radio CB (~1-2s de ruido al volver a RX).
audio.on("playback_ended", () => {
  const suppUntil = Date.now() + POST_APLAY_VOX_SUPPRESS_MS;
  const prev = postRxVoxSuppressUntil;
  postRxVoxSuppressUntil = Math.max(postRxVoxSuppressUntil, suppUntil);
  log(`[rxInhibit] playback_ended: suppress extendido → ${new Date(postRxVoxSuppressUntil).toISOString()} (prev=${new Date(prev).toISOString()})`);
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
    // Resetear estado VOX sin emitir ptt_end: evita que el TX se bloquee
    // ni que postTxSuppressUntil/postRxVoxSuppressUntil se extiendan.
    // pttActive permanece false → el audio eQSO->CB sigue funcionando.
    vox.resetState();
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
        if (pkt.length < 1 + GSM_PACKET_BYTES) {
          log(`[audio] pkt demasiado corto: ${pkt.length} bytes (esperado ${1 + GSM_PACKET_BYTES})`);
          break;
        }
        rxPackets++;
        // Descartar si estamos en TX local (el servidor no nos manda nuestro
        // propio audio — excluye al emisor en broadcastToTcpAndRelays —, así
        // que el único audio que llega es de otros usuarios).
        // postTxSuppressUntil: guarda de 800ms tras endTx() por si el server
        // tiene paquetes de otros en tránsito que lleguen en ese momento.
        if (pttActive) {
          if (rxPackets <= 3 || rxPackets % 20 === 0)
            log(`[audio] pkt#${rxPackets} DESCARTADO — pttActive=true (TX local activo)`);
          break;
        }
        const suppRestMs = postTxSuppressUntil - Date.now();
        if (suppRestMs > 0) {
          if (rxPackets <= 3 || rxPackets % 20 === 0)
            log(`[audio] pkt#${rxPackets} DESCARTADO — postTxSuppress en ${suppRestMs}ms`);
          break;
        }
        // Modo sin altavoz (outputGain=0): descartar silenciosamente sin activar
        // el semi-duplex ni el temporizador RX. arecord corre continuamente y
        // el VOX detecta la radio CB sin ningun retraso ni inhibicion.
        if (cfg.audio.outputGain === 0) break;
        // Inhibir VOX mientras reproducimos para evitar feedback acustico
        setRxActive();
        // Extraer 198 bytes GSM (sin el byte 0x01 del opcode)
        const gsm = Buffer.from(pkt.buffer, pkt.byteOffset + 1, GSM_PACKET_BYTES);
        audio.playGsm(gsm);
        if (rxPackets <= 3 || rxPackets % 50 === 0)
          log(`[audio] pkt#${rxPackets} → playGsm OK (pttActive=${pttActive} rxActive=${rxActive})`);
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
log(`  VOX      : ${cfg.audio.vox ? `ON (umbral=${cfg.audio.voxThresholdRms} hang=${cfg.audio.voxHangMs}ms debounce=${cfg.audio.voxDebounceChunks ?? 5}chunks)` : "OFF"}`);
log(`  Captura  : ${cfg.audio.captureDevice}`);
log(`  Playback : ${cfg.audio.playbackDevice}`);
log(`  PTT Ser. : ${cfg.ptt.device ? `${cfg.ptt.device} (${cfg.ptt.method}${cfg.ptt.inverted ? ", invertido" : ""})` : "deshabilitado"}`);
log("=".repeat(60));

if (cfg.ptt.device) serialPtt.start();
audio.start();
connect();

// ─── Señales del sistema ──────────────────────────────────────────────────────

async function shutdown(sig: string): Promise<void> {
  log(`Señal ${sig} recibida — apagando (graceful)…`);
  if (pttActive) { eqsoClient?.endTx(); }
  eqsoClient?.disconnect();
  serialPtt.stop();
  // Esperar a que aplay vacie su buffer DMA antes de salir.
  // Esto evita el D-state: si process.exit() ocurriera mientras aplay
  // esta escribiendo al USB (DMA transfer), el kernel entraria en D-state.
  await audio.stop();
  log("Apagado completado.");
  process.exit(0);
}

process.on("SIGTERM", () => { shutdown("SIGTERM").catch(() => process.exit(1)); });
process.on("SIGINT",  () => { shutdown("SIGINT").catch(() => process.exit(1)); });

// Reconexion manual via SIGUSR1 (ej: kill -USR1 <pid>)
process.on("SIGUSR1", () => {
  log("SIGUSR1: reconexion manual");
  eqsoClient?.disconnect();
  scheduleReconnect();
});

function log(msg: string): void {
  console.log(`[main] ${new Date().toISOString()} ${msg}`);
}
