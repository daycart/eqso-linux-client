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
import { AlsaAudio, GSM_SILENCE_FRAME } from "./alsa-audio.js";
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
let shutdownStarted = false;
let lastPttIgnoredLogMs = 0;   // Throttle del log "ptt_start ignorado" (max 1/s)

// ─── Time-Out Timer de TX (TOT) ──────────────────────────────────────────────
// El servidor eQSO 193.152.83.229 desconecta al relay tras ~70s de TX continuo.
// Para evitarlo, el relay libera el PTT a los 55s y aplica una pausa de 4s
// (postRxVoxSuppressUntil) antes de permitir nuevo TX.
const TOT_MAX_MS   = 55_000;  // 55s de TX máximo (margen ante ~70s del servidor)
const TOT_BREAK_MS =  4_000;  // Pausa mínima entre TXs (servidor exige descanso)
let txTotTimer: ReturnType<typeof setTimeout> | null = null;

// ─── Backoff exponencial por fallos TX consecutivos ────────────────────────
// Si el servidor desconecta repetidamente durante TX (en <10s), aplicar
// suppress creciente para darle tiempo de "limpiar" la sesión anterior.
// Base: TOT_BREAK_MS, duplicando con cada fallo hasta TX_FAIL_MAX_SUPPRESS_MS.
// Se resetea cuando una TX dura >TX_SUCCESS_MIN_MS sin desconexion del servidor.
const TX_FAIL_MAX_SUPPRESS_MS = 60_000;  // máximo 60s de pausa tras fallos
// TX >3.5s = "exitosa": el timer del servidor corta a los 4-9s, esas TXes NO deben
// incrementar el streak (de lo contrario el backoff bloquea el VOX por 4-16s).
const TX_SUCCESS_MIN_MS       = 3_500;
let txDisconnectStreak = 0;   // fallos TX consecutivos (servidor corta en <3.5s)
let txStartedAt       = 0;   // timestamp de inicio de TX actual
// El servidor 193.152.83.229 tiene un timer de sesion (~4-9s durante TX).
// Cuando expira, busca 0x1a en el stream GSM → "Indicativo/Nombre invalido".
// Solución: renovar sesion proactivamente con JOIN cada SESSION_RENEWAL_MS ms,
// y re-anunciar PTT cuando el servidor confirme con room_list.
const SESSION_RENEWAL_MS = 2500;
let sessionRenewalTimer: ReturnType<typeof setInterval> | null = null;
// true entre el envio de JOIN de renovacion y la confirmacion del servidor (room_list).
// Durante este estado, 0x08 y audio entrante NO llaman yieldTx() (son transitorios).
let renewingSession = false;

// ─── Reconexion por idle (prevenir timeout de sesion del servidor) ────────────
// Sin [0x02] heartbeat, el servidor externo cierra la conexion tras ~30-35s
// de inactividad post-TX. Reconectamos proactivamente antes de ese umbral.
const IDLE_RECONNECT_MS = 28_000; // 28s < timeout servidor observado (~34s)
let idleReconnectTimer: ReturnType<typeof setTimeout> | null = null;

function resetIdleTimer(): void {
  if (idleReconnectTimer) clearTimeout(idleReconnectTimer);
  idleReconnectTimer = setTimeout(() => {
    idleReconnectTimer = null;
    if (pttActive) return; // no reconectar durante TX activo
    log("Reconectando por inactividad prolongada (prevenir timeout servidor)…");
    eqsoClient?.disconnect();
  }, IDLE_RECONNECT_MS);
}

