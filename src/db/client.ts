import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.js";

export type Db = BetterSQLite3Database<typeof schema>;

const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle/migrations", import.meta.url));

/**
 * Opens (creating if needed) the SQLite database at `path` and applies any
 * pending migrations. Use `path = ":memory:"` for tests.
 */
export function createDb(path: string): { db: Db; sqlite: Database.Database } {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }

  const sqlite = new Database(path);
  // WAL allows concurrent readers alongside a single writer (required for
  // multiple clients/processes accessing the same file at once). busy_timeout
  // makes writers that collide retry for up to 5s instead of throwing
  // SQLITE_BUSY immediately. synchronous=NORMAL is the standard safe pairing
  // with WAL (still durable across app crashes; only risks loss on an OS
  // crash/power loss, unlike FULL).
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("synchronous = NORMAL");
  sqlite.pragma("foreign_keys = ON");

  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

  return { db, sqlite };
}
