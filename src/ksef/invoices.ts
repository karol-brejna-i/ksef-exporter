import type { ContinuationPoints, IncrementalExportResult, KsefClient } from "ksef-client";
import { type PurchaseInvoiceRecord, parsePurchaseInvoiceXml } from "./invoice-parser.js";

/**
 * "Subject2" is the buyer role in KSeF's model (see design/SPEC.md §3).
 * Parkowa is always the buyer for the purchase invoices this app pulls.
 */
const PURCHASE_INVOICE_SUBJECT_TYPE = "Subject2";

export interface FetchPurchaseInvoicesOptions {
  /** Start of the overall date range to sync, ISO date or date-time. */
  windowFrom: string;
  /** End of the overall date range to sync, ISO date or date-time. */
  windowTo: string;
  /**
   * High-water-mark continuation state from a previous run (per subject
   * type), as returned by a previous call. Pass `{}` for a first-ever sync.
   */
  continuationPoints: ContinuationPoints;
  /** Safety cap on how many export iterations a single call may perform. */
  maxIterations?: number;
  pollIntervalMs?: number;
  maxAttempts?: number;
}

export interface FetchPurchaseInvoicesResult {
  invoices: PurchaseInvoiceRecord[];
  /** Updated continuation state; persist and pass into the next call. */
  continuationPoints: ContinuationPoints;
  referenceNumbers: string[];
}

/**
 * Fetches all purchase invoices (KSeF `Subject2` / buyer role) for the given
 * window, using the SDK's incremental export workflow.
 *
 * `client.workflows.exportsIncremental` already implements the full
 * start-export -> poll -> download -> decrypt -> unzip -> dedupe -> HWM
 * continuation flow described in design/SPEC.md §3.2, defaulting to
 * `DateType = PermanentStorage` (the SPEC-mandated, delay-immune date type
 * for incremental sync). This function only adapts inputs/outputs and
 * parses the returned invoice XML into our flat data model.
 */
export async function fetchPurchaseInvoices(
  client: Pick<KsefClient, "workflows">,
  options: FetchPurchaseInvoicesOptions,
): Promise<FetchPurchaseInvoicesResult> {
  const result: IncrementalExportResult = await client.workflows.exportsIncremental.run({
    subjectType: PURCHASE_INVOICE_SUBJECT_TYPE,
    windowFrom: options.windowFrom,
    windowTo: options.windowTo,
    continuationPoints: options.continuationPoints,
    requireExportPartHash: true,
    ...(options.maxIterations !== undefined ? { maxIterations: options.maxIterations } : {}),
    ...(options.pollIntervalMs !== undefined ? { pollIntervalMs: options.pollIntervalMs } : {}),
    ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
  });

  const metadataByKsefNumber = new Map<string, Record<string, unknown>>();
  for (const summary of result.metadataSummaries) {
    const ksefNumber = summary.ksefNumber ?? summary.KsefNumber;
    if (typeof ksefNumber === "string") {
      metadataByKsefNumber.set(ksefNumber, summary);
    }
  }

  const invoices = Object.entries(result.invoiceXmlFiles).map(([fileName, xml]) => {
    const guessedKsefNumber = fileName.replace(/\.xml$/i, "");
    const metadata = metadataByKsefNumber.get(guessedKsefNumber);
    return parsePurchaseInvoiceXml(fileName, xml, metadata);
  });

  return {
    invoices,
    continuationPoints: result.continuationPoints,
    referenceNumbers: result.referenceNumbers,
  };
}
