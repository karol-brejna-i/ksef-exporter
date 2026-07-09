import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
        "sync_state",
      ]);
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
  });
});
