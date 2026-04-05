import { Router } from "express";
import { roomManager } from "../eqso/room-manager";

const router = Router();

router.get("/status", (_req, res) => {
  res.json({
    status: "online",
    server: "eQSO Linux Server v1.0",
    tcpPort: 2171,
    ...roomManager.getStats(),
    rooms: roomManager.getRooms(),
  });
});

export default router;
