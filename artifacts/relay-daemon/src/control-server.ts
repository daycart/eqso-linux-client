/**
 * Servidor HTTP de control — escucha en 127.0.0.1:8009 (por defecto).
 *
 * Endpoints:
 *   GET  /status      → JSON con estado actual del enlace
 *   POST /ptt/start   → Fuerza PTT ON  (ignorado si VOX esta activo)
 *   POST /ptt/end     → Fuerza PTT OFF
 *   POST /reconnect   → Fuerza reconexion al servidor eQSO
 */

import http from "http";
import { ControlConfig } from "./config.js";

export interface RelayStatus {
  connected: boolean;
  callsign: string;
  room: string;
  server: string;
  port: number;
  pttActive: boolean;
  voxEnabled: boolean;
  reconnectAttempts: number;
  uptimeMs: number;
  rxPackets: number;
  txPackets: number;
  usersInRoom: string[];
}

type Callback = {
  getStatus: () => RelayStatus;
  forcePttStart: () => void;
  forcePttEnd: () => void;
  forceReconnect: () => void;
};

export function startControlServer(cfg: ControlConfig, cb: Callback): http.Server {
  const server = http.createServer((req, res) => {
    const method = req.method ?? "GET";
    const url    = req.url ?? "/";

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

  server.listen(cfg.port, cfg.host, () => {
    log(`Control HTTP escuchando en http://${cfg.host}:${cfg.port}`);
  });

  server.on("error", (err) => {
    log(`Error al iniciar servidor de control: ${err.message}`);
  });

  return server;
}

function log(msg: string): void { console.log(`[control] ${new Date().toISOString()} ${msg}`); }
