import type { Db } from "../db/client.js";
import { getInvoiceById, type InvoiceRow, updateInvoiceCategory } from "../db/invoices.js";
import { upsertRule } from "../db/rules.js";

export class InvoiceNotFoundError extends Error {
  constructor(invoiceId: number) {
    super(`Invoice ${invoiceId} not found`);
    this.name = "InvoiceNotFoundError";
  }
}

/**
 * Human correction of a category (HU-04, SPEC §4): updates the invoice's
 * stored category (now `matched` confidence -- a human confirmed it, so
 * it's no longer `needs_review`), and creates/updates a Tier-1 rule so
 * future invoices from the same seller auto-categorize the same way.
 * Prefers a seller-NIP rule (stable, preferred per SPEC §4); falls back to
 * a seller-name-contains rule using the full seller name when no NIP is
 * available (e.g. some manual entries). Re-correcting an already-ruled
 * seller updates that existing rule rather than creating a conflicting
 * duplicate (`upsertRule`'s own guarantee).
 */
export async function correctInvoiceCategory(
  db: Db,
  invoiceId: number,
  categoryId: number,
): Promise<InvoiceRow> {
  const invoice = await getInvoiceById(db, invoiceId);
  if (!invoice) {
    throw new InvoiceNotFoundError(invoiceId);
  }

  if (invoice.sellerNip !== null) {
    await upsertRule(db, { matchType: "seller_nip", matchValue: invoice.sellerNip, categoryId });
  } else {
    await upsertRule(db, {
      matchType: "seller_name_contains",
      matchValue: invoice.sellerName,
      categoryId,
    });
  }

  return updateInvoiceCategory(db, invoiceId, categoryId, "matched");
}
