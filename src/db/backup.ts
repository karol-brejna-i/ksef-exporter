import { mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";

/**
 * Filenames this module writes and is therefore willing to prune. Retention
 * must never touch anything else that happens to live in `destDir` (an
 * operator's own file, a different tool's output, ...).
 */
const SNAPSHOT_FILENAME = /^ksef-exporter-\d{8}T\d{6}\.sqlite$/;

export interface BackupDatabaseOptions {
  /** The open source database to snapshot. Read via `VACUUM INTO`, never mutated. */
  sqlite: Database.Database;
  /** Directory the snapshot is written into; created if it doesn't exist. */
  destDir: string;
  /** Injected clock so the snapshot filename is deterministic in tests. */
  now: () => Date;
  /** How many newest snapshots to retain after pruning. Defaults to 14. */
  keep?: number;
}

export interface BackupDatabaseResult {
  /** Full path of the snapshot just written. */
  path: string;
  /** Size in bytes of the snapshot just written. */
  bytes: number;
  /** Filenames deleted by retention pruning, oldest first. */
  pruned: string[];
}

/**
 * Formats `date` as a compact UTC stamp, e.g. `2026-09-13T17:07:12.345Z` ->
 * `"20260913T170712"`. UTC (never local time, per
 * .github/copilot-instructions.md "Dates and times") and zero-padded, so
 * lexical filename order is chronological order.
 */
function stampOf(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const y = date.getUTCFullYear();
  const mo = pad(date.getUTCMonth() + 1);
  const d = pad(date.getUTCDate());
  const h = pad(date.getUTCHours());
  const mi = pad(date.getUTCMinutes());
  const s = pad(date.getUTCSeconds());
  return `${y}${mo}${d}T${h}${mi}${s}`;
}

/**
 * Snapshots `sqlite` to `<destDir>/ksef-exporter-<UTC stamp>.sqlite` via
 * `VACUUM INTO`, then prunes all but the newest `keep` snapshots in
 * `destDir`.
 *
 * `VACUUM INTO` is the required primitive here: it produces one consistent
 * file that already includes committed WAL content, unlike copying the live
 * `.sqlite`/`-wal`/`-shm` trio of a WAL-mode database, which can be torn.
 */
export function backupDatabase(options: BackupDatabaseOptions): BackupDatabaseResult {
  const { sqlite, destDir, now, keep = 14 } = options;

  mkdirSync(destDir, { recursive: true });

  const filename = `ksef-exporter-${stampOf(now())}.sqlite`;
  const path = join(destDir, filename);

  // The destination is bound as a parameter rather than interpolated into
  // the SQL text -- SQLite treats VACUUM INTO's target as an expression, so
  // this works, and it means a destDir containing a quote can't break the
  // statement.
  sqlite.prepare("VACUUM INTO ?").run(path);

  const bytes = statSync(path).size;
  const pruned = pruneSnapshots(destDir, keep);

  return { path, bytes, pruned };
}

/** Deletes all but the newest `keep` snapshot files in `destDir`; returns what was deleted. */
function pruneSnapshots(destDir: string, keep: number): string[] {
  const snapshots = readdirSync(destDir)
    .filter((name) => SNAPSHOT_FILENAME.test(name))
    .sort(); // lexical order == chronological order, per stampOf's contract

  const excess = snapshots.length - keep;
  const toDelete = excess > 0 ? snapshots.slice(0, excess) : [];

  for (const name of toDelete) {
    unlinkSync(join(destDir, name));
  }

  return toDelete;
}
