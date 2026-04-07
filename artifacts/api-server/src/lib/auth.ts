import { randomUUID, scrypt, randomBytes, timingSafeEqual } from "crypto";
import { promisify } from "util";

const scryptAsync = promisify(scrypt);

// ── Password hashing (scrypt) ────────────────────────────────────────────────

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const hash = (await scryptAsync(password, salt, 64)) as Buffer;
  return `${salt}:${hash.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const [salt, hashHex] = stored.split(":");
    const hash = (await scryptAsync(password, salt, 64)) as Buffer;
    return timingSafeEqual(hash, Buffer.from(hashHex, "hex"));
  } catch {
    return false;
  }
}

// ── Session store ────────────────────────────────────────────────────────────

interface Session {
  callsign: string;
  isRelay: boolean;
  expiresAt: number;
}

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const sessions = new Map<string, Session>();

export function createSession(callsign: string, isRelay: boolean): string {
  const token = randomUUID();
  sessions.set(token, {
    callsign,
    isRelay,
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
  return token;
}

export function validateSession(token: string): Session | null {
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() > s.expiresAt) {
    sessions.delete(token);
    return null;
  }
  return s;
}

export function deleteSession(token: string): void {
  sessions.delete(token);
}

// Prune expired sessions every hour
setInterval(() => {
  const now = Date.now();
  for (const [token, s] of sessions) {
    if (now > s.expiresAt) sessions.delete(token);
  }
}, 60 * 60 * 1000);
