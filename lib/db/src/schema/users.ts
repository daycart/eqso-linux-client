import { pgTable, serial, varchar, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export type UserStatus = "pending" | "active" | "inactive";
export type UserRole = "admin" | "user";

export const usersTable = pgTable("users", {
  id:           serial("id").primaryKey(),
  callsign:     varchar("callsign", { length: 20 }).notNull().unique(),
  passwordHash: varchar("password_hash", { length: 255 }).notNull(),
  isRelay:      boolean("is_relay").notNull().default(false),
  active:       boolean("active").notNull().default(true),
  status:       varchar("status", { length: 10 }).notNull().default("pending"),
  role:         varchar("role", { length: 10 }).notNull().default("user"),
  createdAt:    timestamp("created_at").notNull().defaultNow(),
  lastLogin:    timestamp("last_login"),
});

export const insertUserSchema = createInsertSchema(usersTable).omit({
  id: true, createdAt: true, lastLogin: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;
