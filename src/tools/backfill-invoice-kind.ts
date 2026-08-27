/**
 * CLI wrapper for backfilling invoices.invoice_kind from stored raw_xml
 * (design/SALES_INVOICES_PLAN.md Step 2b).
 *
 * Usage:
 *   pnpm run backfill:invoice-kind --dry-run          # report only, writes nothing
 *   pnpm run backfill:invoice-kind                    # write invoice_kind
 *   pnpm run backfill:invoice-kind --force             # re-derive already-set invoices
 *   pnpm run backfill:invoice-kind --limit 10
 *   pnpm run backfill:invoice-kind -- /tmp/copy.sqlite --dry-run
 *
 * The database is the first non-flag argument, else $DATABASE_PATH, else the
 * same default the app uses. Makes zero KSeF calls and needs no KSeF
 * credentials: it reads invoices.raw_xml and writes invoices.invoice_kind only.
 *
 * Run --dry-run first, and prefer a copy of the real database over the real
 * one (`sqlite3 "file:data/ksef-exporter.sqlite?mode=ro" "VACUUM INTO
 * '/tmp/copy.sqlite'"`) -- a plain cp of a WAL-mode database can be torn.
 */
import { createDb } from "../db/client.js";
import { backfillInvoiceKind } from "../invoices/backfill-invoice-kind.js";

/** Mirrors the DATABASE_PATH default in src/config/env.ts. */
const DEFAULT_DATABASE_PATH = "./data/ksef-exporter.sqlite";

interface ParsedArgs {
  dbPath: string;
  dryRun: boolean;
  force: boolean;
  limit: number | undefined;
  error: string | undefined;
}

function parseArgs(argv: string[]): ParsedArgs {
  // `pnpm run backfill:invoice-kind -- ...` forwards the literal "--" through
  // to this script's argv on some pnpm/tsx versions -- skip it if present.
  const args = argv.filter((arg) => arg !== "--");

  const dbPath =
    args.find((arg) => !arg.startsWith("--") && !/^\d+$/.test(arg)) ??
    process.env.DATABASE_PATH ??
    DEFAULT_DATABASE_PATH;

  const limitIndex = args.indexOf("--limit");
  let limit: number | undefined;
  if (limitIndex >= 0) {
    const raw = args[limitIndex + 1];
    const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return {
        dbPath,
        dryRun: false,
        force: false,
        limit: undefined,
        error: "--limit must be a positive integer",
      };
    }
    limit = parsed;
  }

  return {
    dbPath,
    dryRun: args.includes("--dry-run"),
    force: args.includes("--force"),
    limit,
    error: undefined,
  };
}

async function main() {
  const { dbPath, dryRun, force, limit, error } = parseArgs(process.argv.slice(2));

  if (error) {
    console.error(`Error: ${error}`);
    console.error(
      "Usage: pnpm run backfill:invoice-kind [-- <database-path>] [--dry-run] [--force] [--limit N]",
    );
    process.exitCode = 1;
    return;
  }

  console.log("=== Invoice Kind Backfill ===");
  console.log(`Database: ${dbPath}`);
  console.log(`Mode: ${dryRun ? "DRY RUN (no writes)" : "LIVE"}`);
  console.log(`Force: ${force ? "yes (re-derive all)" : "no (skip already-set)"}`);
  console.log(`Limit: ${limit ?? "none (process all eligible)"}`);
  console.log();

  const { db, sqlite } = createDb(dbPath);

  try {
    const result = await backfillInvoiceKind(db, {
      dryRun,
      force,
      ...(limit === undefined ? {} : { limit }),
    });

    console.log("=== Summary ===");
    console.log(`Eligible invoices: ${result.totalEligible}`);
    console.log(`Processed: ${result.processed}`);
    console.log(`  Succeeded: ${result.succeeded}`);
    console.log(`  Skipped: ${result.skipped}`);
    console.log(`  Failed: ${result.failed}`);
    console.log();

    if (result.failed > 0 || result.skipped > 0) {
      console.log("=== Detailed Results ===");
      for (const r of result.results) {
        if (r.status === "success") {
          continue;
        }
        const ksef = r.ksefNumber ?? `invoice-${r.invoiceId}`;
        if (r.status === "failed") {
          console.log(`FAILED: ${ksef} — ${r.message}`);
        } else if (r.status === "skipped") {
          console.log(`SKIPPED: ${ksef} — ${r.message}`);
        }
      }
      console.log();
    }

    if (dryRun) {
      console.log(
        "Dry run complete. Re-run without --dry-run to commit the changes to the database.",
      );
    } else if (result.succeeded > 0) {
      console.log("Backfill complete.");
    }

    if (result.failed > 0) {
      console.log();
      console.log(
        `Warning: ${result.failed} invoice(s) had an unrecognized RodzajFaktury value. See details above.`,
      );
      process.exitCode = 1;
    }
  } catch (error) {
    console.error("Fatal error during backfill:");
    console.error(error);
    process.exitCode = 1;
  } finally {
    sqlite.close();
  }
}

main();
