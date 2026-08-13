import { asc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { invoiceItems, invoices } from "./schema.js";

/**
 * A persisted invoice line item. Corresponds to one FaWiersz element in the
 * invoice XML, preserving document order via `ordinal`.
 */
export interface InvoiceItemRow {
  id: number;
  invoiceId: number;
  ordinal: number;
  lineNumber: number | null;
  uuId: string | null;
  deliveryDate: string | null;
  name: string | null;
  indexCode: string | null;
  gtin: string | null;
  pkwiu: string | null;
  cn: string | null;
  pkob: string | null;
  unit: string | null;
  quantity: number | null;
  unitPriceNet: number | null;
  unitPriceGross: number | null;
  discount: number | null;
  netValue: number | null;
  grossValue: number | null;
  vatValue: number | null;
  vatRate: string | null;
  vatRateOss: number | null;
  annex15: boolean | null;
  excise: number | null;
  gtuCode: string | null;
  procedureCode: string | null;
  exchangeRate: number | null;
  correctionStateBefore: boolean | null;
}

/**
 * Input for creating a new invoice item. Omits the auto-generated `id` field.
 */
export interface NewInvoiceItem {
  invoiceId: number;
  ordinal: number;
  lineNumber?: number | null;
  uuId?: string | null;
  deliveryDate?: string | null;
  name?: string | null;
  indexCode?: string | null;
  gtin?: string | null;
  pkwiu?: string | null;
  cn?: string | null;
  pkob?: string | null;
  unit?: string | null;
  quantity?: number | null;
  unitPriceNet?: number | null;
  unitPriceGross?: number | null;
  discount?: number | null;
  netValue?: number | null;
  grossValue?: number | null;
  vatValue?: number | null;
  vatRate?: string | null;
  vatRateOss?: number | null;
  annex15?: boolean | null;
  excise?: number | null;
  gtuCode?: string | null;
  procedureCode?: string | null;
  exchangeRate?: number | null;
  correctionStateBefore?: boolean | null;
}

/** Rows per INSERT statement; see the comment in `replaceInvoiceItems`. */
const ITEM_INSERT_CHUNK = 500;

/**
 * Replaces all items for an invoice with the given set, inside a single
 * transaction. Also stamps `invoices.items_extracted_at` so "items written"
 * and "extraction recorded" can never disagree.
 *
 * This is the idempotent write path for item extraction: calling it twice
 * with the same items yields the same row count with no duplicates.
 *
 * An empty `items` array is valid (FaWiersz is minOccurs=0 in FA(3)) and
 * still stamps the timestamp, recording that extraction was attempted and
 * found zero items.
 */
export function replaceInvoiceItems(db: Db, invoiceId: number, items: NewInvoiceItem[]): void {
  db.transaction((tx) => {
    // Delete existing items for this invoice
    tx.delete(invoiceItems).where(eq(invoiceItems.invoiceId, invoiceId)).run();

    // Chunked, not one multi-row insert: SQLite caps bound parameters per
    // statement (SQLITE_MAX_VARIABLE_NUMBER, 32766 in the bundled build), and
    // at 27 columns per row a single statement would break somewhere past
    // ~1200 lines. Real invoices top out at 61 items, but FaWiersz is
    // maxOccurs="10000" in FA(3), so the limit is reachable by a legal document.
    for (let start = 0; start < items.length; start += ITEM_INSERT_CHUNK) {
      tx.insert(invoiceItems)
        .values(items.slice(start, start + ITEM_INSERT_CHUNK))
        .run();
    }

    // Stamp the extraction timestamp
    tx.update(invoices)
      .set({ itemsExtractedAt: new Date().toISOString() })
      .where(eq(invoices.id, invoiceId))
      .run();
  });
}

/**
 * Lists all items for an invoice, ordered by `ordinal` (document order).
 * Returns an empty array if the invoice has no items (or doesn't exist).
 */
export async function listInvoiceItems(db: Db, invoiceId: number): Promise<InvoiceItemRow[]> {
  return db
    .select()
    .from(invoiceItems)
    .where(eq(invoiceItems.invoiceId, invoiceId))
    .orderBy(asc(invoiceItems.ordinal))
    .all();
}

/**
 * Counts items per invoice for the given invoice IDs.
 *
 * Returns a map from invoice ID to item count. Invoices that exist but have
 * zero items are **absent** from the map (SQL GROUP BY naturally omits them).
 * An empty `invoiceIds` array returns an empty map without emitting invalid SQL.
 *
 * The API layer can distinguish "invoice has zero items" from "invoice doesn't
 * exist" by checking the invoices table separately.
 */
export async function countInvoiceItemsByInvoice(
  db: Db,
  invoiceIds: number[],
): Promise<Map<number, number>> {
  if (invoiceIds.length === 0) {
    return new Map();
  }

  const rows = await db
    .select({
      invoiceId: invoiceItems.invoiceId,
      count: sql<number>`count(*)`,
    })
    .from(invoiceItems)
    .where(inArray(invoiceItems.invoiceId, invoiceIds))
    .groupBy(invoiceItems.invoiceId)
    .all();

  return new Map(rows.map((row) => [row.invoiceId, row.count]));
}