function cancelIdleTimer(): void {
  if (idleReconnectTimer) { clearTimeout(idleReconnectTimer); idleReconnectTimer = null; }
}

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
// IMPORTANTE: el suppress que aplica el rxInhibitTimer debe ser al menos
// igual a POST_APLAY_VOX_SUPPRESS_MS para cubrir ráfagas cortas (< 1s) en
// las que playback_ended llega DESPUÉS de que este suppress expira.
// Sin esto el VOX disparaba 24ms después de una ventana de solo 800ms.
// POST_APLAY_VOX_SUPPRESS_MS se define más abajo; se declara aquí la referencia.

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
// El suppress se aplica en DOS momentos, ambos con POST_APLAY_VOX_SUPPRESS_MS:
//   1. Cuando el rxInhibitTimer dispara (400ms tras el último paquete RX):
//      se aplican 2500ms de suppress inmediatamente. Esto cubre ráfagas cortas
//      (< 1s) donde "playback_ended" llega tarde — sin esto el VOX disparaba
//      24ms después de expirar un suppress de solo 800ms (observado en logs).
//   2. Cuando aplay REALMENTE cierra ("playback_ended"): se extienden otros
//      2500ms desde ese momento. Para ráfagas largas donde aplay tarda más,
//      esto garantiza la supresión del squelch de la radio CB (~2-3s de ruido).
// Resultado: suppress mínimo garantizado = 400ms (hang) + 2500ms = 2.9s desde
// el último paquete RX, independientemente de cuándo expire aplay.
let postRxVoxSuppressUntil = 0;
const POST_APLAY_VOX_SUPPRESS_MS = 2500;  // usado en ambos momentos

// ─── Supresion VOX post-TX propio (anti-eco de squelch y canal CB) ────────────
// Cuando el relay termina su propia TX (VOX ptt_end), la radio vuelve a RX y
// puede capturar la cola de squelch CB (~2-3s de ruido/carrier residual).
// Medido en logs: RMS=11130 a los 3s de soltar PTT → trigger falso con 3000ms.
// Con squelch HW bien ajustado (RMS=2 en silencio), 2500ms es suficiente.
const POST_TX_VOX_SUPPRESS_MS = 2500;  // antes 5000ms (squelch HW ajustado)
// Suppress mínimo tras ceder el canal por 0x08 / colision de audio.
// Da tiempo para que el audio del otro usuario llegue y setRxActive() tome el
// control antes de que el VOX pueda retriggerear. Sin esto, el VOX dispara en
// <50ms → ciclo rápido 0x09→0x08→0x0d→0x09 que el servidor ve como spam.
// 2000ms es suficiente: el primer paquete de audio llega en <500ms normalmente.
const CHANNEL_YIELD_SUPPRESS_MS = 2_000;

// ─── Supresion VOX al arranque (burst de ruido de inicio ALSA) ───────────────
// Al inicializar arecord, ALSA emite un burst de ruido de fondo (~1-2s con
// chunks grandes de 1964/7680 bytes) que dispara el VOX falsamente.
// Ignoramos todo el audio VOX durante los primeros startupVoxSuppressMs ms.
// Se resetea en cada reinicio de arecord (xrun recovery) para cubrir el nuevo burst.
let startupSuppressUntil = Date.now() + cfg.audio.startupVoxSuppressMs;

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
    // Extender inhibicion VOX: usar POST_APLAY_VOX_SUPPRESS_MS (2500ms) y NO
    // POST_RX_SUPPRESS_MS (800ms). Motivo: para ráfagas cortas (< 1s) el evento
    // "playback_ended" puede llegar DESPUÉS de que los 800ms expiren, dejando
    // una ventana en la que el VOX dispara falsamente (observado: VOX a 24ms de
    // la expiración del suppress con ráfaga de 0.55s de 0R-DAVID_EA).
    // Al usar 2500ms aquí, "playback_ended" solo puede EXTENDER el suppress
    // si aplay tarda más; nunca lo recorta.
    const rxSuppressUntil = Date.now() + POST_APLAY_VOX_SUPPRESS_MS;
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

// Cuando arecord se reinicia (semi-duplex tras RX), NO reseteamos startupSuppressUntil.
// Motivo: postRxVoxSuppressUntil (2500ms) ya cubre el burst de inicio de ALSA
// (RMS≈1303, dura <1s). Resetear startupSuppressUntil (4000ms) aquí hace que
// expire 1.5s MÁS TARDE que postRxVoxSuppressUntil, eliminando la ventana de TX
// de la radio CB y haciendo imposible que el VOX dispare entre transmisiones eQSO.
audio.on("recorder_restarted", () => {
  log(`[vox] arecord reiniciado (semi-duplex) — postRxVoxSuppressUntil hasta ${new Date(postRxVoxSuppressUntil).toISOString()}`);
});

