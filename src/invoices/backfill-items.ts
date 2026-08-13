import { and, isNotNull, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { replaceInvoiceItems } from "../db/invoice-items.js";
import { invoices } from "../db/schema.js";
import {
  extractInvoiceItems,
  type InvoiceItemRecord,
  parseAmount,
  parseInvoiceFaElement,
} from "../ksef/invoice-parser.js";

/**
 * Options for the backfill operation.
 */
export interface BackfillOptions {
  /**
   * Parse and report, but write nothing. Items are parsed from raw_xml and
   * validated, but no database writes occur. Use to preview what a full
   * backfill would do, or to verify a parser improvement before committing
   * the results.
   */
  dryRun?: boolean;

  /**
   * Re-derive items for invoices that already have them (items_extracted_at
   * IS NOT NULL). Use after a parser improvement to regenerate every item
   * from raw_xml. By default, only invoices with items_extracted_at IS NULL
   * are processed, making the backfill resumable and idempotent.
   */
  force?: boolean;

  /**
   * Maximum number of invoices to process. Use to test on a small sample or
   * to split a large backfill into batches. Omit (or pass Infinity) to
   * process all eligible invoices.
   */
  limit?: number;
}

/**
 * Result of processing a single invoice.
 */
export interface InvoiceBackfillResult {
  invoiceId: number;
  ksefNumber: string | null;
  status: "success" | "skipped" | "failed";
  itemsCount?: number;
  /** Human-readable reason when status is "skipped" or "failed". */
  message?: string;
}

/**
 * Aggregate result of a backfill run.
 */
export interface BackfillSummary {
  totalEligible: number;
  processed: number;
  succeeded: number;
  skipped: number;
  failed: number;
  /**
   * Items successfully derived from raw_xml. Reported in `--dry-run` too --
   * it is the number a subsequent live run would write, and the figure
   * design/INVOICE_ITEMS_PLAN.md §8 expects the dry run to print (2 437).
   */
  itemsParsed: number;
  /** Items actually written. Always 0 in `--dry-run`. */
  itemsInserted: number;
  results: InvoiceBackfillResult[];
  /**
   * Per-VAT-rate reconciliation diagnostics, excluding invoices with
   * StanPrzed rows and invoices with any gross-priced lines (no P_11).
   * Non-blocking: mismatches are reported but do not fail the backfill.
   */
  reconciliation: ReconciliationReport;
}

/**
 * Per-VAT-rate reconciliation summary, per design/INVOICE_ITEMS_PLAN.md §3.6.
 */
export interface ReconciliationReport {
  /**
   * Number of invoices eligible for reconciliation (has items, no
   * StanPrzed, all items have P_11).
   */
  eligibleCount: number;
  /** Number of invoices that matched within tolerance. */
  matchedCount: number;
  /** Invoices that mismatched, with details. */
  mismatches: ReconciliationMismatch[];
}

export interface ReconciliationMismatch {
  invoiceId: number;
  ksefNumber: string | null;
  vatRate: string;
  expectedFromHeader: number;
  actualFromItems: number;
  delta: number;
}

/**
 * The per-VAT-rate header fields, per FA(3) schema. These are the net bases
 * that items should sum to.
 */
const VAT_RATE_HEADER_MAP: Record<string, string> = {
  "23": "P_13_1",
  "8": "P_13_2",
  "5": "P_13_3",
  zw: "P_13_7",
};

const RECONCILIATION_TOLERANCE = 0.01;

/**
 * Backfills invoice items from stored raw_xml.
 *
 * Selects invoices WHERE raw_xml IS NOT NULL AND (items_extracted_at IS NULL
 * OR :force), parses items from raw_xml, and writes them via
 * replaceInvoiceItems. Makes zero KSeF calls: this is the entire point of the
 * step (no quota consumed, no re-import, no rate-limit exposure).
 *
 * An invoice whose raw_xml fails to parse is reported as failed, never fatal
 * (design/INVOICE_ITEMS_PLAN.md §6.1/§6.4). One bad invoice does not abort the
 * run, and because items_extracted_at is only stamped on success, a later run
 * retries it without --force.
 */
export async function backfillInvoiceItems(
  db: Db,
  options: BackfillOptions = {},
): Promise<BackfillSummary> {
  const { dryRun = false, force = false, limit = Number.POSITIVE_INFINITY } = options;

  // Select eligible invoices: those with raw_xml, and either not yet
  // extracted or force is true.
  const whereConditions = [isNotNull(invoices.rawXml)];
  if (!force) {
    whereConditions.push(isNull(invoices.itemsExtractedAt));
  }

  const baseQuery = db
    .select({
      id: invoices.id,
      ksefNumber: invoices.ksefNumber,
      rawXml: invoices.rawXml,
    })
    .from(invoices)
    .where(and(...whereConditions));

  const eligibleInvoices = await (Number.isFinite(limit)
    ? baseQuery.limit(limit).all()
    : baseQuery.all());

  const results: InvoiceBackfillResult[] = [];
  const reconciliationInputs: ReconciliationInput[] = [];
  let itemsParsed = 0;
  let itemsInserted = 0;

  for (const invoice of eligibleInvoices) {
    if (invoice.rawXml === null) {
      // Safety: the query filters this out, but TypeScript doesn't know.
      results.push({
        invoiceId: invoice.id,
        ksefNumber: invoice.ksefNumber,
        status: "skipped",
        message: "raw_xml is null",
      });
      continue;
    }

    try {
      // Parse the Fa element once, then read both the items and the P_13_x
      // net bases off it. Deliberately NOT parsePurchaseInvoiceXml: these
      // invoices were already imported, so their header is persisted and
      // re-validating it here would only create a way to lose items (see
      // parseInvoiceFaElement's note).
      const fa = parseInvoiceFaElement(
        invoice.rawXml,
        invoice.ksefNumber ?? `invoice-${invoice.id}`,
      );
      const items = extractInvoiceItems(fa);

      if (!dryRun) {
        // replaceInvoiceItems is synchronous (better-sqlite3 transactions
        // cannot await) -- do not await it.
        replaceInvoiceItems(
          db,
          invoice.id,
          items.map((item) => ({ ...item, invoiceId: invoice.id })),
        );
        itemsInserted += items.length;
      }

      itemsParsed += items.length;
      reconciliationInputs.push({
        invoiceId: invoice.id,
        ksefNumber: invoice.ksefNumber,
        items,
        fa,
      });
      results.push({
        invoiceId: invoice.id,
        ksefNumber: invoice.ksefNumber,
        status: "success",
        itemsCount: items.length,
      });
    } catch (error) {
      // Per §6.1 a failure here is reported, never fatal: the invoice keeps
      // its header row and items_extracted_at stays NULL, so a later run (or
      // a parser fix) can retry it.
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        invoiceId: invoice.id,
        ksefNumber: invoice.ksefNumber,
        status: "failed",
        message,
      });
    }
  }

  const succeeded = results.filter((r) => r.status === "success").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  const failed = results.filter((r) => r.status === "failed").length;

  return {
    totalEligible: eligibleInvoices.length,
    processed: results.length,
    succeeded,
    skipped,
    failed,
    itemsParsed,
    itemsInserted,
    results,
    reconciliation: buildReconciliationReport(reconciliationInputs),
  };
}

