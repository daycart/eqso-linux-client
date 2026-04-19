import { Router } from "express";
import express from "express";
import { db, usersTable } from "@workspace/db";
import { eq, ne } from "drizzle-orm";
import { requireAdmin } from "../lib/adminMiddleware";
import { hashPassword } from "../lib/auth";
import { roomManager } from "../eqso/room-manager";
import { inactivityManager } from "../eqso/inactivity-manager";
import { moderationManager } from "../eqso/moderation-manager";

const router = Router();
router.use(requireAdmin);

// GET /api/admin/users — all users, no passwords
router.get("/users", async (_req, res) => {
  try {
    const users = await db.select({
      id:        usersTable.id,
      callsign:  usersTable.callsign,
      isRelay:   usersTable.isRelay,
      status:    usersTable.status,
      role:      usersTable.role,
      createdAt: usersTable.createdAt,
      lastLogin: usersTable.lastLogin,
    }).from(usersTable).orderBy(usersTable.callsign);
    res.json(users);
  } catch {
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

// POST /api/admin/users — create user directly (active)
router.post("/users", async (req, res) => {
  try {
    const { callsign, password, isRelay = false, role = "user" } = req.body as {
      callsign: string;
      password: string;
      isRelay?: boolean;
      role?: string;
    };

    if (!callsign || !password) {
      res.status(400).json({ error: "Indicativo y contraseña son obligatorios" });
      return;
    }
    if (password.length < 4) {
      res.status(400).json({ error: "Contraseña mínimo 4 caracteres" });
      return;
    }
    const upper = callsign.trim().toUpperCase();
    if (!upper || upper.length > 20) {
      res.status(400).json({ error: "Indicativo inválido (máx 20 caracteres)" });
      return;
    }

    const existing = await db.select().from(usersTable).where(eq(usersTable.callsign, upper)).limit(1);
    if (existing.length > 0) {
      res.status(409).json({ error: `El indicativo "${upper}" ya existe` });
      return;
    }

    const passwordHash = await hashPassword(password);
    const newRole = role === "admin" ? "admin" : "user";
    await db.insert(usersTable).values({
      callsign: upper,
      passwordHash,
      isRelay: Boolean(isRelay),
      active: true,
      status: "active",
      role: newRole,
    });

    res.json({ callsign: upper, isRelay: Boolean(isRelay), status: "active", role: newRole });
  } catch {
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

// PATCH /api/admin/users/:id/status — approve / activate / deactivate
router.patch("/users/:id/status", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { status } = req.body as { status: string };

    if (!["active", "inactive", "pending"].includes(status)) {
      res.status(400).json({ error: "Estado inválido (active | inactive | pending)" });
      return;
    }

    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, id)).limit(1);
    if (!user) {
      res.status(404).json({ error: "Usuario no encontrado" });
      return;
    }

    await db.update(usersTable)
      .set({ status, active: status === "active" })
      .where(eq(usersTable.id, id));

    res.json({ id, status });
  } catch {
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

// PATCH /api/admin/users/:id/relay — toggle radio-relay flag
router.patch("/users/:id/relay", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { isRelay } = req.body as { isRelay: boolean };

    if (typeof isRelay !== "boolean") {
      res.status(400).json({ error: "isRelay debe ser true o false" });
      return;
    }

    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, id)).limit(1);
    if (!user) {
      res.status(404).json({ error: "Usuario no encontrado" });
      return;
    }

    await db.update(usersTable).set({ isRelay }).where(eq(usersTable.id, id));
    res.json({ id, isRelay });
  } catch {
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

// PATCH /api/admin/users/:id/role — change role
router.patch("/users/:id/role", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { role } = req.body as { role: string };

    if (!["admin", "user"].includes(role)) {
      res.status(400).json({ error: "Rol inválido (admin | user)" });
      return;
    }

    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, id)).limit(1);
    if (!user) {
      res.status(404).json({ error: "Usuario no encontrado" });
      return;
    }

    await db.update(usersTable).set({ role }).where(eq(usersTable.id, id));
    res.json({ id, role });
  } catch {
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

// DELETE /api/admin/users/:id — delete user
router.delete("/users/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);

    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, id)).limit(1);
    if (!user) {
      res.status(404).json({ error: "Usuario no encontrado" });
      return;
    }

    await db.delete(usersTable).where(eq(usersTable.id, id));
    res.json({ deleted: true, callsign: user.callsign });
  } catch {
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

// PATCH /api/admin/users/:id/password — reset password
router.patch("/users/:id/password", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { password } = req.body as { password: string };

    if (!password || password.length < 4) {
      res.status(400).json({ error: "Contraseña mínimo 4 caracteres" });
      return;
    }

    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, id)).limit(1);
    if (!user) {
      res.status(404).json({ error: "Usuario no encontrado" });
      return;
    }

    const passwordHash = await hashPassword(password);
    await db.update(usersTable).set({ passwordHash }).where(eq(usersTable.id, id));
    res.json({ updated: true });
  } catch {
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

// GET /api/admin/server/status — live server stats (includes mutes and bans)
router.get("/server/status", (_req, res) => {
  const status = roomManager.getServerStatus();
  res.json({
    ...status,
    mutes: moderationManager.getMutes(),
    bans:  moderationManager.getBans(),
  });
});

// POST /api/admin/server/enable
router.post("/server/enable", (_req, res) => {
  roomManager.enable();
  res.json({ enabled: true });
});

// POST /api/admin/server/disable
router.post("/server/disable", (_req, res) => {
  roomManager.disable();
  res.json({ enabled: false });
});

// ── Inactivity management ──────────────────────────────────────────────────────

// GET /api/admin/inactivity — get current config
router.get("/inactivity", (_req, res) => {
  res.json(inactivityManager.getConfig());
});

// PATCH /api/admin/inactivity — update config (enabled, timeoutMinutes)
router.patch("/inactivity", (req, res) => {
  const { enabled, timeoutMinutes } = req.body as { enabled?: boolean; timeoutMinutes?: number };
  if (enabled !== undefined) inactivityManager.setEnabled(Boolean(enabled));
  if (timeoutMinutes !== undefined) inactivityManager.setTimeoutMinutes(Number(timeoutMinutes));
  res.json(inactivityManager.getConfig());
});

// POST /api/admin/inactivity/trigger — manually play the announcement in a room
router.post("/inactivity/trigger", async (req, res) => {
  const { room } = req.body as { room?: string };
  const rooms = roomManager.getRooms();
  const target = room ?? rooms[0];
  if (!target) {
    res.status(400).json({ error: "No hay salas activas" });
    return;
  }
  const members = roomManager.getRoomMembers(target);
  try {
    await inactivityManager.trigger(target);
    res.json({ ok: true, room: target, members: members.length });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── Moderación — Mutes ────────────────────────────────────────────────────────

// POST /api/admin/moderation/mute — silenciar indicativo
// Body: { callsign: string, durationMs: number | null }  (null = permanente)
router.post("/moderation/mute", (req, res) => {
  const { callsign, durationMs } = req.body as { callsign?: string; durationMs?: number | null };
  if (!callsign) { res.status(400).json({ error: "Falta callsign" }); return; }
  moderationManager.mute(callsign, durationMs ?? null);
  res.json({ ok: true });
});

// DELETE /api/admin/moderation/mute/:callsign — quitar silencio
router.delete("/moderation/mute/:callsign", (req, res) => {
  moderationManager.unmute(req.params["callsign"]);
  res.json({ ok: true });
});

// ── Moderación — Bans ─────────────────────────────────────────────────────────

// POST /api/admin/moderation/ban — banear indicativo
// Body: { callsign: string, reason?: string }
router.post("/moderation/ban", async (req, res) => {
  const { callsign, reason } = req.body as { callsign?: string; reason?: string };
  if (!callsign) { res.status(400).json({ error: "Falta callsign" }); return; }
  try {
    await moderationManager.ban(callsign, reason ?? "", "admin");
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// DELETE /api/admin/moderation/ban/:callsign — desbanear indicativo
router.delete("/moderation/ban/:callsign", async (req, res) => {
  try {
    await moderationManager.unban(req.params["callsign"]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── Moderación — Kick ─────────────────────────────────────────────────────────

// POST /api/admin/moderation/kick/:clientId — expulsar cliente conectado
router.post("/moderation/kick/:clientId", (req, res) => {
  moderationManager.kickClient(req.params["clientId"]);
  res.json({ ok: true });
});

// POST /api/admin/inactivity/audio — upload WAV file (raw body, Content-Type: audio/wav)
router.post(
  "/inactivity/audio",
  express.raw({ type: ["audio/wav", "audio/wave", "application/octet-stream"], limit: "20mb" }),
  async (req, res) => {
    try {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        res.status(400).json({ error: "Cuerpo vacío o tipo incorrecto" });
        return;
      }
      await inactivityManager.saveAudioFile(req.body as Buffer);
      res.json({ ok: true, bytes: (req.body as Buffer).length });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  }
);

export default router;
