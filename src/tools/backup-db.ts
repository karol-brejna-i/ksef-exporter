/**
 * Snapshots the SQLite database via `VACUUM INTO` (src/db/backup.ts) and
 * prunes old snapshots. Two jobs:
 *
 *  - Nightly backups inside the container: `node dist/tools/backup-db.js`.
 *    Must work as compiled JS with no `tsx`, so it never calls `loadConfig()`
 *    (which would demand `KSEF_TOKEN`/`AUTH_*`/`JWT_SECRET`, none of which a
 *    backup needs) and never uses `createDb()` (which applies migrations --
 *    a backup must never write to the source database).
 *  - Seeding a server volume from a developer machine:
 *    `APP_ENV=parkowa pnpm run backup:db --out /tmp`.
 *
 * Usage:
 *   pnpm run backup:db                       # DATABASE_PATH -> BACKUP_DIR (default /backups)
 *   pnpm run backup:db -- --out /tmp         # explicit output directory
 *   APP_ENV=parkowa pnpm run backup:db --out /tmp
 *   BACKUP_KEEP=30 pnpm run backup:db        # retain 30 snapshots instead of the default 14
 *
 * The output directory is resolved as: `--out <dir>` flag, else `BACKUP_DIR`
 * env var, else `/backups` (the path the container bind-mounts a host backup
 * directory onto -- see design/DOCKER_DEPLOYMENT_PLAN.md §7-8).
 */
import "../config/bootstrap-env.js";
import Database from "better-sqlite3";
import { z } from "zod";
import { backupDatabase } from "../db/backup.js";

/** Mirrors the DATABASE_PATH default in src/config/env.ts. */
const DEFAULT_DATABASE_PATH = "./data/ksef-exporter.sqlite";
/** Matches the container's bind-mounted backup volume; see the module doc comment. */
const DEFAULT_OUT_DIR = "/backups";

// Deliberately not loadConfig(): a backup must never require KSEF_TOKEN,
// AUTH_*, or JWT_SECRET to be present.
const backupEnvSchema = z.object({
  DATABASE_PATH: z.string().trim().min(1).default(DEFAULT_DATABASE_PATH),
  BACKUP_KEEP: z.coerce.number().int().positive().default(14),
});

interface ParsedArgs {
  outDir: string;
  error: string | undefined;
}

function parseArgs(argv: string[], env: NodeJS.ProcessEnv): ParsedArgs {
  // `pnpm run backup:db -- ...` forwards the literal "--" through to this
  // script's argv on some pnpm/tsx versions -- skip it if present.
  const args = argv.filter((arg) => arg !== "--");

  let outDir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--out") {
      const value = args[++i];
      if (value === undefined) {
        return { outDir: outDir ?? DEFAULT_OUT_DIR, error: "--out requires a value" };
      }
      outDir = value;
    } else {
      return { outDir: outDir ?? DEFAULT_OUT_DIR, error: `Unknown flag: ${arg}` };
    }
  }

  return { outDir: outDir ?? env.BACKUP_DIR ?? DEFAULT_OUT_DIR, error: undefined };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

async function main(): Promise<void> {
  const { outDir, error } = parseArgs(process.argv.slice(2), process.env);
  if (error) {
    console.error(`Error: ${error}`);
    console.error("Usage: pnpm run backup:db [-- --out <dir>]");
    process.exitCode = 1;
    return;
  }

  const parsedEnv = backupEnvSchema.safeParse(process.env);
  if (!parsedEnv.success) {
    console.error("Invalid configuration:");
    for (const issue of parsedEnv.error.issues) {
      console.error(`  - ${issue.path.join(".") || "(root)"}: ${issue.message}`);
    }
    process.exitCode = 1;
    return;
  }
  const { DATABASE_PATH, BACKUP_KEEP } = parsedEnv.data;

  // Opened directly with better-sqlite3, NOT createDb(): createDb() applies
  // pending migrations, which a backup must never trigger.
  let sqlite: Database.Database;
  try {
    sqlite = new Database(DATABASE_PATH, { fileMustExist: true });
  } catch (err) {
    console.error(
      `Failed to open database at ${DATABASE_PATH}: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
    return;
  }
  sqlite.pragma("busy_timeout = 5000");

  try {
    const result = backupDatabase({
      sqlite,
      destDir: outDir,
      now: () => new Date(),
      keep: BACKUP_KEEP,
    });
    console.log(
      `Backed up ${DATABASE_PATH} -> ${result.path} (${formatBytes(result.bytes)}); ` +
        `pruned ${result.pruned.length} old snapshot(s) in ${outDir}.`,
    );
  } catch (err) {
    console.error("Backup failed:", err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  } finally {
    sqlite.close();
  }
}

main().catch((err) => {
  console.error("Fatal error during backup:", err);
  process.exitCode = 1;
});
