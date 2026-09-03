/**
 * Pure builder for the invoice export workbook: turns plain invoice/item row
 * arrays into an in-memory `ExcelJS.Workbook` with two styled worksheets
 * ("Faktury" and "Pozycje"). Has NO database dependency -- the caller (a
 * sibling module, `src/invoices/export-invoices.ts`) is responsible for
 * fetching rows from the DB and mapping them onto the shapes below before
 * calling `buildInvoicesWorkbook`.
 *
 * `export-invoices.ts` does not exist yet as of writing this module, so the
 * row shapes are defined locally here rather than imported. Whoever wires
 * the CLI together should ensure that file's exported shapes stay in sync
 * with these (field names must match exactly).
 */
import ExcelJS from "exceljs";

export interface ExportInvoiceRow {
  id: number;
  source: "ksef" | "manual";
  direction: "purchase" | "sales";
  ksefNumber: string | null;
  invoiceNumber: string;
  invoiceKind: "VAT" | "KOR" | "ZAL" | "ROZ" | "UPR" | "KOR_ZAL" | "KOR_ROZ" | null;
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
  categorizationConfidence: "matched" | "needs_review" | "not_applicable";
  itemsExtractedAt: Date | null;
  createdAt: Date;
}

export interface ExportInvoiceItemRow {
  invoiceId: number;
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

/** Declarative column definition shared by both sheet builders. */
interface ColumnDef<Row> {
  key: keyof Row;
  header: string;
  width: number;
  /** When true, data cells get `numFmt = "#,##0.00"` and right alignment. */
  currency?: boolean;
}

/**
 * Shape of an invoices-sheet row as actually written to the worksheet:
 * identical to `ExportInvoiceRow` except `itemsExtractedAt`/`createdAt` have
 * already been rendered to UTC "YYYY-MM-DD HH:MM:SS" strings (see
 * `formatInstant` and the module doc comment on date handling). Field names
 * match `ExportInvoiceRow` exactly, so column keys/headers are unaffected.
 */
type InvoiceSheetRow = Omit<ExportInvoiceRow, "itemsExtractedAt" | "createdAt"> & {
  itemsExtractedAt: string | null;
  createdAt: string;
};

const INVOICE_COLUMNS: Array<ColumnDef<InvoiceSheetRow>> = [
  { key: "source", header: "Źródło", width: 10 },
  { key: "direction", header: "Kierunek", width: 12 },
  { key: "ksefNumber", header: "Numer KSeF", width: 38 },
  { key: "invoiceNumber", header: "Numer faktury", width: 24 },
  { key: "invoiceKind", header: "Rodzaj faktury", width: 14 },
  { key: "issueDate", header: "Data wystawienia", width: 14 },
  { key: "paymentDueDate", header: "Termin płatności", width: 14 },
  { key: "sellerNip", header: "NIP sprzedawcy", width: 14 },
  { key: "sellerName", header: "Sprzedawca", width: 40 },
  { key: "buyerNip", header: "NIP nabywcy", width: 14 },
  { key: "buyerName", header: "Nabywca", width: 40 },
  { key: "netTotal", header: "Netto", width: 12, currency: true },
  { key: "vatTotal", header: "VAT", width: 12, currency: true },
  { key: "grossTotal", header: "Brutto", width: 12, currency: true },
  { key: "currency", header: "Waluta", width: 8 },
  { key: "categoryName", header: "Kategoria", width: 16 },
  { key: "categorizationConfidence", header: "Pewność kategorii", width: 18 },
  { key: "itemsExtractedAt", header: "Pozycje wyodrębnione", width: 20 },
  { key: "createdAt", header: "Utworzono", width: 20 },
];

const ITEM_COLUMNS: Array<ColumnDef<ExportInvoiceItemRow>> = [
  { key: "invoiceId", header: "ID faktury", width: 10 },
  { key: "ksefNumber", header: "Numer KSeF", width: 38 },
  { key: "invoiceNumber", header: "Numer faktury", width: 24 },
  { key: "ordinal", header: "Pozycja", width: 8 },
  { key: "lineNumber", header: "Nr wiersza FA", width: 12 },
  { key: "uuId", header: "UU_ID", width: 24 },
  { key: "deliveryDate", header: "Data dostawy", width: 14 },
  { key: "name", header: "Nazwa", width: 40 },
  { key: "indexCode", header: "Indeks", width: 14 },
  { key: "gtin", header: "GTIN", width: 16 },
  { key: "pkwiu", header: "PKWiU", width: 12 },
  { key: "cn", header: "CN", width: 10 },
  { key: "pkob", header: "PKOB", width: 10 },
  { key: "unit", header: "Jednostka", width: 10 },
  { key: "quantity", header: "Ilość", width: 10 },
  { key: "unitPriceNet", header: "Cena netto", width: 12, currency: true },
  { key: "unitPriceGross", header: "Cena brutto", width: 12, currency: true },
  { key: "discount", header: "Rabat", width: 10, currency: true },
  { key: "netValue", header: "Wartość netto", width: 14, currency: true },
  { key: "grossValue", header: "Wartość brutto", width: 14, currency: true },
  { key: "vatValue", header: "Kwota VAT", width: 12, currency: true },
  // `vatRate` is a TEXT column in the DB (values like "zw", "23", "np I") --
  // never flag it currency, a numFmt on it would misrender non-numeric values.
  { key: "vatRate", header: "Stawka VAT", width: 12 },
  { key: "vatRateOss", header: "Stawka VAT OSS", width: 14 },
  { key: "annex15", header: "Załącznik 15", width: 12 },
  { key: "excise", header: "Akcyza", width: 12, currency: true },
  { key: "gtuCode", header: "Kod GTU", width: 10 },
  { key: "procedureCode", header: "Procedura", width: 12 },
  { key: "exchangeRate", header: "Kurs waluty", width: 12 },
  { key: "correctionStateBefore", header: "Stan przed korektą", width: 16 },
];

/** UTC "YYYY-MM-DD HH:MM:SS" -- matches this app's storage convention (see SCHEMA_TYPES_PLAN.md). */
function formatInstant(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

/**
 * Populates `worksheet` from `rows` using `columns`, then applies the shared
 * styling: header row style, per-currency-column numFmt, frozen header, and
 * an autoFilter across the full data range.
 */
function populateSheet<Row>(
  worksheet: ExcelJS.Worksheet,
  columns: Array<ColumnDef<Row>>,
  rows: Row[],
) {
  worksheet.columns = columns.map((c) => ({
    header: c.header,
    key: c.key as string,
    width: c.width,
  }));

  for (const row of rows) {
    worksheet.addRow(row);
  }

  const headerRow = worksheet.getRow(1);
  headerRow.font = { name: "Calibri", bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
  headerRow.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF4472C4" } };
    cell.alignment = { horizontal: "center", vertical: "middle" };
  });

  for (const column of columns) {
    if (!column.currency) {
      continue;
    }
    for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber++) {
      const cell = worksheet.getRow(rowNumber).getCell(column.key as string);
      if (cell.value === null || cell.value === undefined) {
        continue;
      }
      cell.numFmt = "#,##0.00";
      cell.alignment = { horizontal: "right" };
    }
  }

