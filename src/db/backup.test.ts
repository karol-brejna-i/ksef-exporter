import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backupDatabase } from "./backup.js";

describe("backupDatabase", () => {
  let tempDir: string;
  let sqlite: Database.Database;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ksef-backup-test-"));
    sqlite = new Database(join(tempDir, "source.sqlite"));
    sqlite.pragma("journal_mode = WAL");
    sqlite.exec("CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT)");
    sqlite.prepare("INSERT INTO widgets (id, name) VALUES (?, ?)").run(1, "gizmo");
  });

  afterEach(() => {
    sqlite.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("writes a snapshot named from the injected UTC clock", () => {
    const destDir = join(tempDir, "backups");
    const now = () => new Date("2026-09-13T17:07:12.345Z");

    const result = backupDatabase({ sqlite, destDir, now });

    expect(result.path).toBe(join(destDir, "ksef-exporter-20260913T170712.sqlite"));
    expect(existsSync(result.path)).toBe(true);
    expect(result.bytes).toBeGreaterThan(0);
  });

  it("creates destDir when it doesn't exist yet", () => {
    const destDir = join(tempDir, "nested", "backups");

    backupDatabase({ sqlite, destDir, now: () => new Date("2026-09-13T00:00:00Z") });

    expect(existsSync(destDir)).toBe(true);
  });

  it("produces a snapshot that is readable and includes committed data", () => {
    const destDir = join(tempDir, "backups");

    const result = backupDatabase({ sqlite, destDir, now: () => new Date("2026-09-13T00:00:00Z") });

    const snapshot = new Database(result.path, { readonly: true, fileMustExist: true });
    try {
      expect(snapshot.prepare("SELECT * FROM widgets").all()).toEqual([{ id: 1, name: "gizmo" }]);
    } finally {
      snapshot.close();
    }
  });

  it("includes WAL content that has not yet been checkpointed to the main file", () => {
    const destDir = join(tempDir, "backups");
    // Still in WAL mode from beforeEach; this insert lives in the -wal file
    // until a checkpoint, which is exactly what a naive `cp` would miss.
    sqlite.prepare("INSERT INTO widgets (id, name) VALUES (?, ?)").run(2, "widget");

    const result = backupDatabase({ sqlite, destDir, now: () => new Date("2026-09-13T00:00:00Z") });

    const snapshot = new Database(result.path, { readonly: true, fileMustExist: true });
    try {
      const rows = snapshot.prepare("SELECT id, name FROM widgets ORDER BY id").all();
      expect(rows).toEqual([
        { id: 1, name: "gizmo" },
        { id: 2, name: "widget" },
      ]);
    } finally {
      snapshot.close();
    }
  });

  it("retention keeps exactly the newest N snapshots and deletes the rest", () => {
    const destDir = join(tempDir, "backups");
    const stamps = [
      "2026-09-01T00:00:00Z",
      "2026-09-02T00:00:00Z",
      "2026-09-03T00:00:00Z",
      "2026-09-04T00:00:00Z",
      "2026-09-05T00:00:00Z",
    ];

    // Each call only prunes relative to what exists at that moment, so an
    // older snapshot is reported pruned by whichever call first pushes the
    // count above `keep` -- accumulate across all calls to see the full set.
    const allPruned: string[] = [];
    for (const stamp of stamps) {
      const result = backupDatabase({ sqlite, destDir, now: () => new Date(stamp), keep: 3 });
      allPruned.push(...result.pruned);
    }

    const remaining = readdirSync(destDir).sort();
    expect(remaining).toEqual([
      "ksef-exporter-20260903T000000.sqlite",
      "ksef-exporter-20260904T000000.sqlite",
      "ksef-exporter-20260905T000000.sqlite",
    ]);
    expect(allPruned).toEqual([
      "ksef-exporter-20260901T000000.sqlite",
      "ksef-exporter-20260902T000000.sqlite",
    ]);
  });

  it("defaults to keeping 14 snapshots when keep is not specified", () => {
    const destDir = join(tempDir, "backups");

    for (let day = 1; day <= 15; day++) {
      const stamp = `2026-09-${String(day).padStart(2, "0")}T00:00:00Z`;
      backupDatabase({ sqlite, destDir, now: () => new Date(stamp) });
    }

    expect(readdirSync(destDir)).toHaveLength(14);
  });

  it("never prunes files in destDir that don't match the snapshot filename pattern", () => {
    const destDir = join(tempDir, "backups");
    backupDatabase({ sqlite, destDir, now: () => new Date("2026-09-13T00:00:00Z"), keep: 1 });
    writeFileSync(join(destDir, "notes.txt"), "do not delete me");
    writeFileSync(join(destDir, "ksef-exporter-not-a-real-stamp.sqlite"), "also keep me");

    backupDatabase({ sqlite, destDir, now: () => new Date("2026-09-14T00:00:00Z"), keep: 1 });

    const remaining = readdirSync(destDir).sort();
    expect(remaining).toContain("notes.txt");
    expect(remaining).toContain("ksef-exporter-not-a-real-stamp.sqlite");
    expect(remaining).toContain("ksef-exporter-20260914T000000.sqlite");
    expect(remaining).not.toContain("ksef-exporter-20260913T000000.sqlite");
  });
});
