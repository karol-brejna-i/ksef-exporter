/**
 * Exports invoices (and their line items) to an .xlsx workbook with two
 * sheets, "Faktury" and "Pozycje". Replaces the old scripts/export-invoices.py
 * (Python + openpyxl), which had drifted from the schema (missing direction,
 * invoice_kind, items_extracted_at, and never touched invoice_items at all).
 *
 * Usage:
 *   pnpm run export:invoices                                    # all invoices -> data/invoices-export.xlsx
 *   pnpm run export:invoices -- --db path/to/custom.sqlite
 *   pnpm run export:invoices -- --from 2026-05-01                # from May 1st onward
 *   pnpm run export:invoices -- --to 2026-06-30                  # up to June 30th
 *   pnpm run export:invoices -- --from 2026-05-01 --to 2026-06-30 ~/Desktop/maj-czerwiec.xlsx
 *
 * Unlike every other src/tools/*.ts script (where the first positional
 * argument is the database path), the positional argument here is the
 * *output* path and the database is an explicit `--db` flag -- this
 * mirrors the old Python script's own CLI shape and is intentional, not an
 * oversight to "fix" back to the sibling convention.
 *
 * Every run prints the resolved parameters before exporting, and validates
 * `--db` up front (existence, file, valid SQLite, has an `invoices` table)
 * so a typo'd path fails with a clear message instead of silently creating
 * a fresh empty database (which is what `createDb` would otherwise do for a
 * nonexistent path).
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createDb } from "../db/client.js";
import {
  assertUsableDatabaseFile,
  fetchExportInvoiceItems,
  fetchExportInvoices,
} from "../invoices/export-invoices.js";
import { buildInvoicesWorkbook } from "../invoices/export-invoices-workbook.js";
import { type IsoDate, isIsoDate } from "../time.js";

/** Mirrors the DATABASE_PATH default in src/config/env.ts. */
const DEFAULT_DATABASE_PATH = "./data/ksef-exporter.sqlite";
const DEFAULT_OUTPUT_PATH = "data/invoices-export.xlsx";

interface ParsedArgs {
  dbPath: string;
  from: string | undefined;
  to: string | undefined;
  output: string;
  error: string | undefined;
}

function parseArgs(argv: string[]): ParsedArgs {
  // `pnpm run export:invoices -- ...` forwards the literal "--" through to
  // this script's argv on some pnpm/tsx versions -- skip it if present.
  const args = argv.filter((arg) => arg !== "--");

  let dbPath = process.env.DATABASE_PATH ?? DEFAULT_DATABASE_PATH;
  let from: string | undefined;
  let to: string | undefined;
  let output: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--db") {
      const value = args[++i];
      if (value === undefined) {
        return {
          dbPath,
          from,
          to,
          output: output ?? DEFAULT_OUTPUT_PATH,
          error: "--db requires a value",
        };
      }
      dbPath = value;
    } else if (arg === "--from") {
      const value = args[++i];
      if (value === undefined) {
        return {
          dbPath,
          from,
          to,
          output: output ?? DEFAULT_OUTPUT_PATH,
          error: "--from requires a value",
        };
      }
      from = value;
    } else if (arg === "--to") {
      const value = args[++i];
      if (value === undefined) {
        return {
          dbPath,
          from,
          to,
          output: output ?? DEFAULT_OUTPUT_PATH,
          error: "--to requires a value",
        };
      }
      to = value;
    } else if (arg?.startsWith("--")) {
      return {
        dbPath,
        from,
        to,
        output: output ?? DEFAULT_OUTPUT_PATH,
        error: `Unknown flag: ${arg}`,
      };
    } else if (arg !== undefined) {
      output = arg;
    }
  }

  if (from !== undefined && !isIsoDate(from)) {
    return {
      dbPath,
      from,
      to,
      output: output ?? DEFAULT_OUTPUT_PATH,
      error: "--from must be a valid date formatted as YYYY-MM-DD",
    };
  }
  if (to !== undefined && !isIsoDate(to)) {
    return {
      dbPath,
      from,
      to,
      output: output ?? DEFAULT_OUTPUT_PATH,
      error: "--to must be a valid date formatted as YYYY-MM-DD",
    };
  }
  if (from !== undefined && to !== undefined && from > to) {
    return {
      dbPath,
      from,
      to,
      output: output ?? DEFAULT_OUTPUT_PATH,
      error: "--from must not be after --to",
    };
  }

  return { dbPath, from, to, output: output ?? DEFAULT_OUTPUT_PATH, error: undefined };
}

async function main() {
  const { dbPath, from, to, output, error } = parseArgs(process.argv.slice(2));

  if (error) {
    console.error(`Error: ${error}`);
    console.error(
      "Usage: pnpm run export:invoices -- [--db PATH] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [output.xlsx]",
    );
    process.exitCode = 1;
    return;
  }

  console.log("Parameters:");
  console.log(`  db_path:   ${dbPath}`);
  console.log(`  date_from: ${from ?? "unbounded — earliest available"}`);
  console.log(`  date_to:   ${to ?? "unbounded — latest available"}`);
  console.log(`  output:    ${output}`);
  console.log();

  try {
    assertUsableDatabaseFile(dbPath);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  const { db, sqlite } = createDb(dbPath);
  try {
    const invoiceRows = await fetchExportInvoices(db, {
      // isIsoDate already validated above; narrow via the branded type.
      ...(from === undefined ? {} : { from: from as IsoDate }),
      ...(to === undefined ? {} : { to: to as IsoDate }),
    });

    if (invoiceRows.length === 0) {
      console.log("No invoices found for the given criteria.");
      return;
    }

    const itemRows = await fetchExportInvoiceItems(db, invoiceRows);
    const workbook = buildInvoicesWorkbook(invoiceRows, itemRows);

    mkdirSync(dirname(output), { recursive: true });
    await workbook.xlsx.writeFile(output);

    console.log(
      `Exported ${invoiceRows.length} invoices (${itemRows.length} line items) → ${output}`,
    );
  } finally {
    sqlite.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