// El audio emite chunks PCM crudos para que el VOX los analice
audio.on("pcm_chunk", (pcm: Int16Array) => {
  // Calcular RMS para el gate de transmision
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
  latestPcmRms = Math.sqrt(sum / pcm.length);

  if (cfg.audio.vox && !rxActive && Date.now() > postRxVoxSuppressUntil && Date.now() > startupSuppressUntil) {
    vox.processPcm(pcm);
  }
});

// ─── TOT expirado: liberar PTT antes de que el servidor desconecte ───────────
function totExpired(): void {
  txTotTimer = null;
  stopSessionRenewalTimer();
  if (!pttActive || !eqsoClient?.connected) return;
  log(`[TOT] ${TOT_MAX_MS / 1000}s de TX máximo alcanzado — pausa forzada de ${TOT_BREAK_MS / 1000}s`);
  // 55s de TX = éxito: resetear el streak de fallos consecutivos
  if (txDisconnectStreak > 0) {
    log(`[TOT] TX exitosa (55s) — resetear streak (era ${txDisconnectStreak})`);
    txDisconnectStreak = 0;
  }
  txStartedAt = 0;
  pttActive = false;
  audio.setTxEnabled(false);
  eqsoClient.endTx();
  postTxSuppressUntil = Date.now() + POST_TX_SUPPRESS_MS;
  postRxVoxSuppressUntil = Math.max(postRxVoxSuppressUntil, Date.now() + TOT_BREAK_MS);
  resetIdleTimer();
  vox.resetState();
  const total = txRealFrames + txSilenceFrames;
  const silencePct = total > 0 ? Math.round((txSilenceFrames / total) * 100) : 0;
  log(`[TOT] frames: ${txRealFrames} real + ${txSilenceFrames} silencio = ${silencePct}% silencio`);
  txRealFrames = 0;
  txSilenceFrames = 0;
}

// ─── Renovacion proactiva de sesion TX ────────────────────────────────────────
// Flujo de renovacion:
//   1. Timer (cada 2.5s): sendJoin() + renewingSession=true
//   2. 0x08 / audio durante renewingSession: ignorar (son transitorios del handshake)
//   3. room_list: servidor confirmo JOIN → re-anunciar PTT (0x09) → renewingSession=false
// Si la renovacion tarda > SESSION_RENEWAL_MS, el siguiente tick la reintenta.
function startSessionRenewalTimer(): void {
  if (sessionRenewalTimer) { clearInterval(sessionRenewalTimer); sessionRenewalTimer = null; }
  sessionRenewalTimer = setInterval(() => {
    if (!pttActive || !eqsoClient?.connected) {
      stopSessionRenewalTimer();
      return;
    }
    renewingSession = true;
    log(`[session] Renovacion proactiva mid-TX (${SESSION_RENEWAL_MS}ms) — enviando JOIN`);
    eqsoClient.sendJoin(cfg.callsign, cfg.room, cfg.message, cfg.password);
    // PTT se re-anuncia cuando el servidor confirme con room_list (ver handler abajo).
  }, SESSION_RENEWAL_MS);
}

function stopSessionRenewalTimer(): void {
  if (sessionRenewalTimer) { clearInterval(sessionRenewalTimer); sessionRenewalTimer = null; }
  renewingSession = false;
}

