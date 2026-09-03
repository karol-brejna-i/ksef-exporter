import { existsSync, statSync } from "node:fs";
import Database from "better-sqlite3";
import { and, asc, desc, eq, gte, inArray, lte } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { CategorizationConfidence, InvoiceDirection, InvoiceKind } from "../db/invoices.js";
import { categories, invoiceItems, invoices } from "../db/schema.js";
import type { IsoDate } from "../time.js";

/**
 * One invoice as returned by the export, minus `raw_xml` (never leaves this
 * module) and `category_id` (replaced by the joined `categoryName`).
 */
export interface ExportInvoiceRow {
  id: number;
  source: "ksef" | "manual";
  direction: InvoiceDirection;
  ksefNumber: string | null;
  invoiceNumber: string;
  invoiceKind: InvoiceKind | null;
  issueDate: string;
  paymentDueDate: string | null;
  sellerNip: string | null;
  sellerName: string;
  buyerNip: string | null;
  buyerName: string | null;
  netTotal: number | null;
  vatTotal: number | null;
  grossTotal: number;
  currency: string;
  categoryName: string | null;
  categorizationConfidence: CategorizationConfidence;
  itemsExtractedAt: Date | null;
  createdAt: Date;
}

/** Optional inclusive bounds on `issueDate`. Both ends are civil dates. */
export interface ExportFilter {
  from?: IsoDate;
  to?: IsoDate;
}

/**
 * Fetches invoices for export, joined against `categories` so the caller
 * gets a human-readable `categoryName` instead of a bare id. Uses a
 * `leftJoin` (not `innerJoin`): an uncategorized invoice (`categoryId ===
 * null`, e.g. a sales invoice, or a purchase invoice awaiting review) must
 * still be returned, with `categoryName: null`.
 *
 * `filter.from`/`filter.to` bound `issueDate` inclusively on both ends.
 * Comparison is a plain string `gte`/`lte` on the TEXT civil-date column,
 * which is correct here per .github/copilot-instructions.md's "Dates and
 * times" section (both sides are zero-padded `YYYY-MM-DD`) -- do not
 * convert to epoch ms.
 *
 * Results are ordered by `issueDate DESC, invoiceNumber ASC`.
 *
 * Never selects `invoices.rawXml`: the select list is explicit precisely so
 * raw XML can never leak into an export.
 */
export async function fetchExportInvoices(
  db: Db,
  filter: ExportFilter = {},
): Promise<ExportInvoiceRow[]> {
  const conditions = [];
  if (filter.from !== undefined) {
    conditions.push(gte(invoices.issueDate, filter.from));
  }
  if (filter.to !== undefined) {
    conditions.push(lte(invoices.issueDate, filter.to));
  }

  const query = db
    .select({
      id: invoices.id,
      source: invoices.source,
      direction: invoices.direction,
      ksefNumber: invoices.ksefNumber,
      invoiceNumber: invoices.invoiceNumber,
      invoiceKind: invoices.invoiceKind,
      issueDate: invoices.issueDate,
      paymentDueDate: invoices.paymentDueDate,
      sellerNip: invoices.sellerNip,
      sellerName: invoices.sellerName,
      buyerNip: invoices.buyerNip,
      buyerName: invoices.buyerName,
      netTotal: invoices.netTotal,
      vatTotal: invoices.vatTotal,
      grossTotal: invoices.grossTotal,
      currency: invoices.currency,
      categoryName: categories.name,
      categorizationConfidence: invoices.categorizationConfidence,
      itemsExtractedAt: invoices.itemsExtractedAt,
      createdAt: invoices.createdAt,
    })
    .from(invoices)
    .leftJoin(categories, eq(invoices.categoryId, categories.id));

  const filtered = conditions.length > 0 ? query.where(and(...conditions)) : query;

  return filtered.orderBy(desc(invoices.issueDate), asc(invoices.invoiceNumber)).all();
}

