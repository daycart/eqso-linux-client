import { pgTable, serial, varchar, boolean, integer, timestamp } from "drizzle-orm/pg-core";

export const serversTable = pgTable("eqso_servers", {
  id:          serial("id").primaryKey(),
  label:       varchar("label",       { length: 100  }).notNull(),
  description: varchar("description", { length: 255  }).notNull().default(""),
  mode:        varchar("mode",        { length: 10   }).notNull().default("remote"),
  host:        varchar("host",        { length: 255  }),
  port:        integer("port"),
  defaultPassword: varchar("default_password", { length: 100 }),
  rooms:       varchar("rooms",       { length: 2000 }).notNull().default(""),
  isActive:    boolean("is_active").notNull().default(true),
  sortOrder:   integer("sort_order").notNull().default(0),
  createdAt:   timestamp("created_at").notNull().defaultNow(),
});

export type Server = typeof serversTable.$inferSelect;