  worksheet.views = [{ state: "frozen", ySplit: 1 }];
  worksheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: worksheet.rowCount, column: columns.length },
  };
}

/**
 * Adds the "Faktury" (invoices) sheet. `createdAt`/`itemsExtractedAt` are
 * converted to UTC "YYYY-MM-DD HH:MM:SS" strings before insertion -- ExcelJS's
 * native Date handling applies locale/timezone-dependent formatting that
 * would be inconsistent with this app's UTC convention elsewhere.
 */
function addInvoicesSheet(workbook: ExcelJS.Workbook, invoices: ExportInvoiceRow[]) {
  const worksheet = workbook.addWorksheet("Faktury");
  const mapped = invoices.map((invoice) => ({
    ...invoice,
    itemsExtractedAt: invoice.itemsExtractedAt ? formatInstant(invoice.itemsExtractedAt) : null,
    createdAt: formatInstant(invoice.createdAt),
  }));
  populateSheet(worksheet, INVOICE_COLUMNS, mapped);
}

/** Adds the "Pozycje" (invoice line items) sheet. No date/time fields to convert here. */
function addItemsSheet(workbook: ExcelJS.Workbook, items: ExportInvoiceItemRow[]) {
  const worksheet = workbook.addWorksheet("Pozycje");
  populateSheet(worksheet, ITEM_COLUMNS, items);
}

/**
 * Builds the full invoice export workbook from plain data arrays. Pure --
 * no I/O, no database access. The caller is responsible for persisting the
 * result (e.g. via `workbook.xlsx.writeFile(...)` or `writeBuffer()`).
 */
export function buildInvoicesWorkbook(
  invoices: ExportInvoiceRow[],
  items: ExportInvoiceItemRow[],
): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  addInvoicesSheet(workbook, invoices);
  addItemsSheet(workbook, items);
  return workbook;
}
