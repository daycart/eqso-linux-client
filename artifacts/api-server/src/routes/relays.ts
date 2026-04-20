import { Router } from "express";
import { db, relayConnectionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAdmin } from "../lib/adminMiddleware";
import { relayManager } from "../eqso/relay-manager";

export const adminRelaysRouter = Router();
adminRelaysRouter.use(requireAdmin);

// GET /api/admin/relays
adminRelaysRouter.get("/relays", async (_req, res) => {
  try {
    const rows = await db.select().from(relayConnectionsTable).orderBy(relayConnectionsTable.id);
    const liveStatus = relayManager.getStatus();
    const statusById = new Map(liveStatus.map(s => [s.id, s]));

    res.json(rows.map(row => ({
      id:          row.id,
      label:       row.label,
      callsign:    row.callsign,
      server:      row.server,
      port:        row.port,
      localRoom:   row.localRoom,
      remoteRoom:  row.remoteRoom,
      password:    row.password,
      enabled:     row.enabled,
      createdAt:   row.createdAt,
      // live status fields (may be absent if manager not started yet)
      status:      statusById.get(row.id)?.status ?? "disconnected",
      remoteUsers: statusById.get(row.id)?.remoteUsers ?? [],
      rxPackets:   statusById.get(row.id)?.rxPackets ?? 0,
      txPackets:   statusById.get(row.id)?.txPackets ?? 0,
    })));
  } catch {
    res.status(500).json({ error: "Error interno" });
  }
});

// POST /api/admin/relays
adminRelaysRouter.post("/relays", async (req, res) => {
  try {
    const { label, callsign, server, port, localRoom, remoteRoom, password, enabled } = req.body as {
      label: string; callsign: string; server: string; port?: number;
      localRoom?: string; remoteRoom?: string; password?: string; enabled?: boolean;
    };

    if (!label?.trim()) return res.status(400).json({ error: "El nombre es obligatorio" });
    if (!callsign?.trim()) return res.status(400).json({ error: "El indicativo es obligatorio" });
    if (!server?.trim()) return res.status(400).json({ error: "El servidor es obligatorio" });

    const [row] = await db.insert(relayConnectionsTable).values({
      label:      label.trim(),
      callsign:   callsign.trim().toUpperCase(),
      server:     server.trim(),
      port:       port ? Number(port) : 2171,
      localRoom:  (localRoom ?? "CB").trim().toUpperCase(),
      remoteRoom: (remoteRoom ?? "CB").trim().toUpperCase(),
      password:   (password ?? "").trim(),
      enabled:    enabled === true,
    }).returning();

    await relayManager.reloadRelay(row.id);

    res.status(201).json(row);
  } catch {
    res.status(500).json({ error: "Error interno" });
  }
});

// PUT /api/admin/relays/:id
adminRelaysRouter.put("/relays/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { label, callsign, server, port, localRoom, remoteRoom, password, enabled } = req.body as {
      label: string; callsign: string; server: string; port?: number;
      localRoom?: string; remoteRoom?: string; password?: string; enabled?: boolean;
    };

    if (!label?.trim()) return res.status(400).json({ error: "El nombre es obligatorio" });
    if (!callsign?.trim()) return res.status(400).json({ error: "El indicativo es obligatorio" });
    if (!server?.trim()) return res.status(400).json({ error: "El servidor es obligatorio" });

    const [row] = await db.update(relayConnectionsTable).set({
      label:      label.trim(),
      callsign:   callsign.trim().toUpperCase(),
      server:     server.trim(),
      port:       port ? Number(port) : 2171,
      localRoom:  (localRoom ?? "CB").trim().toUpperCase(),
      remoteRoom: (remoteRoom ?? "CB").trim().toUpperCase(),
      password:   (password ?? "").trim(),
      enabled:    enabled === true,
    }).where(eq(relayConnectionsTable.id, id)).returning();

    if (!row) return res.status(404).json({ error: "Enlace no encontrado" });

    await relayManager.reloadRelay(id);

    res.json(row);
  } catch {
    res.status(500).json({ error: "Error interno" });
  }
});

// DELETE /api/admin/relays/:id
adminRelaysRouter.delete("/relays/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    relayManager.deleteRelay(id);
    await db.delete(relayConnectionsTable).where(eq(relayConnectionsTable.id, id));
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Error interno" });
  }
});

// POST /api/admin/relays/:id/start
adminRelaysRouter.post("/relays/:id/start", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [row] = await db.update(relayConnectionsTable)
      .set({ enabled: true })
      .where(eq(relayConnectionsTable.id, id))
      .returning();
    if (!row) return res.status(404).json({ error: "Enlace no encontrado" });
    await relayManager.reloadRelay(id);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Error interno" });
  }
});

// POST /api/admin/relays/:id/stop
adminRelaysRouter.post("/relays/:id/stop", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [row] = await db.update(relayConnectionsTable)
      .set({ enabled: false })
      .where(eq(relayConnectionsTable.id, id))
      .returning();
    if (!row) return res.status(404).json({ error: "Enlace no encontrado" });
    await relayManager.reloadRelay(id);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Error interno" });
  }
});