// ─── Ceder canal (semi-duplex): otro usuario tiene el PTT ─────────────────────
// Llamado cuando el servidor señala canal ocupado (0x08) o manda audio durante TX.
// NO incrementa txDisconnectStreak (es una cesión voluntaria, no un fallo).
function yieldTx(): void {
  if (!pttActive) return;
  stopSessionRenewalTimer();
  if (txTotTimer) { clearTimeout(txTotTimer); txTotTimer = null; }
  const txDurationMs = txStartedAt > 0 ? Date.now() - txStartedAt : 0;
  txStartedAt = 0;
  pttActive = false;
  audio.setTxEnabled(false);
  eqsoClient?.endTx();
  // No bloquear postTxSuppressUntil: el audio del otro usuario debe reproducirse
  // inmediatamente. setRxActive() se encargará de inhibir el VOX mientras hablan.
  postTxSuppressUntil = 0;
  // Suppress mínimo de VOX para dar tiempo al audio del otro usuario a llegar:
  // sin esto el VOX retriggeraba en <50ms causando ciclo 0x09→0x08→0x0d→0x09.
  // setRxActive() extenderá el suppress cuando llegue el primer paquete de audio.
  postRxVoxSuppressUntil = Math.max(postRxVoxSuppressUntil, Date.now() + CHANNEL_YIELD_SUPPRESS_MS);
  resetIdleTimer();
  vox.resetState();
  log(`[semi-duplex] TX cedida (duró ${Math.round(txDurationMs / 1000)}s) — esperando canal libre`);
  const total = txRealFrames + txSilenceFrames;
  const silencePct = total > 0 ? Math.round((txSilenceFrames / total) * 100) : 0;
  if (total > 0)
    log(`[semi-duplex] frames: ${txRealFrames} real + ${txSilenceFrames} silencio = ${silencePct}% silencio`);
  txRealFrames = 0;
  txSilenceFrames = 0;
}

// Cuando el VOX o control HTTP activan PTT
vox.on("ptt_start", () => {
  if (!eqsoClient?.connected) {
    // Sin conexion: resetear VOX para evitar deadlock.
    // Si no se llama resetState(), vox.active queda en true y nunca vuelve
    // a emitir ptt_start (aunque el RMS siga sobre umbral) porque el VOX
    // cree que ya esta en TX. El resetState() permite que el debounce
    // vuelva a acumularse cuando la conexion se restablezca.
    vox.resetState();
    const nowMs = Date.now();
    if (nowMs - lastPttIgnoredLogMs > 1000) {
      lastPttIgnoredLogMs = nowMs;
      log("VOX: ptt_start ignorado — sin conexion, reseteando estado VOX");
    }
    return;
  }
  if (!eqsoClient.isReady()) {
    // TCP conectado pero JOIN aún no aceptado (handshake o room_list pendiente).
    // Enviar [0x09] ahora causaría "Indicativo invalido" + desconexión.
    // Resetear VOX para que vuelva a disparar cuando el servidor acepte el JOIN.
    vox.resetState();
    const nowMs = Date.now();
    if (nowMs - lastPttIgnoredLogMs > 1000) {
      lastPttIgnoredLogMs = nowMs;
      log("VOX: ptt_start ignorado — JOIN pendiente, reseteando estado VOX");
    }
    return;
  }
  if (pttActive || rxActive) return;

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
  txStartedAt = Date.now();
  cancelIdleTimer(); // No reconectar mientras transmitimos
  audio.setTxEnabled(true);
  eqsoClient.startTx();
  // Iniciar TOT: si TX supera TOT_MAX_MS, liberamos PTT para que el servidor
  // eQSO no nos desconecte por TX excesivo (~70s de timeout en 193.152.83.229).
  if (txTotTimer) clearTimeout(txTotTimer);
  txTotTimer = setTimeout(totExpired, TOT_MAX_MS);
  // Iniciar renovacion proactiva de sesion: el servidor tiene un timer ~4-9s
  // que expira durante TX y busca 0x1a en el stream GSM si no se renueva.
  startSessionRenewalTimer();
  log(`VOX: PTT activado — inicio transmision (suppress was ${new Date(postRxVoxSuppressUntil).toISOString()}, streak=${txDisconnectStreak})`);
});

