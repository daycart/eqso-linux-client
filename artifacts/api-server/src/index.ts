import http from "http";
import app from "./app";
import { logger } from "./lib/logger";
import { startTcpServer } from "./eqso/tcp-server";
import { startWsBridge } from "./eqso/ws-bridge";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const httpServer = http.createServer(app);

startWsBridge(httpServer);

httpServer.listen(port, (err?: Error) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }
  logger.info({ port }, "HTTP + WebSocket server listening");
});

const EQSO_TCP_PORT = 2171;
startTcpServer(EQSO_TCP_PORT);
