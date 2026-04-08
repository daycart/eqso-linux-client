import { Router } from "express";
import { db, usersTable } from "@workspace/db";
import { eq, ne } from "drizzle-orm";
import { requireAdmin } from "../lib/adminMiddleware";
import { hashPassword } from "../lib/auth";
import { roomManager } from "../eqso/room-manager";

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

// GET /api/admin/server/status — live server stats
router.get("/server/status", (_req, res) => {
  res.json(roomManager.getServerStatus());
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

export default router;