/** Every `invoice_items` column, plus identifying fields denormalized from the parent invoice. */
export interface ExportInvoiceItemRow {
  id: number;
  invoiceId: number;
  /** Denormalized from the parent invoice, for a self-contained export row. */
  ksefNumber: string | null;
  invoiceNumber: string;
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
 * The subset of an invoice row `fetchExportInvoiceItems` needs to denormalize
 * `ksefNumber`/`invoiceNumber` onto each item, without requiring the full
 * `ExportInvoiceRow` shape.
 */
export type ExportInvoiceItemsParentInvoice = Pick<
  ExportInvoiceRow,
  "id" | "ksefNumber" | "invoiceNumber"
>;

/**
 * Fetches line items for a batch of invoices in one query (no N+1), ordered
 * by `(invoiceId, ordinal)` -- i.e. grouped by invoice, in document order
 * within each invoice.
 *
 * `parentInvoices` is meant to be the array already returned by
 * `fetchExportInvoices` for this export (or any subset with the same `id`,
 * `ksefNumber`, `invoiceNumber` shape): passing it lets this function build
 * the `invoiceId -> {ksefNumber, invoiceNumber}` lookup it needs to
 * denormalize each item row without re-querying `invoices`. An invoice with
 * zero items simply contributes no rows; it does not need to be filtered
 * out beforehand.
 */
export async function fetchExportInvoiceItems(
  db: Db,
  parentInvoices: readonly ExportInvoiceItemsParentInvoice[],
): Promise<ExportInvoiceItemRow[]> {
  if (parentInvoices.length === 0) {
    return [];
  }

  const parentById = new Map(
    parentInvoices.map((invoice) => [
      invoice.id,
      { ksefNumber: invoice.ksefNumber, invoiceNumber: invoice.invoiceNumber },
    ]),
  );

  const rows = await db
    .select()
    .from(invoiceItems)
    .where(
      inArray(
        invoiceItems.invoiceId,
        parentInvoices.map((invoice) => invoice.id),
      ),
    )
    .orderBy(asc(invoiceItems.invoiceId), asc(invoiceItems.ordinal))
    .all();

  return rows.map((row) => {
    const parent = parentById.get(row.invoiceId);
    if (!parent) {
      throw new Error(`Item ${row.id} references invoice ${row.invoiceId}, not in parentInvoices`);
    }
    return {
      ...row,
      ksefNumber: parent.ksefNumber,
      invoiceNumber: parent.invoiceNumber,
    };
  });
}

/**
 * Validates that `path` is a usable, existing ksef-exporter SQLite database
 * *before* anything calls `createDb(path)` on it. This matters because
 * `createDb` will happily create and migrate a brand-new, empty database at
 * a nonexistent path -- exactly the wrong behavior for e.g. a typo'd export
 * target, where the user needs a clear error, not a silently-created empty
 * file.
 *
 * Checks, in order, throwing a plain `Error` on the first failure:
 * 1. The path exists.
 * 2. It is a regular file, not a directory.
 * 3. It opens as a valid SQLite database.
 * 4. It has an `invoices` table (i.e. looks like a ksef-exporter database).
 *
 * Does not return anything; call `createDb(path)` afterward to actually use
 * the database. Opens its own read-only connection to perform the checks
 * and always closes it before returning or throwing.
 */
export function assertUsableDatabaseFile(path: string): void {
  if (!existsSync(path)) {
    throw new Error(`Database not found: ${path}`);
  }

  if (!statSync(path).isFile()) {
    throw new Error(`Not a file: ${path}`);
  }

  let sqlite: Database.Database;
  try {
    sqlite = new Database(path, { readonly: true, fileMustExist: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Not a valid SQLite database: ${path} (${message})`);
  }

  try {
    // `new Database(..., { fileMustExist: true })` does not itself validate the
    // file format for every kind of garbage input -- a non-SQLite file only
    // fails once something actually reads the header, e.g. this query. So the
    // "invalid SQLite database" check and the "no invoices table" check both
    // happen around this one query, but must stay distinguishable: a
    // genuine read failure means "invalid database", while a clean, empty
    // result means "valid database, wrong schema".
    let table: unknown;
    try {
      table = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='invoices'")
        .get();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Not a valid SQLite database: ${path} (${message})`);
    }

    if (!table) {
      throw new Error(
        `Database has no "invoices" table: ${path} (doesn't look like a ksef-exporter database)`,
      );
    }
  } finally {
    sqlite.close();
  }
}
