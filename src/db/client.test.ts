import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { createDb } from "./client.js";

describe("createDb", () => {
  it("applies migrations cleanly to a fresh SQLite database and creates all expected tables", () => {
    const { db, sqlite } = createDb(":memory:");

    try {
      const tableNames = db.all<{ name: string }>(
        sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%' ORDER BY name`,
      );

      expect(tableNames.map((row) => row.name)).toEqual([
        "categories",
        "categorization_rules",
        "invoices",
        "sync_runs",
        "sync_state",
      ]);
    } finally {
      sqlite.close();
    }
  });

  it("enables WAL journal mode, a busy timeout, and foreign keys for concurrent multi-client access", () => {
    const { sqlite } = createDb(":memory:");

    try {
      expect(sqlite.pragma("busy_timeout", { simple: true })).toBe(5000);
      expect(sqlite.pragma("synchronous", { simple: true })).toBe(1); // NORMAL
      expect(sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
    } finally {
      sqlite.close();
    }
  });

  it("can be created and migrated more than once without error (idempotent migrations)", () => {
    const first = createDb(":memory:");
    first.sqlite.close();

    const second = createDb(":memory:");
    second.sqlite.close();
  });

  describe("file-based database", () => {
    let tempDir: string | undefined;

    afterEach(() => {
      if (tempDir) {
        rmSync(tempDir, { recursive: true, force: true });
        tempDir = undefined;
      }
    });

    it("creates the parent directory if it doesn't exist yet", () => {
      const base = mkdtempSync(join(tmpdir(), "ksef-exporter-db-test-"));
      tempDir = base;
      const dbPath = join(base, "nested", "does-not-exist-yet", "db.sqlite");

      expect(existsSync(dbPath)).toBe(false);

      const { sqlite } = createDb(dbPath);
      sqlite.close();

      expect(existsSync(dbPath)).toBe(true);
    });

    it("uses WAL journal mode so multiple clients can read/write the same file concurrently", () => {
      const base = mkdtempSync(join(tmpdir(), "ksef-exporter-db-test-"));
      tempDir = base;
      const dbPath = join(base, "db.sqlite");

      const { sqlite } = createDb(dbPath);
      try {
        expect(sqlite.pragma("journal_mode", { simple: true })).toBe("wal");
      } finally {
        sqlite.close();
      }
    });

    it("preserves existing sync runs when applying the observability migration", () => {
      const base = mkdtempSync(join(tmpdir(), "ksef-exporter-db-test-"));
      tempDir = base;
      const dbPath = join(base, "legacy.sqlite");
      const migrationsDir = fileURLToPath(new URL("../../drizzle/migrations", import.meta.url));
      const journal = JSON.parse(
        readFileSync(join(migrationsDir, "meta", "_journal.json"), "utf8"),
      ) as { entries: Array<{ tag: string; when: number }> };
      const legacy = new Database(dbPath);
      legacy.exec(
        'CREATE TABLE "__drizzle_migrations" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)',
      );
      for (const entry of journal.entries.slice(0, 2)) {
        const migration = readFileSync(join(migrationsDir, `${entry.tag}.sql`), "utf8");
        for (const statement of migration.split("--> statement-breakpoint")) {
          if (statement.trim()) legacy.exec(statement);
        }
        legacy
          .prepare('INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES (?, ?)')
          .run(createHash("sha256").update(migration).digest("hex"), entry.when);
      }
      legacy
        .prepare(
          "INSERT INTO sync_runs (window_from, window_to, status, invoice_count) VALUES (?, ?, 'success', ?)",
        )
        .run("2025-01-01", "2025-01-31", 4);
      legacy.close();

      const { sqlite } = createDb(dbPath);
      try {
        expect(sqlite.prepare("SELECT count(*) AS count FROM sync_runs").get()).toEqual({
          count: 1,
        });
        expect(sqlite.pragma("table_info(sync_runs)")).toEqual(
          expect.arrayContaining([expect.objectContaining({ name: "retry_after_seconds" })]),
        );
      } finally {
        sqlite.close();
      }
    });
  });
});
