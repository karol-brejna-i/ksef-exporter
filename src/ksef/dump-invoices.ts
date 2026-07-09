/**
 * Manual utility (NOT part of the automated test suite, real network calls,
 * real data) that dumps purchase invoices from a real KSeF environment
 * (TEST/DEMO/PRD, per `KSEF_ENVIRONMENT`) to the local filesystem, so we
 * have a stable, offline sample of real-world invoice shapes to develop
 * and test against (e.g. parser edge cases like namespace-prefixed XML
 * that don't show up in hand-written fixtures).
 *
 * Writes to `data/invoices/` (gitignored -- this is real business data and
 * must never be committed):
 *   - raw/<file-name>.xml   one file per invoice, exactly as received
 *   - metadata.json         the raw `_metadata.json` summaries for this run
 *   - parsed.json           this app's flat PurchaseInvoiceRecord for each
 *                           invoice that parsed successfully
 *   - parse-errors.json     file name + error message for any that didn't
 *
 * Usage:
 *   pnpm run dump:invoices                    # last 30 days
 *   DUMP_WINDOW_DAYS=90 pnpm run dump:invoices
 */
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config/env.js";
import { KsefSessionManager } from "./client.js";
import { InvoiceParsingError, parsePurchaseInvoiceXml } from "./invoice-parser.js";

function isoDaysAgo(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString();
}

async function main() {
  const config = loadConfig();
  const windowDays = Number(process.env.DUMP_WINDOW_DAYS ?? 30);
  const windowFrom = isoDaysAgo(windowDays);
  const windowTo = new Date().toISOString();

  const outDir = join(process.cwd(), "data", "invoices");
  const rawDir = join(outDir, "raw");
  mkdirSync(rawDir, { recursive: true });

  console.log(`Connecting to KSeF (${config.KSEF_ENVIRONMENT}) as NIP ${config.KSEF_NIP}...`);
  const manager = new KsefSessionManager(config);
  const client = await manager.getClient();

  console.log(`Fetching purchase invoices from ${windowFrom} to ${windowTo}...`);
  const exportResult = await client.workflows.exportsIncremental.run({
    subjectType: "Subject2",
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
  console.error("KSeF invoice dump failed:", error);
  process.exitCode = 1;
});