vox.on("ptt_end", () => {
  if (!eqsoClient?.connected || !pttActive) return;
  if (txTotTimer) { clearTimeout(txTotTimer); txTotTimer = null; }
  stopSessionRenewalTimer();
  pttActive = false;
  audio.setTxEnabled(false);
  eqsoClient.endTx();
  // TX terminada por VOX hang-time (usuario soltó): si duró >10s sin que el
  // servidor desconectara, la TX fue exitosa → resetear streak de fallos.
  if (txStartedAt > 0 && Date.now() - txStartedAt >= TX_SUCCESS_MIN_MS) {
    if (txDisconnectStreak > 0) log(`[TOT] TX exitosa (${Math.round((Date.now()-txStartedAt)/1000)}s) — resetear streak (era ${txDisconnectStreak})`);
    txDisconnectStreak = 0;
  }
  txStartedAt = 0;
  // Descartar eco buffereado del servidor (800ms, sin afectar semi-duplex)
  postTxSuppressUntil = Date.now() + POST_TX_SUPPRESS_MS;
  // Suprimir VOX 5s tras TX propio (squelch + eco CB + eco sala).
  postRxVoxSuppressUntil = Math.max(postRxVoxSuppressUntil, Date.now() + POST_TX_VOX_SUPPRESS_MS);
  resetIdleTimer(); // Iniciar countdown de 28s post-TX para reconexion preventiva
  const total = txRealFrames + txSilenceFrames;
  const silencePct = total > 0 ? Math.round((txSilenceFrames / total) * 100) : 0;
  log(`VOX: PTT liberado — fin transmision (suppress hasta ${new Date(postRxVoxSuppressUntil).toISOString()}) | frames: ${txRealFrames} real + ${txSilenceFrames} silencio = ${silencePct}% silencio`);
  txRealFrames = 0;
  txSilenceFrames = 0;
});

// Contadores de diagnostico: real vs silence frames enviados durante TX
let txRealFrames    = 0;
let txSilenceFrames = 0;

