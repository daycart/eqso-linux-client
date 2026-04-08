/**
 * /api/servers  — public read
 * /api/admin/servers — admin CRUD (mounted via adminRouter)
 */
import { Router } from "express";
import { db, serversTable } from "@workspace/db";
import { eq, asc } from "drizzle-orm";
import { requireAdmin } from "../lib/adminMiddleware";

// ── Public router ─────────────────────────────────────────────────────────────
export const publicServersRouter = Router();

// GET /api/servers — returns active servers ordered by sortOrder
publicServersRouter.get("/servers", async (_req, res) => {
  try {
    const rows = await db
      .select()
      .from(serversTable)
      .where(eq(serversTable.isActive, true))
      .orderBy(asc(serversTable.sortOrder), asc(serversTable.id));
    res.json(rows.map(toClient));
  } catch {
    res.status(500).json({ error: "Error interno" });
  }
});

// ── Admin router ──────────────────────────────────────────────────────────────
export const adminServersRouter = Router();
adminServersRouter.use(requireAdmin);

// GET /api/admin/servers — all servers including inactive
adminServersRouter.get("/servers", async (_req, res) => {
  try {
    const rows = await db
      .select()
      .from(serversTable)
      .orderBy(asc(serversTable.sortOrder), asc(serversTable.id));
    res.json(rows.map(toClient));
  } catch {
    res.status(500).json({ error: "Error interno" });
  }
});

// POST /api/admin/servers — create
adminServersRouter.post("/servers", async (req, res) => {
  try {
    const { label, description, mode, host, port, defaultPassword, rooms, isActive, sortOrder } = req.body;
    if (!label?.trim()) return res.status(400).json({ error: "El nombre es obligatorio" });
    const [row] = await db.insert(serversTable).values({
      label:           label.trim(),
      description:     (description ?? "").trim(),
      mode:            mode ?? "remote",
      host:            host?.trim() || null,
      port:            port ? Number(port) : null,
      defaultPassword: defaultPassword?.trim() || null,
      rooms:           normalizeRooms(rooms),
      isActive:        isActive !== false,
      sortOrder:       sortOrder ? Number(sortOrder) : 0,
    }).returning();
    res.status(201).json(toClient(row));
  } catch {
    res.status(500).json({ error: "Error interno" });
  }
});

// PUT /api/admin/servers/:id — update
adminServersRouter.put("/servers/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { label, description, mode, host, port, defaultPassword, rooms, isActive, sortOrder } = req.body;
    if (!label?.trim()) return res.status(400).json({ error: "El nombre es obligatorio" });
    const [row] = await db
      .update(serversTable)
      .set({
        label:           label.trim(),
        description:     (description ?? "").trim(),
        mode:            mode ?? "remote",
        host:            host?.trim() || null,
        port:            port ? Number(port) : null,
        defaultPassword: defaultPassword?.trim() || null,
        rooms:           normalizeRooms(rooms),
        isActive:        isActive !== false,
        sortOrder:       sortOrder ? Number(sortOrder) : 0,
      })
      .where(eq(serversTable.id, id))
      .returning();
    if (!row) return res.status(404).json({ error: "Servidor no encontrado" });
    res.json(toClient(row));
  } catch {
    res.status(500).json({ error: "Error interno" });
  }
});

// DELETE /api/admin/servers/:id
adminServersRouter.delete("/servers/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    await db.delete(serversTable).where(eq(serversTable.id, id));
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Error interno" });
  }
});

// ── helpers ───────────────────────────────────────────────────────────────────
function normalizeRooms(rooms: unknown): string {
  if (Array.isArray(rooms)) return rooms.map((r) => String(r).trim()).filter(Boolean).join(",");
  if (typeof rooms === "string") return rooms.split(",").map((r) => r.trim()).filter(Boolean).join(",");
  return "";
}

function toClient(row: typeof serversTable.$inferSelect) {
  return {
    id:              String(row.id),
    label:           row.label,
    description:     row.description,
    mode:            row.mode as "local" | "remote",
    host:            row.host ?? undefined,
    port:            row.port ?? undefined,
    defaultPassword: row.defaultPassword ?? undefined,
    defaultRooms:    row.rooms ? row.rooms.split(",").filter(Boolean) : [],
    isActive:        row.isActive,
    sortOrder:       row.sortOrder,
  };
}
