import { IncomingMessage, Server as HttpServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "crypto";
import { logger } from "../lib/logger";
import { roomManager } from "./room-manager";
import {
  buildRoomList,
  buildUserList,
  buildUserJoined,
  buildUserLeft,
  buildPttStarted,
  buildPttReleased,
  buildErrorMessage,
  buildServerInfo,
  AUDIO_PAYLOAD_SIZE,
  KEEPALIVE_PACKET,
} from "./protocol";

const SERVER_VERSION = "eQSO Linux Server v1.0 (WebSocket)";
const KEEPALIVE_MS = 30_000;

interface WsMessage {
  type: "join" | "ptt_start" | "ptt_end" | "ping";
  name?: string;
  room?: string;
  message?: string;
  password?: string;
}

function safeWsSend(ws: WebSocket, data: Buffer | string): void {
  if (ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(data);
    } catch {
    }
  }
}

function sendJson(ws: WebSocket, obj: object): void {
  safeWsSend(ws, JSON.stringify(obj));
}

function sendRoomListWs(ws: WebSocket): void {
  const rooms = roomManager.getRooms();
  sendJson(ws, { type: "room_list", rooms });
}

function sendStats(ws: WebSocket): void {
  const stats = roomManager.getStats();
  sendJson(ws, { type: "stats", ...stats });
}

export function startWsBridge(httpServer: HttpServer): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

  wss.on("connection", (ws: WebSocket, _req: IncomingMessage) => {
    const id = randomUUID();
    logger.info({ id }, "New WebSocket eQSO client");

    const clientInfo = {
      id,
      name: `_WS_${id.slice(0, 6)}`,
      room: "",
      message: "",
      send: (data: Buffer) => {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(data);
          } catch {
          }
        }
      },
      close: () => ws.close(),
    };

    roomManager.addClient(clientInfo);

    sendRoomListWs(ws);
    sendJson(ws, { type: "server_info", message: SERVER_VERSION });

    const keepaliveTimer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        clearInterval(keepaliveTimer);
        return;
      }
      sendJson(ws, { type: "keepalive" });
    }, KEEPALIVE_MS);

    ws.on("message", (raw) => {
      try {
        if (raw instanceof Buffer && raw.length > 1 && raw[0] === 0x01) {
          const client = roomManager.getClient(id);
          if (client?.room) {
            const audioPkt = raw.length > AUDIO_PAYLOAD_SIZE + 1
              ? raw.slice(0, AUDIO_PAYLOAD_SIZE + 1)
              : raw;
            roomManager.broadcastToRoom(client.room, audioPkt as Buffer, id);
          }
          return;
        }

        const msg: WsMessage = JSON.parse(raw.toString());

        switch (msg.type) {
          case "join": {
            const name = (msg.name ?? "").trim().toUpperCase();
            const room = (msg.room ?? "GENERAL").trim().toUpperCase();
            const message = (msg.message ?? "").trim();

            if (!name || name.length > 20) {
              sendJson(ws, { type: "error", message: "Invalid callsign (max 20 chars)" });
              return;
            }
            if (!room || room.length > 20) {
              sendJson(ws, { type: "error", message: "Invalid room name (max 20 chars)" });
              return;
            }
            if (roomManager.isNameTaken(name, id)) {
              sendJson(ws, { type: "error", message: `Callsign "${name}" already in use` });
              return;
            }

            const ci = roomManager.getClient(id);
            if (ci) {
              ci.name = name;
              ci.message = message;
            }

            const oldRoom = ci?.room ?? "";
            const oldMembers = oldRoom ? roomManager.getRoomMembers(oldRoom) : [];

            roomManager.joinRoom(id, room);

            if (oldRoom && oldRoom !== room) {
              const leftPkt = buildUserLeft(name);
              for (const m of oldMembers) {
                if (m.id !== id) m.send(leftPkt);
              }
            }

            const members = roomManager.getRoomMembers(room);
            const memberData = members
              .filter((m) => m.id !== id)
              .map((m) => ({ name: m.name, message: m.message }));

            sendJson(ws, {
              type: "joined",
              room,
              name,
              members: memberData,
            });

            const joinedPkt = buildUserJoined(name, message);
            for (const m of members) {
              if (m.id !== id) m.send(joinedPkt);
            }

            logger.info({ id, name, room }, "WS client joined room");
            break;
          }

          case "ptt_start": {
            const client = roomManager.getClient(id);
            if (client?.room && client.name) {
              const locked = roomManager.tryLockRoom(client.room, id);
              if (locked) {
                const ptt = buildPttStarted(client.name);
                roomManager.broadcastToRoom(client.room, ptt, id);
                sendJson(ws, { type: "ptt_granted" });
              } else {
                sendJson(ws, { type: "ptt_denied", reason: "Channel busy" });
              }
            }
            break;
          }

          case "ptt_end": {
            const client = roomManager.getClient(id);
            if (client?.room && client.name) {
              const rel = buildPttReleased(client.name);
              roomManager.broadcastToRoom(client.room, rel, id);
              roomManager.unlockRoom(client.room, id);
              sendJson(ws, { type: "ptt_released" });
            }
            break;
          }

          case "ping":
            sendJson(ws, { type: "pong" });
            break;
        }
      } catch (err) {
        logger.warn({ err, id }, "WS message parse error");
      }
    });

    ws.on("close", () => {
      clearInterval(keepaliveTimer);
      const client = roomManager.getClient(id);
      if (client?.room && client.name) {
        const leftPkt = buildUserLeft(client.name);
        roomManager.broadcastToRoom(client.room, leftPkt, id);
      }
      roomManager.removeClient(id);
      logger.info({ id }, "WS client disconnected");
    });

    ws.on("error", (err) => {
      logger.warn({ err, id }, "WS error");
    });
  });

  logger.info("eQSO WebSocket bridge ready on /ws");
  return wss;
}
