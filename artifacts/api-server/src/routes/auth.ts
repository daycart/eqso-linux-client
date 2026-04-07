import { Router } from "express";
import { db, usersTable } from "@workspace/db";
import { eq, count } from "drizzle-orm";
import { hashPassword, verifyPassword, createSession } from "../lib/auth";

const router = Router();

// POST /api/auth/register
router.post("/register", async (req, res) => {
  try {
    const { callsign, password, isRelay = false } = req.body as {
      callsign: string;
      password: string;
      isRelay?: boolean;
    };

    if (!callsign || !password) {
      res.status(400).json({ error: "Indicativo y contraseña son obligatorios" });
      return;
    }
    const trimmed = callsign.trim();
    if (trimmed.length === 0 || trimmed.length > 20) {
      res.status(400).json({ error: "Indicativo inválido (máx 20 caracteres)" });
      return;
    }
    if (password.length < 4) {
      res.status(400).json({ error: "Contraseña demasiado corta (mín 4 caracteres)" });
      return;
    }

    const upper = trimmed.toUpperCase();
    const existing = await db.select().from(usersTable).where(eq(usersTable.callsign, upper)).limit(1);
    if (existing.length > 0) {
      res.status(409).json({ error: `El indicativo "${upper}" ya está registrado` });
      return;
    }

    // First user registered becomes admin and is auto-approved
    const [{ adminCount }] = await db
      .select({ adminCount: count() })
      .from(usersTable)
      .where(eq(usersTable.role, "admin"));

    const isFirstAdmin = Number(adminCount) === 0;
    const newStatus = isFirstAdmin ? "active" : "pending";
    const newRole = isFirstAdmin ? "admin" : "user";

    const passwordHash = await hashPassword(password);
    await db.insert(usersTable).values({
      callsign: upper,
      passwordHash,
      isRelay: Boolean(isRelay),
      active: isFirstAdmin,
      status: newStatus,
      role: newRole,
    });

    if (isFirstAdmin) {
      const token = createSession(upper, Boolean(isRelay), "admin");
      res.json({ token, callsign: upper, isRelay: Boolean(isRelay), role: "admin" });
    } else {
      res.status(202).json({
        pending: true,
        callsign: upper,
        message: "Registro recibido. Pendiente de aprobación por el administrador.",
      });
    }
  } catch {
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

// POST /api/auth/login
router.post("/login", async (req, res) => {
  try {
    const { callsign, password } = req.body as { callsign: string; password: string };

    if (!callsign || !password) {
      res.status(400).json({ error: "Indicativo y contraseña son obligatorios" });
      return;
    }

    const upper = callsign.trim().toUpperCase();
    const [user] = await db.select().from(usersTable).where(eq(usersTable.callsign, upper)).limit(1);

    if (!user) {
      res.status(401).json({ error: "Indicativo o contraseña incorrectos" });
      return;
    }

    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) {
      res.status(401).json({ error: "Indicativo o contraseña incorrectos" });
      return;
    }

    if (user.status === "pending") {
      res.status(403).json({ error: "Registro pendiente de aprobación por el administrador." });
      return;
    }
    if (user.status === "inactive") {
      res.status(403).json({ error: "Cuenta desactivada. Contacta al administrador." });
      return;
    }

    await db.update(usersTable).set({ lastLogin: new Date() }).where(eq(usersTable.id, user.id));

    const role = (user.role === "admin" ? "admin" : "user") as "admin" | "user";
    const token = createSession(user.callsign, user.isRelay, role);
    res.json({ token, callsign: user.callsign, isRelay: user.isRelay, role });
  } catch {
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

export default router;
