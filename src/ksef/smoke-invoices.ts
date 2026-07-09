/**
 * Manual smoke test for purchase invoice extraction (Phase 2/4).
 *
 * NOT part of the automated test suite (no assertions, real network calls,
 * real data). Use this to confirm the app can actually see purchase
 * invoices in a real KSeF environment (TEST/DEMO/PRD, per `KSEF_ENVIRONMENT`)
 * before trusting the pipeline end-to-end.
 *
 * Does NOT write to the application database -- this only calls the KSeF
 * API and prints a summary, so it's safe to run repeatedly against
 * production without affecting local state.
 *
 * Usage:
 *   pnpm run smoke:invoices                  # last 30 days
 *   SMOKE_WINDOW_DAYS=90 pnpm run smoke:invoices
 */
import "dotenv/config";
import { loadConfig } from "../config/env.js";
import { KsefSessionManager } from "./client.js";
import { fetchPurchaseInvoices } from "./invoices.js";

function isoDaysAgo(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString();
}

async function main() {
  const config = loadConfig();
  const windowDays = Number(process.env.SMOKE_WINDOW_DAYS ?? 30);
  const windowFrom = isoDaysAgo(windowDays);
  const windowTo = new Date().toISOString();

  console.log(`Connecting to KSeF (${config.KSEF_ENVIRONMENT}) as NIP ${config.KSEF_NIP}...`);
  const manager = new KsefSessionManager(config);
  const client = await manager.getClient();

  console.log(`Fetching purchase invoices from ${windowFrom} to ${windowTo}...`);
  const result = await fetchPurchaseInvoices(client, {
    windowFrom,
    windowTo,
    continuationPoints: {},
    maxIterations: 5,
  });

  console.log(`\nFound ${result.invoices.length} purchase invoice(s).`);
  for (const invoice of result.invoices) {
    console.log(
      `- ${invoice.issueDate} | ${invoice.sellerName} (NIP ${invoice.sellerNip}) | ${invoice.grossTotal} ${invoice.currency} | KSeF# ${invoice.ksefNumber}`,
    );
  }

  if (result.invoices.length === 0) {
    console.log(
      "No invoices found in this window -- this may be expected (no purchases in range) or may indicate a permissions/configuration issue.",
    );
  }
}

main().catch((error) => {
  console.error("KSeF invoice smoke test failed:", error);
  process.exitCode = 1;
});
