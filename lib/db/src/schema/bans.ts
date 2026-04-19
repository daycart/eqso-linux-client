import { pgTable, serial, varchar, timestamp } from "drizzle-orm/pg-core";

export const calssignBansTable = pgTable("callsign_bans", {
  id:        serial("id").primaryKey(),
  callsign:  varchar("callsign",  { length: 30 }).notNull().unique(),
  reason:    varchar("reason",    { length: 200 }).notNull().default(""),
  bannedBy:  varchar("banned_by", { length: 30 }).notNull().default("admin"),
  bannedAt:  timestamp("banned_at").notNull().defaultNow(),
});

export type CallsignBan = typeof calssignBansTable.$inferSelect;
