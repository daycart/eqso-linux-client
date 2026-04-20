import { pgTable, serial, varchar, boolean, integer, timestamp } from "drizzle-orm/pg-core";

export const relayConnectionsTable = pgTable("relay_connections", {
  id:         serial("id").primaryKey(),
  label:      varchar("label",       { length: 100 }).notNull(),
  callsign:   varchar("callsign",    { length: 20  }).notNull(),
  server:     varchar("server",      { length: 255 }).notNull(),
  port:       integer("port").notNull().default(2171),
  localRoom:  varchar("local_room",  { length: 30  }).notNull().default("CB"),
  remoteRoom: varchar("remote_room", { length: 30  }).notNull().default("CB"),
  password:   varchar("password",    { length: 100 }).notNull().default(""),
  enabled:    boolean("enabled").notNull().default(false),
  createdAt:  timestamp("created_at").notNull().defaultNow(),
});

export type RelayConnection = typeof relayConnectionsTable.$inferSelect;
