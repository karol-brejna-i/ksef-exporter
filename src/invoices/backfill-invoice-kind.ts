import { and, isNotNull, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { INVOICE_KIND_VALUES, type InvoiceKind, updateInvoiceKind } from "../db/invoices.js";
import { invoices } from "../db/schema.js";
import { extractInvoiceKind, parseInvoiceFaElement } from "../ksef/invoice-parser.js";

/** Options for the backfill operation. Mirrors backfill-items.ts's BackfillOptions. */
export interface BackfillKindOptions {
  /** Parse and report, but write nothing. */
  dryRun?: boolean;
  /**
   * Re-derive `invoice_kind` for invoices that already have it. By default,
   * only invoices with `invoice_kind IS NULL` are processed, making the
   * backfill resumable and idempotent.
   */
  force?: boolean;
  /** Maximum number of invoices to process. Omit to process all eligible. */
  limit?: number;
}

export interface InvoiceKindBackfillResult {
  invoiceId: number;
  ksefNumber: string | null;
  status: "success" | "skipped" | "failed";
  invoiceKind?: InvoiceKind;
  /** Human-readable reason when status is "skipped" or "failed". */
  message?: string;
}

export interface BackfillKindSummary {
  totalEligible: number;
  processed: number;
  succeeded: number;
  skipped: number;
  failed: number;
  results: InvoiceKindBackfillResult[];
}

const isKnownInvoiceKind = (value: string): value is InvoiceKind =>
  (INVOICE_KIND_VALUES as readonly string[]).includes(value);

/**
 * Backfills `invoices.invoice_kind` from stored `raw_xml`. Offline, no KSeF
 * calls, per design/SALES_INVOICES_PLAN.md Step 2b.
 *
 * An invoice whose RodzajFaktury is absent is skipped (not failed) -- older
 * imports may predate this field. An invoice whose RodzajFaktury doesn't
 * match one of the 7 XSD values is failed rather than written, since the
 * column has a CHECK constraint enforcing exactly those values.
 */
export async function backfillInvoiceKind(
  db: Db,
  options: BackfillKindOptions = {},
): Promise<BackfillKindSummary> {
  const { dryRun = false, force = false, limit = Number.POSITIVE_INFINITY } = options;

  const whereConditions = [isNotNull(invoices.rawXml)];
  if (!force) {
    whereConditions.push(isNull(invoices.invoiceKind));
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

  const results: InvoiceKindBackfillResult[] = [];

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
      const rawKind = extractInvoiceKind(fa);

      if (rawKind === null) {
        results.push({
          invoiceId: invoice.id,
          ksefNumber: invoice.ksefNumber,
          status: "skipped",
          message: "RodzajFaktury not present in raw_xml",
        });
        continue;
      }

      if (!isKnownInvoiceKind(rawKind)) {
        results.push({
          invoiceId: invoice.id,
          ksefNumber: invoice.ksefNumber,
          status: "failed",
          message: `Unrecognized RodzajFaktury value: ${rawKind}`,
        });
        continue;
      }

      if (!dryRun) {
        await updateInvoiceKind(db, invoice.id, rawKind);
      }

      results.push({
        invoiceId: invoice.id,
        ksefNumber: invoice.ksefNumber,
        status: "success",
        invoiceKind: rawKind,
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
