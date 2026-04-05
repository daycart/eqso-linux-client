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

const EQSO_TCP_PORT = Number(process.env.EQSO_TCP_PORT ?? 2171);
startTcpServer(EQSO_TCP_PORT);

// Also listen on 8008 (ASORAPA-compatible port) so clients configured
// for that port can connect alongside the standard eQSO 2171 port.
const EQSO_TCP_PORT_ALT = Number(process.env.EQSO_TCP_PORT_ALT ?? 8008);
if (EQSO_TCP_PORT_ALT !== EQSO_TCP_PORT) {
  startTcpServer(EQSO_TCP_PORT_ALT);
}
