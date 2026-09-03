import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import {
  buildInvoicesWorkbook,
  type ExportInvoiceItemRow,
  type ExportInvoiceRow,
} from "./export-invoices-workbook.js";

const INVOICE_HEADERS = [
  "Źródło",
  "Kierunek",
  "Numer KSeF",
  "Numer faktury",
  "Rodzaj faktury",
  "Data wystawienia",
  "Termin płatności",
  "NIP sprzedawcy",
  "Sprzedawca",
  "NIP nabywcy",
  "Nabywca",
  "Netto",
  "VAT",
  "Brutto",
  "Waluta",
  "Kategoria",
  "Pewność kategorii",
  "Pozycje wyodrębnione",
  "Utworzono",
];

const ITEM_HEADERS = [
  "ID faktury",
  "Numer KSeF",
  "Numer faktury",
  "Pozycja",
  "Nr wiersza FA",
  "UU_ID",
  "Data dostawy",
  "Nazwa",
  "Indeks",
  "GTIN",
  "PKWiU",
  "CN",
  "PKOB",
  "Jednostka",
  "Ilość",
  "Cena netto",
  "Cena brutto",
  "Rabat",
  "Wartość netto",
  "Wartość brutto",
  "Kwota VAT",
  "Stawka VAT",
  "Stawka VAT OSS",
  "Załącznik 15",
  "Akcyza",
  "Kod GTU",
  "Procedura",
  "Kurs waluty",
  "Stan przed korektą",
];

const invoices: ExportInvoiceRow[] = [
  {
    id: 1,
    source: "ksef",
    direction: "purchase",
    ksefNumber: "KSEF-001",
    invoiceNumber: "FV/1/2026",
    invoiceKind: "VAT",
    issueDate: "2026-01-15",
    paymentDueDate: "2026-01-29",
    sellerNip: "1234567890",
    sellerName: "Acme Sp. z o.o.",
    buyerNip: "9876543210",
    buyerName: "Buyer Co",
    netTotal: 100.5,
    vatTotal: 23.12,
    grossTotal: 123.62,
    currency: "PLN",
    categoryName: "Media",
    categorizationConfidence: "matched",
    itemsExtractedAt: new Date("2026-01-16T10:30:00Z"),
    createdAt: new Date("2026-01-15T08:00:00Z"),
  },
  {
    id: 2,
    source: "manual",
    direction: "sales",
    ksefNumber: null,
    invoiceNumber: "FV/2/2026",
    invoiceKind: null,
    issueDate: "2026-02-01",
    paymentDueDate: null,
    sellerNip: null,
    sellerName: "Self",
    buyerNip: null,
    buyerName: null,
    netTotal: null,
    vatTotal: null,
    grossTotal: 50,
    currency: "PLN",
    categoryName: null, // exercises null categoryName
    categorizationConfidence: "not_applicable",
    itemsExtractedAt: null, // exercises null itemsExtractedAt
    createdAt: new Date("2026-02-01T12:00:00Z"),
  },
  {
    id: 3,
    source: "ksef",
    direction: "purchase",
    ksefNumber: "KSEF-003",
    invoiceNumber: "FV/3/2026",
    invoiceKind: "KOR",
    issueDate: "2026-03-05",
    paymentDueDate: "2026-03-19",
    sellerNip: "1111111111",
    sellerName: "Other Seller",
    buyerNip: "9876543210",
    buyerName: "Buyer Co",
    netTotal: 200,
    vatTotal: 46,
    grossTotal: 246,
    currency: "PLN",
    categoryName: "Zakup towarów",
    categorizationConfidence: "needs_review",
    itemsExtractedAt: new Date("2026-03-06T09:00:00Z"),
    createdAt: new Date("2026-03-05T07:30:00Z"),
  },
];

