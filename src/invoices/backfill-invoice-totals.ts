import { and, isNotNull, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { type InvoiceTotalsUpdate, updateInvoiceTotals } from "../db/invoices.js";
import { invoices } from "../db/schema.js";
import {
  extractNetTotal,
  extractPaymentDueDate,
  extractVatTotal,
  parseInvoiceFaElement,
} from "../ksef/invoice-parser.js";

/** Options for the backfill operation. Mirrors backfill-invoice-kind.ts's BackfillKindOptions. */
export interface BackfillTotalsOptions {
  /** Parse and report, but write nothing. */
  dryRun?: boolean;
  /**
   * Re-derive the three fields for invoices that already have at least one of
   * them set. By default, only invoices where all three are NULL are
   * processed, making the backfill resumable and idempotent.
   */
  force?: boolean;
  /** Maximum number of invoices to process. Omit to process all eligible. */
  limit?: number;
}

export interface InvoiceTotalsBackfillResult {
  invoiceId: number;
  ksefNumber: string | null;
  status: "success" | "skipped" | "failed";
  totals?: InvoiceTotalsUpdate;
  /** Human-readable reason when status is "skipped" or "failed". */
  message?: string;
}

export interface BackfillTotalsSummary {
  totalEligible: number;
  processed: number;
  succeeded: number;
  skipped: number;
  failed: number;
  results: InvoiceTotalsBackfillResult[];
}

/**
 * Backfills `invoices.net_total`, `invoices.vat_total`, and
 * `invoices.payment_due_date` from stored `raw_xml`. Offline, no KSeF calls,
 * per design/INVOICE_HEADER_FIELDS_PLAN.md §6.1/§7.
 *
 * All three fields are supplementary (never required), so an invoice with
 * none of the underlying XML elements present is "success" with all three
 * null, not "skipped" -- there is nothing malformed about it, unlike
 * `backfillInvoiceKind`'s unrecognized-enum-value case. Only an unparseable
 * `raw_xml` document itself fails a row.
 */
export async function backfillInvoiceTotals(
  db: Db,
  options: BackfillTotalsOptions = {},
): Promise<BackfillTotalsSummary> {
  const { dryRun = false, force = false, limit = Number.POSITIVE_INFINITY } = options;

  const whereConditions = [isNotNull(invoices.rawXml)];
  if (!force) {
    whereConditions.push(
      isNull(invoices.netTotal),
      isNull(invoices.vatTotal),
      isNull(invoices.paymentDueDate),
    );
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

  const results: InvoiceTotalsBackfillResult[] = [];

  for (const invoice of eligibleInvoices) {
    if (invoice.rawXml === null) {
      results.push({
        invoiceId: invoice.id,
        ksefNumber: invoice.ksefNumber,
        status: "skipped",
        message: "raw_xml is null",
      });
      continue;
    }

    try {
      const fa = parseInvoiceFaElement(
        invoice.rawXml,
        invoice.ksefNumber ?? `invoice-${invoice.id}`,
      );
      const totals: InvoiceTotalsUpdate = {
        netTotal: extractNetTotal(fa),
        vatTotal: extractVatTotal(fa),
        paymentDueDate: extractPaymentDueDate(fa),
      };

      if (!dryRun) {
        await updateInvoiceTotals(db, invoice.id, totals);
      }

      results.push({
        invoiceId: invoice.id,
        ksefNumber: invoice.ksefNumber,
        status: "success",
        totals,
      });
    } catch (error) {
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
    results,
  };
}
