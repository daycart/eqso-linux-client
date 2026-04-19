import { pgTable, serial, varchar, boolean, integer, timestamp } from "drizzle-orm/pg-core";

export const relayConnectionsTable = pgTable("relay_connections", {
  id:        serial("id").primaryKey(),
  label:     varchar("label",     { length: 100 }).notNull(),
  callsign:  varchar("callsign",  { length: 20  }).notNull(),
  server:    varchar("server",    { length: 255 }).notNull().default("193.152.83.229"),
  port:      integer("port").notNull().default(8008),
  room:      varchar("room",      { length: 50  }).notNull(),
  password:  varchar("password",  { length: 100 }).notNull().default(""),
  message:   varchar("message",   { length: 100 }).notNull().default(""),
  localRoom: varchar("local_room",{ length: 50  }).notNull().default(""),
  enabled:   boolean("enabled").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type RelayConnection = typeof relayConnectionsTable.$inferSelect;
