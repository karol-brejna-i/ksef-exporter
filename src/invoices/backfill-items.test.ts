import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { createDb } from "../db/client.js";
import { listInvoiceItems } from "../db/invoice-items.js";
import {
  getInvoiceById,
  insertKsefInvoiceIfNotExists,
  insertManualInvoice,
} from "../db/invoices.js";
import { invoiceItems } from "../db/schema.js";
import { backfillInvoiceItems } from "./backfill-items.js";

describe("backfillInvoiceItems", () => {
  let db: Db;
  let close: () => void;

  beforeEach(() => {
    const opened = createDb(":memory:");
    db = opened.db;
    close = () => opened.sqlite.close();
  });

  afterEach(() => close());

  /**
   * Minimal valid FA(3) invoice XML with one line item. Uses the unprefixed
   * style and includes the required header fields.
   */
  const minimalInvoiceXml = (lineCount = 1) => `<?xml version="1.0" encoding="UTF-8"?>
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
    <P_2>INV/001/2026</P_2>
    <P_13_1>100.00</P_13_1>
    <P_14_1>23.00</P_14_1>
    <P_15>123.00</P_15>
    <KodWaluty>PLN</KodWaluty>
    ${Array.from(
      { length: lineCount },
      (_, i) => `<FaWiersz>
      <NrWierszaFa>${i + 1}</NrWierszaFa>
      <P_7>Test Item ${i + 1}</P_7>
      <P_8A>szt.</P_8A>
      <P_8B>1</P_8B>
      <P_9A>${(100 / lineCount).toFixed(2)}</P_9A>
      <P_11>${(100 / lineCount).toFixed(2)}</P_11>
      <P_12>23</P_12>
    </FaWiersz>`,
    ).join("")}
  </Fa>
</Faktura>`;

  /**
   * Invoice XML with no FaWiersz elements (zero items).
   */
  const zeroItemsXml = `<?xml version="1.0" encoding="UTF-8"?>
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
    <P_2>INV/000/2026</P_2>
    <P_15>0.00</P_15>
    <KodWaluty>PLN</KodWaluty>
  </Fa>
</Faktura>`;

  /**
   * XML that fast-xml-parser genuinely rejects: truncated mid-tag.
   *
   * The parser is very lenient -- unclosed tags, mismatched closing tags, a
   * stray close, and even "this is not xml" all parse without error (yielding
   * no items rather than a failure). Truncation inside a tag is one of the few
   * inputs that actually throws, so it is what exercises the failure path.
   */
  const unparseableXml = `<?xml version="1.0" encoding="UTF-8"?>
<Faktura xmlns="http://crd.gov.pl/wzor/2025/06/25/13775/">
  <Fa>
    <P_1>2026-08-01</P_1>
    <FaWie`;

  it("processes only invoices with items_extracted_at IS NULL", async () => {
    // Insert two invoices: one extracted, one not.
    const alreadyExtracted = await insertKsefInvoiceIfNotExists(db, {
      ksefNumber: "5265877635-20260801-123456789012-01",
      invoiceNumber: "INV/001/2026",
      sellerNip: "1234567890",
      sellerName: "Test Seller",
      issueDate: "2026-08-01",
      grossTotal: 123.0,
      currency: "PLN",
      rawXml: minimalInvoiceXml(),
    });

    // Manually stamp items_extracted_at for the first invoice
    await db.run(
      sql`UPDATE invoices SET items_extracted_at = ${new Date().toISOString()} WHERE id = ${alreadyExtracted.id}`,
    );

    const notYetExtracted = await insertKsefInvoiceIfNotExists(db, {
      ksefNumber: "5265877635-20260802-123456789012-02",
      invoiceNumber: "INV/002/2026",
      sellerNip: "1234567890",
      sellerName: "Test Seller",
      issueDate: "2026-08-02",
      grossTotal: 123.0,
      currency: "PLN",
      rawXml: minimalInvoiceXml(),
    });

    const result = await backfillInvoiceItems(db);

    // Only the not-yet-extracted invoice should be processed.
    expect(result.totalEligible).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.itemsInserted).toBe(1);

    // Verify items were written for the not-yet-extracted invoice.
    const itemsForNotYetExtracted = await db
      .select()
      .from(invoiceItems)
      .where(sql`${invoiceItems.invoiceId} = ${notYetExtracted.id}`)
      .all();
    expect(itemsForNotYetExtracted).toHaveLength(1);

    // Verify items were NOT written for the already-extracted invoice.
    const itemsForAlreadyExtracted = await db
      .select()
      .from(invoiceItems)
      .where(sql`${invoiceItems.invoiceId} = ${alreadyExtracted.id}`)
      .all();
    expect(itemsForAlreadyExtracted).toHaveLength(0);
  });

  it("dry-run writes nothing", async () => {
    const invoice = await insertKsefInvoiceIfNotExists(db, {
      ksefNumber: "5265877635-20260801-123456789012-01",
      invoiceNumber: "INV/001/2026",
      sellerNip: "1234567890",
      sellerName: "Test Seller",
      issueDate: "2026-08-01",
      grossTotal: 123.0,
      currency: "PLN",
      rawXml: minimalInvoiceXml(),
    });

    const result = await backfillInvoiceItems(db, { dryRun: true });

    // The invoice was processed and its items counted -- §8 expects the dry
    // run to report the item total a live run would write.
    expect(result.succeeded).toBe(1);
    expect(result.results[0]?.itemsCount).toBe(1);
    expect(result.itemsParsed).toBe(1);

    // ...but nothing was written.
    expect(result.itemsInserted).toBe(0);

    const itemsAfter = await db
      .select()
      .from(invoiceItems)
      .where(sql`${invoiceItems.invoiceId} = ${invoice.id}`)
      .all();
    expect(itemsAfter).toHaveLength(0);

    // items_extracted_at is still NULL.
    const invoiceAfter = await getInvoiceById(db, invoice.id);
    expect(invoiceAfter?.itemsExtractedAt).toBeNull();
  });

  it("reconciles in --dry-run, where no items have been written yet", async () => {
    await insertKsefInvoiceIfNotExists(db, {
      ksefNumber: "5265877635-20260801-123456789012-01",
      invoiceNumber: "INV/001/2026",
      sellerNip: "1234567890",
      sellerName: "Test Seller",
      issueDate: "2026-08-01",
      grossTotal: 123.0,
      currency: "PLN",
      rawXml: minimalInvoiceXml(),
    });

    const result = await backfillInvoiceItems(db, { dryRun: true });

    // Reconciliation reads the parsed items, not the table -- reading them
    // back would report eligibleCount 0 for every dry run.
    expect(result.reconciliation.eligibleCount).toBe(1);
    expect(result.reconciliation.matchedCount).toBe(1);
    expect(result.reconciliation.mismatches).toHaveLength(0);
  });

  it("extracts items even when the header would fail validation", async () => {
    // The KSeF number is not in the invoice XML, and these invoices were
    // already imported: their header is persisted. Re-deriving items must not
    // depend on the header parsing (or the KSeF number validating) a second
    // time, or an invoice the SDK now rejects would silently lose every item.
    const headerlessXml = `<?xml version="1.0" encoding="UTF-8"?>
<Faktura xmlns="http://crd.gov.pl/wzor/2025/06/25/13775/">
  <Fa>
    <FaWiersz>
      <NrWierszaFa>1</NrWierszaFa>
      <P_7>Item from a header-poor document</P_7>
      <P_11>50.00</P_11>
      <P_12>zw</P_12>
    </FaWiersz>
  </Fa>
</Faktura>`;

    const invoice = await insertKsefInvoiceIfNotExists(db, {
      ksefNumber: "not-a-valid-ksef-number",
      invoiceNumber: "INV/009/2026",
      sellerNip: "1234567890",
      sellerName: "Test Seller",
      issueDate: "2026-08-01",
      grossTotal: 50.0,
      currency: "PLN",
      rawXml: headerlessXml,
    });

    const result = await backfillInvoiceItems(db);

    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.itemsInserted).toBe(1);

    const items = await listInvoiceItems(db, invoice.id);
    expect(items).toHaveLength(1);
    expect(items[0]?.name).toBe("Item from a header-poor document");
    expect(items[0]?.vatRate).toBe("zw");
  });

  it("force re-derives already-extracted invoices", async () => {
    const invoice = await insertKsefInvoiceIfNotExists(db, {
      ksefNumber: "5265877635-20260801-123456789012-01",
      invoiceNumber: "INV/001/2026",
      sellerNip: "1234567890",
      sellerName: "Test Seller",
      issueDate: "2026-08-01",
      grossTotal: 123.0,
      currency: "PLN",
      rawXml: minimalInvoiceXml(),
    });

    // Manually stamp items_extracted_at and insert an old item
    await db.run(
      sql`UPDATE invoices SET items_extracted_at = ${new Date().toISOString()} WHERE id = ${invoice.id}`,
    );

    await db.insert(invoiceItems).values({
      invoiceId: invoice.id,
      ordinal: 1,
      name: "Old Item",
      vatRate: "23",
    });

    const result = await backfillInvoiceItems(db, { force: true });

    // The invoice was processed despite having items_extracted_at.
    expect(result.succeeded).toBe(1);
    expect(result.itemsInserted).toBe(1);

    // The old item was replaced.
    const itemsAfter = await db
      .select()
      .from(invoiceItems)
      .where(sql`${invoiceItems.invoiceId} = ${invoice.id}`)
      .all();
    expect(itemsAfter).toHaveLength(1);
    expect(itemsAfter[0]?.name).toBe("Test Item 1");
  });

  it("skips invoices with raw_xml IS NULL", async () => {
    await insertManualInvoice(db, {
      invoiceNumber: "MANUAL/001/2026",
      sellerName: "Manual Seller",
      issueDate: "2026-08-01",
      grossTotal: 100.0,
      currency: "PLN",
    });

    const result = await backfillInvoiceItems(db);

    // The invoice was not selected (query filters it out).
    expect(result.totalEligible).toBe(0);
    expect(result.processed).toBe(0);
  });

  it("reports unparseable raw_xml as failed without aborting the run", async () => {
    // Insert one good invoice and one bad one.
    await insertKsefInvoiceIfNotExists(db, {
      ksefNumber: "5265877635-20260801-123456789012-01",
      invoiceNumber: "INV/001/2026",
      sellerNip: "1234567890",
      sellerName: "Test Seller",
      issueDate: "2026-08-01",
      grossTotal: 123.0,
      currency: "PLN",
      rawXml: minimalInvoiceXml(),
    });

    const badInvoice = await insertKsefInvoiceIfNotExists(db, {
      ksefNumber: "5265877635-20260802-123456789012-02",
      invoiceNumber: "INV/002/2026",
      sellerNip: "1234567890",
      sellerName: "Test Seller",
      issueDate: "2026-08-02",
      grossTotal: 123.0,
      currency: "PLN",
      rawXml: unparseableXml,
    });

    const result = await backfillInvoiceItems(db);

    // Both invoices were attempted.
    expect(result.totalEligible).toBe(2);
    expect(result.processed).toBe(2);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(1);

    // The failed one is reported.
    const failedResult = result.results.find((r) => r.invoiceId === badInvoice.id);
    expect(failedResult?.status).toBe("failed");
    expect(failedResult?.message).toContain("Failed to parse invoice XML");

    // ...and left unstamped, so a later run retries it without --force.
    const badAfter = await getInvoiceById(db, badInvoice.id);
    expect(badAfter?.itemsExtractedAt).toBeNull();
  });

  it("handles invoices with zero items (legal FA(3) state)", async () => {
    await insertKsefInvoiceIfNotExists(db, {
      ksefNumber: "5265877635-20260801-123456789012-01",
      invoiceNumber: "INV/000/2026",
      sellerNip: "1234567890",
      sellerName: "Test Seller",
      issueDate: "2026-08-01",
      grossTotal: 0.0,
      currency: "PLN",
      rawXml: zeroItemsXml,
    });

    const result = await backfillInvoiceItems(db);

    expect(result.succeeded).toBe(1);
    expect(result.results[0]?.itemsCount).toBe(0);
    expect(result.itemsInserted).toBe(0);
  });

  it("respects the limit option", async () => {
    // Insert three invoices.
    await insertKsefInvoiceIfNotExists(db, {
      ksefNumber: "5265877635-20260801-123456789012-01",
      invoiceNumber: "INV/001/2026",
      sellerNip: "1234567890",
      sellerName: "Test Seller",
      issueDate: "2026-08-01",
      grossTotal: 123.0,
      currency: "PLN",
      rawXml: minimalInvoiceXml(),
    });

    await insertKsefInvoiceIfNotExists(db, {
      ksefNumber: "5265877635-20260802-123456789012-02",
      invoiceNumber: "INV/002/2026",
      sellerNip: "1234567890",
      sellerName: "Test Seller",
      issueDate: "2026-08-02",
      grossTotal: 123.0,
      currency: "PLN",
      rawXml: minimalInvoiceXml(),
    });

    await insertKsefInvoiceIfNotExists(db, {
      ksefNumber: "5265877635-20260803-123456789012-03",
      invoiceNumber: "INV/003/2026",
      sellerNip: "1234567890",
      sellerName: "Test Seller",
      issueDate: "2026-08-03",
      grossTotal: 123.0,
      currency: "PLN",
      rawXml: minimalInvoiceXml(),
    });

    const result = await backfillInvoiceItems(db, { limit: 2 });

    // Only two were processed.
    expect(result.totalEligible).toBe(2);
    expect(result.succeeded).toBe(2);
  });

  it("stamps items_extracted_at after successful extraction", async () => {
    const invoice = await insertKsefInvoiceIfNotExists(db, {
      ksefNumber: "5265877635-20260801-123456789012-01",
      invoiceNumber: "INV/001/2026",
      sellerNip: "1234567890",
      sellerName: "Test Seller",
      issueDate: "2026-08-01",
      grossTotal: 123.0,
      currency: "PLN",
      rawXml: minimalInvoiceXml(),
    });

    await backfillInvoiceItems(db);

    const invoiceAfter = await getInvoiceById(db, invoice.id);

    expect(invoiceAfter?.itemsExtractedAt).not.toBeNull();
    expect(invoiceAfter?.itemsExtractedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("builds reconciliation report for eligible invoices", async () => {
    // Insert an invoice with items that reconcile perfectly.
    await insertKsefInvoiceIfNotExists(db, {
      ksefNumber: "5265877635-20260801-123456789012-01",
      invoiceNumber: "INV/001/2026",
      sellerNip: "1234567890",
      sellerName: "Test Seller",
      issueDate: "2026-08-01",
      grossTotal: 123.0,
      currency: "PLN",
      rawXml: minimalInvoiceXml(1),
    });

    const result = await backfillInvoiceItems(db);

    // The invoice is eligible for reconciliation.
    expect(result.reconciliation.eligibleCount).toBeGreaterThan(0);
    expect(result.reconciliation.matchedCount).toBeGreaterThan(0);
    expect(result.reconciliation.mismatches).toHaveLength(0);
  });
});
