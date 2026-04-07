import type { Request, Response, NextFunction } from "express";
import { validateSession } from "./auth";

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const auth = req.headers.authorization;
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) {
    res.status(401).json({ error: "Token de autenticación requerido" });
    return;
  }
  const session = validateSession(token);
  if (!session) {
    res.status(401).json({ error: "Sesión expirada o inválida" });
    return;
  }
  if (session.role !== "admin") {
    res.status(403).json({ error: "Acceso restringido a administradores" });
    return;
  }
  next();
}
