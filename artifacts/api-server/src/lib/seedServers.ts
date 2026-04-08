/**
 * Seeds the eqso_servers table with the default server list on first startup.
 * Only runs if the table is empty.
 */
import { db, serversTable } from "@workspace/db";

const DEFAULT_SERVERS = [
  {
    label:       "Servidor Local",
    description: "Servidor eQSO propio (Linux)",
    mode:        "local",
    host:        null,
    port:        null,
    defaultPassword: null,
    rooms:       "GENERAL,CB,ASORAPA,PRUEBAS",
    isActive:    true,
    sortOrder:   0,
  },
  {
    label:       "ASORAPA — Radio Club Iria Flavia",
    description: "Enlace CB27 ASORAPA · Galicia",
    mode:        "remote",
    host:        "193.152.83.229",
    port:        8008,
    defaultPassword: "Asorapa2024.",
    rooms:       "CB,ASORAPA,PRUEBAS",
    isActive:    true,
    sortOrder:   1,
  },
  {
    label:       "eQSO Principal (server.eqso.net)",
    description: "Servidor oficial eQSO · Puerto 2171",
    mode:        "remote",
    host:        "server.eqso.net",
    port:        2171,
    defaultPassword: null,
    rooms:       "101ENGLISH,SPAIN,HISPANIC",
    isActive:    true,
    sortOrder:   2,
  },
] as const;

export async function seedServers() {
  const existing = await db.select({ id: serversTable.id }).from(serversTable).limit(1);
  if (existing.length > 0) return;

  await db.insert(serversTable).values(DEFAULT_SERVERS.map((s) => ({ ...s })));
}
