import { and, eq, like } from "drizzle-orm";
import type { Db } from "./client.js";
import { invoices } from "./schema.js";

export type CategorizationConfidence = "matched" | "needs_review";

export interface InvoiceRow {
  id: number;
  source: "ksef" | "manual";
  ksefNumber: string | null;
  invoiceNumber: string;
  sellerNip: string | null;
  sellerName: string;
  buyerNip: string | null;
  buyerName: string | null;
  issueDate: string;
  grossTotal: number;
  currency: string;
  rawXml: string | null;
  /** NULL = line-item extraction never attempted; see design/INVOICE_ITEMS_PLAN.md §6.3. */
  itemsExtractedAt: string | null;
  categoryId: number | null;
  categorizationConfidence: CategorizationConfidence;
  createdAt: string;
}

export interface NewKsefInvoice {
  ksefNumber: string;
  invoiceNumber: string;
  sellerNip: string;
  sellerName: string;
  buyerNip?: string | null;
  buyerName?: string | null;
  issueDate: string;
  grossTotal: number;
  currency: string;
  rawXml: string;
}

export interface NewManualInvoice {
  invoiceNumber: string;
  sellerNip?: string | null;
  sellerName: string;
  buyerNip?: string | null;
  buyerName?: string | null;
  issueDate: string;
  grossTotal: number;
  currency: string;
}

/**
 * Inserts a KSeF-sourced invoice, doing nothing if an invoice with the same
 * `ksefNumber` already exists (SPEC §3.2 dedup is already applied upstream,
 * but re-running a sync window must still be safe/idempotent at the
 * persistence layer -- and must never silently overwrite a category a
 * human may have already assigned).
 */
export async function insertKsefInvoiceIfNotExists(
  db: Db,
  invoice: NewKsefInvoice,
): Promise<InvoiceRow> {
  await db
    .insert(invoices)
    .values({ source: "ksef", ...invoice })
    .onConflictDoNothing({ target: invoices.ksefNumber })
    .run();

  const existing = await getInvoiceByKsefNumber(db, invoice.ksefNumber);
  if (!existing) {
    throw new Error(`Failed to insert or find invoice ${invoice.ksefNumber}`);
  }
  return existing;
}

export async function insertManualInvoice(db: Db, invoice: NewManualInvoice): Promise<InvoiceRow> {
  const [row] = await db
    .insert(invoices)
    .values({ source: "manual", ksefNumber: null, rawXml: null, ...invoice })
    .returning();
  if (!row) {
    throw new Error("Failed to create manual invoice: no row returned");
  }
  return row;
}

export async function getInvoiceByKsefNumber(
  db: Db,
  ksefNumber: string,
): Promise<InvoiceRow | undefined> {
  return db.query.invoices.findFirst({ where: eq(invoices.ksefNumber, ksefNumber) });
}

export async function getInvoiceById(db: Db, id: number): Promise<InvoiceRow | undefined> {
  return db.query.invoices.findFirst({ where: eq(invoices.id, id) });
}

export interface ListInvoicesFilter {
  /** "YYYY-MM"; matches invoices whose issueDate falls in that month. */
  month?: string | undefined;
  categoryId?: number | undefined;
}

export async function listInvoices(db: Db, filter: ListInvoicesFilter = {}): Promise<InvoiceRow[]> {
  const conditions = [];
  if (filter.month) {
    conditions.push(like(invoices.issueDate, `${filter.month}%`));
  }
  if (filter.categoryId !== undefined) {
    conditions.push(eq(invoices.categoryId, filter.categoryId));
  }

  const query = db.select().from(invoices);
  if (conditions.length === 0) {
    return query.all();
  }
  return query.where(and(...conditions)).all();
}

export async function updateInvoiceCategory(
  db: Db,
  invoiceId: number,
  categoryId: number,
  confidence: CategorizationConfidence,
): Promise<InvoiceRow> {
  const [row] = await db
    .update(invoices)
    .set({ categoryId, categorizationConfidence: confidence })
    .where(eq(invoices.id, invoiceId))
    .returning();
  if (!row) {
    throw new Error(`Invoice ${invoiceId} not found`);
  }
  return row;
}
