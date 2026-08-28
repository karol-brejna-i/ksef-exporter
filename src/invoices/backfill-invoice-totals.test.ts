import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { createDb } from "../db/client.js";
import {
  getInvoiceById,
  insertKsefInvoiceIfNotExists,
  insertManualInvoice,
} from "../db/invoices.js";
import { backfillInvoiceTotals } from "./backfill-invoice-totals.js";

describe("backfillInvoiceTotals", () => {
  let db: Db;
  let close: () => void;

  beforeEach(() => {
    const opened = createDb(":memory:");
    db = opened.db;
    close = () => opened.sqlite.close();
  });

  afterEach(() => close());

  /** Minimal valid FA(3) invoice XML, optionally carrying totals/payment-term markup. */
  const invoiceXml = (
    extraFaXml = "",
    invoiceNumber = "INV/001/2026",
  ) => `<?xml version="1.0" encoding="UTF-8"?>
<Faktura xmlns="http://crd.gov.pl/wzor/2025/06/25/13775/">
  <Podmiot1>
    <DaneIdentyfikacyjne>
      <NIP>1234567890</NIP>
      <Nazwa>Test Seller</Nazwa>
    </DaneIdentyfikacyjne>
  </Podmiot1>
  <Fa>
    <P_1>2026-08-01</P_1>
    <P_2>${invoiceNumber}</P_2>
    <P_15>123.00</P_15>
    <KodWaluty>PLN</KodWaluty>
    ${extraFaXml}
  </Fa>
</Faktura>`;

  const insertInvoice = (ksefNumber: string, rawXml: string, invoiceNumber = "INV/001/2026") =>
    insertKsefInvoiceIfNotExists(db, {
      ksefNumber,
      invoiceNumber,
      sellerNip: "1234567890",
      sellerName: "Test Seller",
      issueDate: "2026-08-01",
      grossTotal: 123,
      currency: "PLN",
      rawXml,
    });

  it("backfills all three fields for an invoice carrying the underlying XML", async () => {
    const invoice = await insertInvoice(
      "5265877635-20260801-123456789012-01",
      invoiceXml(
        "<P_13_1>100.00</P_13_1><P_14_1>23.00</P_14_1><Platnosc><TerminPlatnosci><Termin>2026-09-01</Termin></TerminPlatnosci></Platnosc>",
      ),
    );

    const result = await backfillInvoiceTotals(db);

    expect(result.totalEligible).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(0);

    const updated = await getInvoiceById(db, invoice.id);
    expect(updated?.netTotal).toBe(100);
    expect(updated?.vatTotal).toBe(23);
    expect(updated?.paymentDueDate).toBe("2026-09-01");
  });

  it("succeeds with all-null totals when none of the underlying elements are present", async () => {
    // Supplementary fields, never required: absence is a normal outcome, not
    // a skip/fail (design/INVOICE_HEADER_FIELDS_PLAN.md §4.1).
    const invoice = await insertInvoice(
      "5265877635-20260801-123456789012-02",
      invoiceXml(),
      "INV/002/2026",
    );

    const result = await backfillInvoiceTotals(db);

    expect(result.succeeded).toBe(1);
    expect(result.skipped).toBe(0);

    const updated = await getInvoiceById(db, invoice.id);
    expect(updated?.netTotal).toBeNull();
    expect(updated?.vatTotal).toBeNull();
    expect(updated?.paymentDueDate).toBeNull();
  });

  it("processes only invoices where all three fields are still NULL", async () => {
    const already = await insertInvoice(
      "5265877635-20260801-123456789012-03",
      invoiceXml("<P_13_1>100.00</P_13_1>"),
      "INV/003/2026",
    );
    await backfillInvoiceTotals(db); // pre-populate for `already`

    const fresh = await insertInvoice(
      "5265877635-20260801-123456789012-04",
      invoiceXml("<P_13_1>200.00</P_13_1>"),
      "INV/004/2026",
    );

    const result = await backfillInvoiceTotals(db);

    expect(result.totalEligible).toBe(1);
    expect(result.results[0]?.invoiceId).toBe(fresh.id);

    const untouched = await getInvoiceById(db, already.id);
    expect(untouched?.netTotal).toBe(100);
  });

  it("dry-run reports without writing", async () => {
    const invoice = await insertInvoice(
      "5265877635-20260801-123456789012-05",
      invoiceXml("<P_13_1>100.00</P_13_1>"),
      "INV/005/2026",
    );

    const result = await backfillInvoiceTotals(db, { dryRun: true });

    expect(result.succeeded).toBe(1);
    const untouched = await getInvoiceById(db, invoice.id);
    expect(untouched?.netTotal).toBeNull();
  });

  it("force re-derives invoices that already have totals set", async () => {
    const invoice = await insertInvoice(
      "5265877635-20260801-123456789012-06",
      invoiceXml("<P_13_1>100.00</P_13_1>"),
      "INV/006/2026",
    );
    await backfillInvoiceTotals(db);

    const result = await backfillInvoiceTotals(db, { force: true });

    expect(result.totalEligible).toBe(1);
    expect(result.succeeded).toBe(1);
    const updated = await getInvoiceById(db, invoice.id);
    expect(updated?.netTotal).toBe(100);
  });

  it("respects limit", async () => {
    await insertInvoice(
      "5265877635-20260801-123456789012-07",
      invoiceXml("<P_13_1>100.00</P_13_1>"),
      "INV/007/2026",
    );
    await insertInvoice(
      "5265877635-20260801-123456789012-08",
      invoiceXml("<P_13_1>200.00</P_13_1>"),
      "INV/008/2026",
    );

    const result = await backfillInvoiceTotals(db, { limit: 1 });

    expect(result.totalEligible).toBe(1);
    expect(result.processed).toBe(1);
  });

  it("excludes manual entries (raw_xml is null) from the eligible set", async () => {
    const manual = await insertManualInvoice(db, {
      invoiceNumber: "MAN/001/2026",
      sellerName: "Manual Seller",
      issueDate: "2026-08-01",
      grossTotal: 50,
      currency: "PLN",
    });

    const result = await backfillInvoiceTotals(db);

    expect(result.totalEligible).toBe(0);
    const untouched = await getInvoiceById(db, manual.id);
    expect(untouched?.netTotal).toBeNull();
  });
});
