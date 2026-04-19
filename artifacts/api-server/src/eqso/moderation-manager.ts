/**
 * moderation-manager.ts
 * Gestiona silenciados (mute, en memoria con TTL) y baneados (ban, persistido en DB).
 * - Mute: impide que el usuario transmita audio al resto de la sala.
 * - Ban:  impide que el usuario se conecte al servidor (TCP o WS).
 */

import { logger } from "../lib/logger";
import { db, calssignBansTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { roomManager } from "./room-manager";

export interface MuteEntry {
  callsign: string;
  mutedAt: number;
  expiresAt: number | null;
}

export interface BanEntry {
  callsign: string;
  reason: string;
  bannedBy: string;
  bannedAt: number;
}

class ModerationManager {
  private mutes  = new Map<string, MuteEntry>();
  private bansSet = new Set<string>();
  private bansMap = new Map<string, BanEntry>();

  async loadBans(): Promise<void> {
    try {
      const rows = await db.select().from(calssignBansTable);
      for (const row of rows) {
        const cs = row.callsign.toLowerCase();
        this.bansSet.add(cs);
        this.bansMap.set(cs, {
          callsign: row.callsign,
          reason:   row.reason,
          bannedBy: row.bannedBy,
          bannedAt: row.bannedAt.getTime(),
        });
      }
      logger.info({ count: rows.length }, "Moderation: bans loaded from DB");
    } catch (err) {
      logger.warn({ err }, "Moderation: failed to load bans (non-fatal)");
    }
  }

  // ── Mutes ──────────────────────────────────────────────────────────────────

  mute(callsign: string, durationMs: number | null): void {
    const key = callsign.toLowerCase();
    const entry: MuteEntry = {
      callsign: callsign.toUpperCase(),
      mutedAt:  Date.now(),
      expiresAt: durationMs !== null ? Date.now() + durationMs : null,
    };
    this.mutes.set(key, entry);
    logger.info({ callsign, durationMs }, "Moderation: muted");
  }

  unmute(callsign: string): void {
    this.mutes.delete(callsign.toLowerCase());
    logger.info({ callsign }, "Moderation: unmuted");
  }

  isMuted(callsign: string): boolean {
    const key = callsign.toLowerCase();
    const entry = this.mutes.get(key);
    if (!entry) return false;
    if (entry.expiresAt !== null && Date.now() >= entry.expiresAt) {
      this.mutes.delete(key);
      return false;
    }
    return true;
  }

  getMutes(): MuteEntry[] {
    const now = Date.now();
    const result: MuteEntry[] = [];
    for (const [key, entry] of this.mutes) {
      if (entry.expiresAt !== null && now >= entry.expiresAt) {
        this.mutes.delete(key);
        continue;
      }
      result.push(entry);
    }
    return result;
  }

  // ── Bans ───────────────────────────────────────────────────────────────────

  async ban(callsign: string, reason: string, bannedBy: string): Promise<void> {
    const cs = callsign.toUpperCase();
    const key = cs.toLowerCase();
    await db.insert(calssignBansTable)
      .values({ callsign: cs, reason, bannedBy })
      .onConflictDoUpdate({
        target: calssignBansTable.callsign,
        set: { reason, bannedBy, bannedAt: new Date() },
      });
    this.bansSet.add(key);
    this.bansMap.set(key, {
      callsign: cs, reason, bannedBy,
      bannedAt: Date.now(),
    });
    // Kick if currently connected
    this.kickByCallsign(cs);
    logger.info({ callsign: cs, reason, bannedBy }, "Moderation: banned");
  }

  async unban(callsign: string): Promise<void> {
    const cs = callsign.toUpperCase();
    const key = cs.toLowerCase();
    await db.delete(calssignBansTable).where(eq(calssignBansTable.callsign, cs));
    this.bansSet.delete(key);
    this.bansMap.delete(key);
    logger.info({ callsign: cs }, "Moderation: unbanned");
  }

  isBanned(callsign: string): boolean {
    return this.bansSet.has(callsign.toLowerCase());
  }

  getBans(): BanEntry[] {
    return Array.from(this.bansMap.values());
  }

  // ── Kick ───────────────────────────────────────────────────────────────────

  kickClient(clientId: string): void {
    const client = roomManager.getClient(clientId);
    if (!client) return;
    logger.info({ id: clientId, name: client.name }, "Moderation: kick");
    try { client.close(); } catch { /* ignore */ }
  }

  kickByCallsign(callsign: string): void {
    for (const client of roomManager.getAllClients()) {
      if (client.name.toUpperCase() === callsign.toUpperCase()) {
        logger.info({ id: client.id, callsign }, "Moderation: kicking banned callsign");
        try { client.close(); } catch { /* ignore */ }
      }
    }
  }
}

export const moderationManager = new ModerationManager();
