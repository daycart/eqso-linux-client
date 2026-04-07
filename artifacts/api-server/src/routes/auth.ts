import { Router } from "express";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
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
    if (callsign.length > 20) {
      res.status(400).json({ error: "Indicativo demasiado largo (máx 20 caracteres)" });
      return;
    }
    if (password.length < 4) {
      res.status(400).json({ error: "Contraseña demasiado corta (mín 4 caracteres)" });
      return;
    }

    const upper = callsign.toUpperCase().trim();
    const existing = await db.select().from(usersTable).where(eq(usersTable.callsign, upper)).limit(1);
    if (existing.length > 0) {
      res.status(409).json({ error: `El indicativo "${upper}" ya está registrado` });
      return;
    }

    const passwordHash = await hashPassword(password);
    await db.insert(usersTable).values({
      callsign: upper,
      passwordHash,
      isRelay: Boolean(isRelay),
      active: true,
    });

    const token = createSession(upper, Boolean(isRelay));
    res.json({ token, callsign: upper, isRelay: Boolean(isRelay) });
  } catch (err) {
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

    const upper = callsign.toUpperCase().trim();
    const [user] = await db.select().from(usersTable).where(eq(usersTable.callsign, upper)).limit(1);

    if (!user) {
      res.status(401).json({ error: "Indicativo o contraseña incorrectos" });
      return;
    }
    if (!user.active) {
      res.status(403).json({ error: "Cuenta desactivada. Contacta al administrador" });
      return;
    }

    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) {
      res.status(401).json({ error: "Indicativo o contraseña incorrectos" });
      return;
    }

    await db.update(usersTable).set({ lastLogin: new Date() }).where(eq(usersTable.id, user.id));

    const token = createSession(user.callsign, user.isRelay);
    res.json({ token, callsign: user.callsign, isRelay: user.isRelay });
  } catch (err) {
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

// GET /api/auth/users  — lista de usuarios (sin contraseñas)
router.get("/users", async (_req, res) => {
  try {
    const users = await db.select({
      id:        usersTable.id,
      callsign:  usersTable.callsign,
      isRelay:   usersTable.isRelay,
      active:    usersTable.active,
      createdAt: usersTable.createdAt,
      lastLogin: usersTable.lastLogin,
    }).from(usersTable).orderBy(usersTable.callsign);
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

export default router;