const items: ExportInvoiceItemRow[] = [
  {
    invoiceId: 1,
    ksefNumber: "KSEF-001",
    invoiceNumber: "FV/1/2026",
    ordinal: 1,
    lineNumber: 1,
    uuId: "uuid-1",
    deliveryDate: "2026-01-14",
    name: "Usługa transportowa",
    indexCode: "IDX1",
    gtin: null,
    pkwiu: null,
    cn: null,
    pkob: null,
    unit: "szt",
    quantity: 2,
    unitPriceNet: 50.25,
    unitPriceGross: 61.81,
    discount: 0,
    netValue: 100.5,
    grossValue: 123.62,
    vatValue: 23.12,
    vatRate: "23",
    vatRateOss: null,
    annex15: false,
    excise: null,
    gtuCode: null,
    procedureCode: null,
    exchangeRate: null,
    correctionStateBefore: null,
  },
  {
    invoiceId: 1,
    ksefNumber: "KSEF-001",
    invoiceNumber: "FV/1/2026",
    ordinal: 2,
    lineNumber: 2,
    uuId: "uuid-2",
    deliveryDate: "2026-01-14",
    name: "Usługa zwolniona z VAT",
    indexCode: null,
    gtin: null,
    pkwiu: null,
    cn: null,
    pkob: null,
    unit: "szt",
    quantity: 1,
    unitPriceNet: 10,
    unitPriceGross: 10,
    discount: null,
    netValue: 10,
    grossValue: 10,
    vatValue: 0,
    vatRate: "zw", // exercises the non-numeric TEXT vatRate value
    vatRateOss: null,
    annex15: false,
    excise: null,
    gtuCode: null,
    procedureCode: null,
    exchangeRate: null,
    correctionStateBefore: null,
  },
  {
    invoiceId: 2,
    ksefNumber: null,
    invoiceNumber: "FV/2/2026",
    ordinal: 1,
    lineNumber: null,
    uuId: null,
    deliveryDate: null,
    name: "Usługa własna",
    indexCode: null,
    gtin: null,
    pkwiu: null,
    cn: null,
    pkob: null,
    unit: "szt",
    quantity: 1,
    unitPriceNet: 50,
    unitPriceGross: 50,
    discount: null,
    netValue: 50,
    grossValue: 50,
    vatValue: 0,
    vatRate: "np I",
    vatRateOss: null,
    annex15: null,
    excise: null,
    gtuCode: null,
    procedureCode: null,
    exchangeRate: null,
    correctionStateBefore: null,
  },
  {
    invoiceId: 3,
    ksefNumber: "KSEF-003",
    invoiceNumber: "FV/3/2026",
    ordinal: 1,
    lineNumber: 1,
    uuId: "uuid-4",
    deliveryDate: "2026-03-04",
    name: "Towar korygowany",
    indexCode: "IDX3",
    gtin: "1234567890123",
    pkwiu: "12.34.56",
    cn: null,
    pkob: null,
    unit: "kg",
    quantity: 10,
    unitPriceNet: 20,
    unitPriceGross: 24.6,
    discount: 0,
    netValue: 200,
    grossValue: 246,
    vatValue: 46,
    vatRate: "23",
    vatRateOss: null,
    annex15: true,
    excise: null,
    gtuCode: "GTU_01",
    procedureCode: null,
    exchangeRate: null,
    correctionStateBefore: true,
  },
];

/** Reads the header row's cell text values, in column order. */
function headerValues(worksheet: ExcelJS.Worksheet): unknown[] {
  const values: unknown[] = [];
  worksheet.getRow(1).eachCell((cell) => values.push(cell.value));
  return values;
}

/** `workbook.getWorksheet` returns `undefined` for a missing name; fail loudly instead of asserting past it. */
function getSheet(workbook: ExcelJS.Workbook, name: string): ExcelJS.Worksheet {
  const sheet = workbook.getWorksheet(name);
  if (!sheet) {
    throw new Error(`Expected worksheet "${name}" to exist`);
  }
  return sheet;
}