/** One invoice's parsed material, carried from the main loop. */
interface ReconciliationInput {
  invoiceId: number;
  ksefNumber: string | null;
  items: InvoiceItemRecord[];
  fa: Record<string, unknown>;
}

/**
 * Builds the per-VAT-rate reconciliation report, per
 * design/INVOICE_ITEMS_PLAN.md §3.6.
 *
 * Excludes:
 * - Invoices with any StanPrzed row (corrections double-count every line).
 * - Invoices with any row lacking P_11 (gross-priced; there is no net to sum).
 *
 * Compares the sum of item P_11 per P_12 rate against the corresponding header
 * P_13_x net base, with a 0.01 PLN tolerance. Note this is the per-rate check,
 * NOT total item net against P_13_1 -- P_13_1 is only the 23% base, and the
 * naive version fails on 69 of 249 real invoices (§3.6).
 *
 * Works off the items held in memory rather than re-reading them, so a
 * `--dry-run` reconciles too. Reading them back would have reported
 * eligibleCount 0 for every dry run, since nothing was written.
 */
function buildReconciliationReport(inputs: ReconciliationInput[]): ReconciliationReport {
  const mismatches: ReconciliationMismatch[] = [];
  let eligibleCount = 0;
  let matchedCount = 0;

  for (const { invoiceId, ksefNumber, items, fa } of inputs) {
    if (items.length === 0) {
      continue;
    }
    if (items.some((item) => item.correctionStateBefore === true)) {
      continue;
    }
    if (items.some((item) => item.netValue === null)) {
      continue;
    }

    eligibleCount++;
    let invoiceMatched = true;

    for (const [rate, headerField] of Object.entries(VAT_RATE_HEADER_MAP)) {
      const rateItems = items.filter((item) => item.vatRate === rate);
      if (rateItems.length === 0) {
        continue;
      }

      const headerValue = parseAmount(fa[headerField]);
      if (headerValue === undefined) {
        // The invoice has items at this rate but no matching header base.
        // Not something this report is designed to adjudicate; skip rather
        // than invent an expected value of 0.
        continue;
      }

      const itemsSum = rateItems.reduce((sum, item) => sum + (item.netValue ?? 0), 0);
      const delta = Math.abs(itemsSum - headerValue);
      if (delta > RECONCILIATION_TOLERANCE) {
        invoiceMatched = false;
        mismatches.push({
          invoiceId,
          ksefNumber,
          vatRate: rate,
          expectedFromHeader: headerValue,
          actualFromItems: itemsSum,
          delta,
        });
      }
    }

    if (invoiceMatched) {
      matchedCount++;
    }
  }

  return { eligibleCount, matchedCount, mismatches };
}