// El audio emite paquetes GSM listos para enviar al servidor
audio.on("gsm_tx", (gsm: Buffer) => {
  if (!pttActive || !eqsoClient?.connected) return;
  // Gate de transmision: no enviar ruido de fondo durante el colgado del VOX.
  // Impide acumulacion de silencio en el buffer del navegador.
  if (latestPcmRms < TX_GATE_RMS) return;

  // Detectar si el frame es silencio (comparar con el frame precomputado)
  const isSilence = gsm.length === GSM_SILENCE_FRAME.length &&
    gsm.equals(GSM_SILENCE_FRAME as Buffer);
  if (isSilence) {
    txSilenceFrames++;
  } else {
    txRealFrames++;
  }

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
        resetIdleTimer(); // Iniciar countdown; se reinicia tras cada TX
        break;

      case "room_list":
        log(`Salas: ${(ev.data as string[]).join(", ")}`);
        if (renewingSession && pttActive && client.connected) {
          // El servidor confirmó el JOIN de renovacion → re-anunciar PTT.
          // startTx() verifica joinAccepted (que el parser ya puso en true al
          // parsear este room_list) y envía 0x09. Audio continúa sin interrupción.
          renewingSession = false;
          log("[session] Room list confirmó renovacion — re-anunciando PTT [0x09]");
          client.startTx();
        }
        break;

      case "user_joined": {
        const u = ev.data as { name: string; message: string };
        if (!usersInRoom.includes(u.name)) usersInRoom.push(u.name);
        log(`Sala: ${u.name} se ha unido`);
        resetIdleTimer(); // servidor activo — reiniciar countdown
        break;
      }

      case "user_left": {
        const u = ev.data as { name: string };
        usersInRoom = usersInRoom.filter(n => n !== u.name);
        log(`Sala: ${u.name} ha salido`);
        resetIdleTimer(); // servidor activo — reiniciar countdown
        break;
      }

      case "ptt_started": {
        const u = ev.data as { name: string };
        log(`TX: ${u.name} transmitiendo`);
        resetIdleTimer(); // servidor activo — reiniciar countdown
        break;
      }

      case "ptt_released": {
        const u = ev.data as { name: string };
        log(`TX: ${u.name} libero canal`);
        resetIdleTimer(); // servidor activo — reiniciar countdown
        break;
      }

      case "channel_busy": {
        // 0x08 del servidor = "canal ocupado, otro usuario tiene el PTT"
        if (renewingSession) {
          // Durante renovacion de sesion, 0x08 es esperado: el servidor está
          // reseteando el estado de TX. Ignorar — se re-anunciará PTT en room_list.
          log("[session] 0x08 durante renovacion de sesion — ignorado (esperando room_list)");
          break;
        }
        if (pttActive) {
          log("[semi-duplex] Canal ocupado [0x08] — cediendo TX al otro usuario");
          yieldTx();
        }
        break;
      }

      case "audio": {
        resetIdleTimer(); // paquete de audio = servidor activo — reiniciar countdown
        const pkt = ev.data as Buffer;
        if (pkt.length < 1 + GSM_PACKET_BYTES) {
          log(`[audio] pkt demasiado corto: ${pkt.length} bytes (esperado ${1 + GSM_PACKET_BYTES})`);
          break;
        }
        rxPackets++;
        // Si estamos TX y el servidor nos manda audio de otro usuario → colisión.
        // Ceder el canal: el otro usuario tiene prioridad (ya estaba TX antes).
        // EXCEPCIÓN: durante renovacion de sesion, el servidor puede mandar audio
        // brevemente antes de confirmar el JOIN (room_list). No ceder el canal.
        if (pttActive && !renewingSession) {
          if (rxPackets === 1)
            log(`[semi-duplex] Audio entrante durante TX — colision de canal, cediendo`);
          yieldTx();
          // No break: seguir al bloque de reproducción para silenciar el speaker
          // correctamente. yieldTx() pone pttActive=false, así el código abajo lo maneja.
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
        log("Keepalive recibido del servidor [0x0c]");
        resetIdleTimer(); // El servidor esta vivo — reiniciar countdown
        break;

      case "disconnected":
        cancelIdleTimer();
        if (txTotTimer) { clearTimeout(txTotTimer); txTotTimer = null; }
        stopSessionRenewalTimer();
        log("Desconectado del servidor eQSO");
        if (pttActive) {
          // El relay estaba transmitiendo cuando se perdió la conexión.
          // Aplicar suppress con backoff exponencial para romper el ciclo:
          //   1ª vez: 4s, 2ª: 8s, 3ª: 16s, 4ª: 32s, 5ª+: 60s
          // Esto da tiempo al servidor de liberar la sesión anterior antes
          // de que el relay vuelva a intentar TX tras reconectar.
          const txDurationMs = txStartedAt > 0 ? Date.now() - txStartedAt : 0;
          const isFastDisconnect = txDurationMs < TX_SUCCESS_MIN_MS;
          if (isFastDisconnect) {
            txDisconnectStreak++;
          } else {
            txDisconnectStreak = 0; // TX larga = exitosa, resetear streak
          }
          txStartedAt = 0;
          pttActive = false;
          audio.setTxEnabled(false);
          vox.resetState();
          // Backoff SOLO en fast-disconnect: TOT_BREAK_MS * 2^(streak-1)
          // Si la TX fue exitosa (>3.5s), NO aplicar suppress: el VOX puede
          // retrigger inmediatamente tras la reconexion (reconnectMinMs).
          let suppressMs = 0;
          if (isFastDisconnect) {
            suppressMs = Math.min(
              TOT_BREAK_MS * Math.pow(2, txDisconnectStreak - 1),
              TX_FAIL_MAX_SUPPRESS_MS,
            );
            postRxVoxSuppressUntil = Math.max(
              postRxVoxSuppressUntil,
              Date.now() + suppressMs,
            );
          }
          log(
            `[vox] PTT reseteado por desconexion (TX duró ${Math.round(txDurationMs/1000)}s, streak=${txDisconnectStreak}) — suppress ${Math.round(suppressMs/1000)}s`,
          );
        }
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
  if (shutdownStarted) return; // no reconectar durante apagado graceful
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
log(`  VOX Sup. : startup suppress ${cfg.audio.startupVoxSuppressMs}ms activo hasta ${new Date(startupSuppressUntil).toISOString()}`);
log("=".repeat(60));

if (cfg.ptt.device) serialPtt.start();
audio.start();
connect();

// ─── Señales del sistema ──────────────────────────────────────────────────────

async function shutdown(sig: string): Promise<void> {
  if (shutdownStarted) return; // evitar re-entrada si llegan dos señales
  shutdownStarted = true;
  log(`Señal ${sig} recibida — apagando (graceful)…`);
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
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