describe("buildInvoicesWorkbook", () => {
  it("creates the two expected worksheets in order", () => {
    const workbook = buildInvoicesWorkbook(invoices, items);
    expect(workbook.worksheets.map((ws) => ws.name)).toEqual(["Faktury", "Pozycje"]);
  });

  it("writes the exact Polish header row for Faktury, in order", () => {
    const workbook = buildInvoicesWorkbook(invoices, items);
    const worksheet = getSheet(workbook, "Faktury");
    const values = headerValues(worksheet);
    expect(values).toEqual(INVOICE_HEADERS);
    // spot-check first/middle/last explicitly
    expect(values[0]).toBe("Źródło");
    expect(values[9]).toBe("NIP nabywcy");
    expect(values.at(-1)).toBe("Utworzono");
  });

  it("writes the exact Polish header row for Pozycje, in order", () => {
    const workbook = buildInvoicesWorkbook(invoices, items);
    const worksheet = getSheet(workbook, "Pozycje");
    const values = headerValues(worksheet);
    expect(values).toEqual(ITEM_HEADERS);
    expect(values[0]).toBe("ID faktury");
    expect(values[14]).toBe("Ilość");
    expect(values.at(-1)).toBe("Stan przed korektą");
  });

  it("styles the header row with bold white font and a blue fill on both sheets", () => {
    const workbook = buildInvoicesWorkbook(invoices, items);
    for (const sheetName of ["Faktury", "Pozycje"] as const) {
      const worksheet = getSheet(workbook, sheetName);
      const headerRow = worksheet.getRow(1);
      expect(headerRow.font?.bold).toBe(true);
      expect(headerRow.font?.color?.argb).toBe("FFFFFFFF");
      const firstDataCell = headerRow.getCell(1);
      const fill = firstDataCell.fill as ExcelJS.FillPattern;
      expect(fill.fgColor?.argb).toBe("FF4472C4");
    }
  });

  it("freezes the header row and defines an autoFilter on both sheets", () => {
    const workbook = buildInvoicesWorkbook(invoices, items);
    for (const sheetName of ["Faktury", "Pozycje"] as const) {
      const worksheet = getSheet(workbook, sheetName);
      expect(worksheet.views[0]).toEqual({ state: "frozen", ySplit: 1 });
      expect(worksheet.autoFilter).toBeDefined();
    }
  });

  it("applies currency numFmt to netTotal/vatTotal/grossTotal data cells on Faktury", () => {
    const workbook = buildInvoicesWorkbook(invoices, items);
    const worksheet = getSheet(workbook, "Faktury");
    const row = worksheet.getRow(2); // invoice id 1
    expect(row.getCell("netTotal").numFmt).toBe("#,##0.00");
    expect(row.getCell("vatTotal").numFmt).toBe("#,##0.00");
    expect(row.getCell("grossTotal").numFmt).toBe("#,##0.00");
  });

  it("does not apply currency numFmt to null netTotal/vatTotal cells", () => {
    const workbook = buildInvoicesWorkbook(invoices, items);
    const worksheet = getSheet(workbook, "Faktury");
    const row = worksheet.getRow(3); // invoice id 2, netTotal/vatTotal null
    expect(row.getCell("netTotal").numFmt).not.toBe("#,##0.00");
    expect(row.getCell("vatTotal").numFmt).not.toBe("#,##0.00");
  });

  it("leaves the TEXT vatRate column untouched by currency numFmt while numeric value columns get it", () => {
    const workbook = buildInvoicesWorkbook(invoices, items);
    const worksheet = getSheet(workbook, "Pozycje");
    const zwRow = worksheet.getRow(3); // ordinal 2 on invoice 1, vatRate "zw"
    expect(zwRow.getCell("vatRate").value).toBe("zw");
    expect(zwRow.getCell("vatRate").numFmt).not.toBe("#,##0.00");
    expect(zwRow.getCell("unitPriceNet").numFmt).toBe("#,##0.00");
    expect(zwRow.getCell("netValue").numFmt).toBe("#,##0.00");
  });

  it("matches the fixture item count and row contents on Pozycje", () => {
    const workbook = buildInvoicesWorkbook(invoices, items);
    const worksheet = getSheet(workbook, "Pozycje");
    expect(worksheet.rowCount).toBe(items.length + 1); // + header row

    // last item row (invoice id 3) -- sample invoiceId/ksefNumber/invoiceNumber
    const lastRow = worksheet.getRow(5);
    expect(lastRow.getCell("invoiceId").value).toBe(3);
    expect(lastRow.getCell("ksefNumber").value).toBe("KSEF-003");
    expect(lastRow.getCell("invoiceNumber").value).toBe("FV/3/2026");
    expect(lastRow.getCell("annex15").value).toBe(true);
    expect(lastRow.getCell("correctionStateBefore").value).toBe(true);
  });

  it("formats createdAt/itemsExtractedAt as UTC 'YYYY-MM-DD HH:MM:SS' strings, not Date objects", () => {
    const workbook = buildInvoicesWorkbook(invoices, items);
    const worksheet = getSheet(workbook, "Faktury");

    const row1 = worksheet.getRow(2); // invoice id 1: both fields set
    expect(row1.getCell("createdAt").value).toBe("2026-01-15 08:00:00");
    expect(row1.getCell("itemsExtractedAt").value).toBe("2026-01-16 10:30:00");
    expect(typeof row1.getCell("createdAt").value).toBe("string");

    const row2 = worksheet.getRow(3); // invoice id 2: itemsExtractedAt null
    expect(row2.getCell("createdAt").value).toBe("2026-02-01 12:00:00");
    expect(row2.getCell("itemsExtractedAt").value).toBeNull();
  });

  it("passes civil-date fields (issueDate, deliveryDate) through unchanged", () => {
    const workbook = buildInvoicesWorkbook(invoices, items);
    const invoicesSheet = getSheet(workbook, "Faktury");
    expect(invoicesSheet.getRow(2).getCell("issueDate").value).toBe("2026-01-15");

    const itemsSheet = getSheet(workbook, "Pozycje");
    expect(itemsSheet.getRow(2).getCell("deliveryDate").value).toBe("2026-01-14");
  });

  it("round-trips through an xlsx buffer: header row and a data row survive serialization", async () => {
    const workbook = buildInvoicesWorkbook(invoices, items);
    const buffer = await workbook.xlsx.writeBuffer();

    const reloaded = new ExcelJS.Workbook();
    await reloaded.xlsx.load(buffer);

    expect(reloaded.worksheets.map((ws) => ws.name)).toEqual(["Faktury", "Pozycje"]);

    const invoicesSheet = getSheet(reloaded, "Faktury");
    expect(headerValues(invoicesSheet)).toEqual(INVOICE_HEADERS);
    const invoiceRow = invoicesSheet.getRow(2);
    expect(invoiceRow.getCell(3).value).toBe("KSEF-001"); // ksefNumber column
    expect(invoiceRow.getCell(19).value).toBe("2026-01-15 08:00:00"); // createdAt column
    expect(invoiceRow.getCell(12).numFmt).toBe("#,##0.00"); // netTotal column

    const itemsSheet = getSheet(reloaded, "Pozycje");
    expect(headerValues(itemsSheet)).toEqual(ITEM_HEADERS);
    const zwRow = itemsSheet.getRow(3);
    expect(zwRow.getCell(22).value).toBe("zw"); // vatRate column
    expect(zwRow.getCell(22).numFmt).not.toBe("#,##0.00");
  });
});
