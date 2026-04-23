import { pgTable, varchar } from "drizzle-orm/pg-core";

export const systemSettingsTable = pgTable("system_settings", {
  key:   varchar("key",   { length: 100 }).primaryKey(),
  value: varchar("value", { length: 2000 }).notNull().default(""),
});

export type SystemSetting = typeof systemSettingsTable.$inferSelect;
