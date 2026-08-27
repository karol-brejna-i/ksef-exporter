/**
 * Manual utility (NOT part of the automated test suite, real network calls,
 * real data) that dumps invoices from a real KSeF environment
 * (TEST/DEMO/PRD, per `KSEF_ENVIRONMENT`) to the local filesystem, so we
 * have a stable, offline sample of real-world invoice shapes to develop
 * and test against (e.g. parser edge cases like namespace-prefixed XML
 * that don't show up in hand-written fixtures).
 *
 * Defaults to purchases (`Subject2`). `DUMP_SUBJECT_TYPE=Subject1` dumps
 * sales instead, into a separate directory so the two samples never
 * overwrite each other.
 *
 * Writes to `data/invoices/` -- `data/invoices-sales/` for `Subject1` --
 * (gitignored: this is real business data and must never be committed):
 *   - raw/<file-name>.xml   one file per invoice, exactly as received
 *   - metadata.json         the raw `_metadata.json` summaries for this run
 *   - parsed.json           this app's flat PurchaseInvoiceRecord for each
 *                           invoice that parsed successfully
 *   - parse-errors.json     file name + error message for any that didn't
 *
 * Each run starts a new KSeF export, which is subject to KSeF's own
 * server-side rate limit (see src/ksef/rate-limit.ts) -- avoid running this
 * back-to-back with other export-starting scripts (smoke:invoices,
 * dump:invoices) in a short window. The limit is per subject type, so a
 * Subject1 run draws on its own budget rather than the purchase one.
 *
 * Usage:
 *   pnpm run dump:invoices                              # last 30 days
 *   DUMP_WINDOW_DAYS=90 pnpm run dump:invoices
 *   DUMP_WINDOW_FROM=2026-05-01 DUMP_WINDOW_TO=2026-06-01 pnpm run dump:invoices
 *   DUMP_SUBJECT_TYPE=Subject1 DUMP_WINDOW_DAYS=7 pnpm run dump:invoices
 */
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config/env.js";
import { KsefSessionManager } from "./client.js";
import { InvoiceParsingError, parsePurchaseInvoiceXml } from "./invoice-parser.js";
import { formatKsefError } from "./rate-limit.js";

function isoDaysAgo(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString();
}

/** Subject2 = buyer role (purchases), Subject1 = seller role (sales). */
const SUBJECT_TYPES = ["Subject1", "Subject2"] as const;
type SubjectType = (typeof SUBJECT_TYPES)[number];

function parseSubjectType(value: string | undefined): SubjectType {
  if (value === undefined) return "Subject2";
  if ((SUBJECT_TYPES as readonly string[]).includes(value)) return value as SubjectType;
  throw new Error(
    `DUMP_SUBJECT_TYPE must be one of ${SUBJECT_TYPES.join(", ")}; received "${value}"`,
  );
}

async function main() {
  const config = loadConfig();
  const subjectType = parseSubjectType(process.env.DUMP_SUBJECT_TYPE);
  const direction = subjectType === "Subject1" ? "sales" : "purchase";
  const windowDays = Number(process.env.DUMP_WINDOW_DAYS ?? 30);
  const windowFrom = process.env.DUMP_WINDOW_FROM ?? isoDaysAgo(windowDays);
  const windowTo = process.env.DUMP_WINDOW_TO ?? new Date().toISOString();

  const outDir = join(
    process.cwd(),
    "data",
    subjectType === "Subject1" ? "invoices-sales" : "invoices",
  );
  const rawDir = join(outDir, "raw");
  mkdirSync(rawDir, { recursive: true });

  console.log(`Connecting to KSeF (${config.KSEF_ENVIRONMENT}) as NIP ${config.KSEF_NIP}...`);
  const manager = new KsefSessionManager(config);
  const client = await manager.getClient();

  console.log(
    `Fetching ${direction} invoices (${subjectType}) from ${windowFrom} to ${windowTo}...`,
  );
  const exportResult = await client.workflows.exportsIncremental.run({
    subjectType,
    windowFrom,
    windowTo,
    continuationPoints: {},
    requireExportPartHash: true,
    maxIterations: 10,
  });

  const metadataByKsefNumber = new Map<string, Record<string, unknown>>();
  for (const summary of exportResult.metadataSummaries) {
    const ksefNumber =
      (summary as { ksefNumber?: string }).ksefNumber ??
      (summary as { KsefNumber?: string }).KsefNumber;
    if (typeof ksefNumber === "string") {
      metadataByKsefNumber.set(ksefNumber, summary);
    }
  }

  const parsed: unknown[] = [];
  const parseErrors: Array<{ fileName: string; message: string }> = [];

  for (const [fileName, xml] of Object.entries(exportResult.invoiceXmlFiles)) {
    writeFileSync(join(rawDir, fileName), xml, "utf-8");

    const guessedKsefNumber = fileName.replace(/\.xml$/i, "");
    const metadata = metadataByKsefNumber.get(guessedKsefNumber);
    try {
      parsed.push(parsePurchaseInvoiceXml(fileName, xml, metadata));
    } catch (error) {
      const message = error instanceof InvoiceParsingError ? error.message : String(error);
      parseErrors.push({ fileName, message });
    }
  }

  writeFileSync(
    join(outDir, "metadata.json"),
    JSON.stringify(exportResult.metadataSummaries, null, 2),
    "utf-8",
  );
  writeFileSync(join(outDir, "parsed.json"), JSON.stringify(parsed, null, 2), "utf-8");
  writeFileSync(join(outDir, "parse-errors.json"), JSON.stringify(parseErrors, null, 2), "utf-8");

  console.log(
    `\nWrote ${Object.keys(exportResult.invoiceXmlFiles).length} raw invoice XML file(s) to ${rawDir}`,
  );
  console.log(`Parsed ${parsed.length} invoice(s) successfully -> ${join(outDir, "parsed.json")}`);
  console.log(
    `${parseErrors.length} invoice(s) failed to parse -> ${join(outDir, "parse-errors.json")}`,
  );
}

main().catch((error) => {
  console.error("KSeF invoice dump failed:", formatKsefError(error));
  process.exitCode = 1;
});
