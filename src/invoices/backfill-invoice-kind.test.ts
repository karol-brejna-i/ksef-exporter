import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { createDb } from "../db/client.js";
import { getInvoiceById, insertKsefInvoiceIfNotExists } from "../db/invoices.js";
import { backfillInvoiceKind } from "./backfill-invoice-kind.js";

describe("backfillInvoiceKind", () => {
  let db: Db;
  let close: () => void;

  beforeEach(() => {
    const opened = createDb(":memory:");
    db = opened.db;
    close = () => opened.sqlite.close();
  });

  afterEach(() => close());

  /** Minimal valid FA(3) invoice XML carrying the given RodzajFaktury value. */
  const invoiceXml = (
    rodzajFaktury: string | null,
    invoiceNumber = "INV/001/2026",
  ) => `<?xml version="1.0" encoding="UTF-8"?>
<Faktura xmlns="http://crd.gov.pl/wzor/2025/06/25/13775/">
  <Naglowek>
    <KodFormularza kodSystemowy="FA (3)">FA</KodFormularza>
    <WariantFormularza>3</WariantFormularza>
  </Naglowek>
  <Podmiot1>
    <DaneIdentyfikacyjne>
      <NIP>1234567890</NIP>
      <Nazwa>Test Seller</Nazwa>
    </DaneIdentyfikacyjne>
  </Podmiot1>
  <Podmiot2>
    <DaneIdentyfikacyjne>
      <NIP>9876543210</NIP>
      <Nazwa>Test Buyer</Nazwa>
    </DaneIdentyfikacyjne>
  </Podmiot2>
  <Fa>
    <P_1>2026-08-01</P_1>
    <P_2>${invoiceNumber}</P_2>
    <P_15>123.00</P_15>
    <KodWaluty>PLN</KodWaluty>
    ${rodzajFaktury === null ? "" : `<RodzajFaktury>${rodzajFaktury}</RodzajFaktury>`}
  </Fa>
</Faktura>`;

  /** Namespace-prefixed variant, to prove removeNSPrefix already handles it transparently. */
  const invoiceXmlNsPrefixed = (
    rodzajFaktury: string,
    invoiceNumber = "INV/002/2026",
  ) => `<?xml version="1.0" encoding="UTF-8"?>
<tns:Faktura xmlns:tns="http://crd.gov.pl/wzor/2025/06/25/13775/">
  <tns:Podmiot1>
    <tns:DaneIdentyfikacyjne>
      <tns:NIP>1234567890</tns:NIP>
      <tns:Nazwa>Test Seller</tns:Nazwa>
    </tns:DaneIdentyfikacyjne>
  </tns:Podmiot1>
  <tns:Fa>
    <tns:P_1>2026-08-01</tns:P_1>
    <tns:P_2>${invoiceNumber}</tns:P_2>
    <tns:P_15>123.00</tns:P_15>
    <tns:KodWaluty>PLN</tns:KodWaluty>
    <tns:RodzajFaktury>${rodzajFaktury}</tns:RodzajFaktury>
  </tns:Fa>
</tns:Faktura>`;

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

  it("backfills invoice_kind for an invoice with RodzajFaktury", async () => {
    const invoice = await insertInvoice("5265877635-20260801-123456789012-01", invoiceXml("VAT"));

    const result = await backfillInvoiceKind(db);

    expect(result.totalEligible).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(0);

    const updated = await getInvoiceById(db, invoice.id);
    expect(updated?.invoiceKind).toBe("VAT");
  });

  it("handles namespace-prefixed RodzajFaktury transparently", async () => {
    const invoice = await insertInvoice(
      "5265877635-20260801-123456789012-02",
      invoiceXmlNsPrefixed("KOR"),
      "INV/002/2026",
    );

    const result = await backfillInvoiceKind(db);

    expect(result.succeeded).toBe(1);
    const updated = await getInvoiceById(db, invoice.id);
    expect(updated?.invoiceKind).toBe("KOR");
  });

  it("skips invoices with no RodzajFaktury present, without failing the run", async () => {
    const invoice = await insertInvoice(
      "5265877635-20260801-123456789012-03",
      invoiceXml(null),
      "INV/003/2026",
    );

    const result = await backfillInvoiceKind(db);

    expect(result.succeeded).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.failed).toBe(0);

    const updated = await getInvoiceById(db, invoice.id);
    expect(updated?.invoiceKind).toBeNull();
  });

  it("fails (without throwing) invoices with an unrecognized RodzajFaktury value", async () => {
    const invoice = await insertInvoice(
      "5265877635-20260801-123456789012-04",
      invoiceXml("NOT_A_REAL_KIND"),
      "INV/004/2026",
    );

    const result = await backfillInvoiceKind(db);

    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.results[0]?.message).toContain("NOT_A_REAL_KIND");

    const updated = await getInvoiceById(db, invoice.id);
    expect(updated?.invoiceKind).toBeNull();
  });

  it("processes only invoices with invoice_kind IS NULL", async () => {
    const already = await insertInvoice(
      "5265877635-20260801-123456789012-05",
      invoiceXml("VAT"),
      "INV/005/2026",
    );
    await backfillInvoiceKind(db); // pre-populate invoice_kind for `already`

    const fresh = await insertInvoice(
      "5265877635-20260801-123456789012-06",
      invoiceXml("KOR"),
      "INV/006/2026",
    );

    const result = await backfillInvoiceKind(db);

    expect(result.totalEligible).toBe(1);
    expect(result.results[0]?.invoiceId).toBe(fresh.id);

    const untouched = await getInvoiceById(db, already.id);
    expect(untouched?.invoiceKind).toBe("VAT");
  });

  it("dry-run reports without writing", async () => {
    const invoice = await insertInvoice(
      "5265877635-20260801-123456789012-07",
      invoiceXml("ZAL"),
      "INV/007/2026",
    );

    const result = await backfillInvoiceKind(db, { dryRun: true });

    expect(result.succeeded).toBe(1);
    const untouched = await getInvoiceById(db, invoice.id);
    expect(untouched?.invoiceKind).toBeNull();
  });

  it("force re-derives invoices that already have invoice_kind set", async () => {
    const invoice = await insertInvoice(
      "5265877635-20260801-123456789012-08",
      invoiceXml("VAT"),
      "INV/008/2026",
    );
    await backfillInvoiceKind(db);

    const result = await backfillInvoiceKind(db, { force: true });

    expect(result.totalEligible).toBe(1);
    expect(result.succeeded).toBe(1);
    const updated = await getInvoiceById(db, invoice.id);
    expect(updated?.invoiceKind).toBe("VAT");
  });

  it("respects limit", async () => {
    await insertInvoice("5265877635-20260801-123456789012-09", invoiceXml("VAT"), "INV/009/2026");
    await insertInvoice("5265877635-20260801-123456789012-10", invoiceXml("KOR"), "INV/010/2026");

    const result = await backfillInvoiceKind(db, { limit: 1 });

    expect(result.totalEligible).toBe(1);
    expect(result.processed).toBe(1);
  });
});
