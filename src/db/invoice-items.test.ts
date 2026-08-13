import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./client.js";
import { createDb } from "./client.js";
import {
  countInvoiceItemsByInvoice,
  listInvoiceItems,
  type NewInvoiceItem,
  replaceInvoiceItems,
} from "./invoice-items.js";
import { getInvoiceById, insertKsefInvoiceIfNotExists } from "./invoices.js";
import { invoiceItems } from "./schema.js";

const SAMPLE_INVOICE = {
  ksefNumber: "5265877635-20250115-123456789012-01",
  invoiceNumber: "FV/2025/01/001",
  sellerNip: "5265877635",
  sellerName: "Energa Operator",
  buyerNip: "1111111111",
  buyerName: "Parkowa Sp. z o.o.",
  issueDate: "2025-01-15",
  grossTotal: 1234.56,
  currency: "PLN",
  rawXml: "<Faktura></Faktura>",
};

describe("invoice-items repository", () => {
  let db: Db;
  let close: () => void;

  beforeEach(() => {
    const opened = createDb(":memory:");
    db = opened.db;
    close = () => opened.sqlite.close();
  });

  afterEach(() => close());

  it("inserts and lists items in document order (ordered by ordinal)", async () => {
    const invoice = await insertKsefInvoiceIfNotExists(db, SAMPLE_INVOICE);

    const items: NewInvoiceItem[] = [
      {
        invoiceId: invoice.id,
        ordinal: 1,
        lineNumber: 1,
        name: "First item",
        quantity: 2,
        netValue: 100,
        vatRate: "23",
      },
      {
        invoiceId: invoice.id,
        ordinal: 2,
        lineNumber: 2,
        name: "Second item",
        quantity: 1,
        netValue: 50,
        vatRate: "8",
      },
      {
        invoiceId: invoice.id,
        ordinal: 3,
        lineNumber: 3,
        name: "Third item",
        quantity: 5,
        grossValue: 75.5,
        vatRate: "zw",
      },
    ];

    replaceInvoiceItems(db, invoice.id, items);

    const retrieved = await listInvoiceItems(db, invoice.id);

    expect(retrieved).toHaveLength(3);
    expect(retrieved[0]?.ordinal).toBe(1);
    expect(retrieved[0]?.name).toBe("First item");
    expect(retrieved[1]?.ordinal).toBe(2);
    expect(retrieved[1]?.name).toBe("Second item");
    expect(retrieved[2]?.ordinal).toBe(3);
    expect(retrieved[2]?.name).toBe("Third item");
  });

  it("replaceInvoiceItems is idempotent: calling twice yields the same row count with no duplicates", async () => {
    const invoice = await insertKsefInvoiceIfNotExists(db, SAMPLE_INVOICE);

    const items: NewInvoiceItem[] = [
      {
        invoiceId: invoice.id,
        ordinal: 1,
        lineNumber: 1,
        name: "Item A",
        netValue: 100,
      },
      {
        invoiceId: invoice.id,
        ordinal: 2,
        lineNumber: 2,
        name: "Item B",
        netValue: 200,
      },
    ];

    replaceInvoiceItems(db, invoice.id, items);
    const firstPass = await listInvoiceItems(db, invoice.id);
    expect(firstPass).toHaveLength(2);

    replaceInvoiceItems(db, invoice.id, items);
    const secondPass = await listInvoiceItems(db, invoice.id);
    expect(secondPass).toHaveLength(2);

    // Verify no duplicates by checking all rows in the table
    const allItems = await db.select().from(invoiceItems).all();
    expect(allItems).toHaveLength(2);
  });

  it("deleting the parent invoice cascades and removes its items", async () => {
    const invoice = await insertKsefInvoiceIfNotExists(db, SAMPLE_INVOICE);

    const items: NewInvoiceItem[] = [
      {
        invoiceId: invoice.id,
        ordinal: 1,
        lineNumber: 1,
        name: "Item to be cascaded",
        netValue: 100,
      },
    ];

    replaceInvoiceItems(db, invoice.id, items);
    const beforeDelete = await listInvoiceItems(db, invoice.id);
    expect(beforeDelete).toHaveLength(1);

    // Delete the parent invoice - cascade should automatically remove items
    await db.run(sql`DELETE FROM invoices WHERE id = ${invoice.id}`);

    const afterDelete = await listInvoiceItems(db, invoice.id);
    expect(afterDelete).toHaveLength(0);
  });

  it("countInvoiceItemsByInvoice returns counts for multiple invoices, absent for zero-item invoices", async () => {
    const invoice1 = await insertKsefInvoiceIfNotExists(db, SAMPLE_INVOICE);
    const invoice2 = await insertKsefInvoiceIfNotExists(db, {
      ...SAMPLE_INVOICE,
      ksefNumber: "5265877635-20250116-123456789012-02",
      invoiceNumber: "FV/2025/01/002",
    });
    const invoice3 = await insertKsefInvoiceIfNotExists(db, {
      ...SAMPLE_INVOICE,
      ksefNumber: "5265877635-20250117-123456789012-03",
      invoiceNumber: "FV/2025/01/003",
    });

    // Invoice 1: 3 items
    replaceInvoiceItems(db, invoice1.id, [
      { invoiceId: invoice1.id, ordinal: 1, lineNumber: 1, name: "Item 1.1" },
      { invoiceId: invoice1.id, ordinal: 2, lineNumber: 2, name: "Item 1.2" },
      { invoiceId: invoice1.id, ordinal: 3, lineNumber: 3, name: "Item 1.3" },
    ]);

    // Invoice 2: 1 item
    replaceInvoiceItems(db, invoice2.id, [
      { invoiceId: invoice2.id, ordinal: 1, lineNumber: 1, name: "Item 2.1" },
    ]);

    // Invoice 3: 0 items (empty array)
    replaceInvoiceItems(db, invoice3.id, []);

    const counts = await countInvoiceItemsByInvoice(db, [invoice1.id, invoice2.id, invoice3.id]);

    expect(counts.get(invoice1.id)).toBe(3);
    expect(counts.get(invoice2.id)).toBe(1);
    // Invoice 3 has zero items, so it should be absent from the map
    expect(counts.has(invoice3.id)).toBe(false);
  });

  it("countInvoiceItemsByInvoice handles empty input array without error", async () => {
    const counts = await countInvoiceItemsByInvoice(db, []);

    expect(counts.size).toBe(0);
  });

  it("replaceInvoiceItems stamps items_extracted_at on the invoice", async () => {
    const invoice = await insertKsefInvoiceIfNotExists(db, SAMPLE_INVOICE);

    // Initially, items_extracted_at should be null
    const before = await getInvoiceById(db, invoice.id);
    expect(before?.itemsExtractedAt).toBeNull();

    replaceInvoiceItems(db, invoice.id, [
      { invoiceId: invoice.id, ordinal: 1, lineNumber: 1, name: "Item" },
    ]);

    const after = await getInvoiceById(db, invoice.id);
    expect(after?.itemsExtractedAt).not.toBeNull();
    expect(after?.itemsExtractedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("replaceInvoiceItems stamps items_extracted_at even with an empty items array", async () => {
    const invoice = await insertKsefInvoiceIfNotExists(db, SAMPLE_INVOICE);

    const before = await getInvoiceById(db, invoice.id);
    expect(before?.itemsExtractedAt).toBeNull();

    // Extract zero items - this is valid (FaWiersz is minOccurs=0)
    replaceInvoiceItems(db, invoice.id, []);

    const after = await getInvoiceById(db, invoice.id);
    expect(after?.itemsExtractedAt).not.toBeNull();
    expect(after?.itemsExtractedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("listInvoiceItems returns empty array for non-existent invoice", async () => {
    const items = await listInvoiceItems(db, 999);

    expect(items).toHaveLength(0);
  });

  it("preserves all nullable fields including non-numeric VAT rates", async () => {
    const invoice = await insertKsefInvoiceIfNotExists(db, SAMPLE_INVOICE);

    const item: NewInvoiceItem = {
      invoiceId: invoice.id,
      ordinal: 1,
      lineNumber: 1,
      uuId: "test-uuid-123",
      deliveryDate: "2025-01-10",
      name: "Complex item",
      indexCode: "IDX-001",
      gtin: "1234567890123",
      pkwiu: "10.31.15.0",
      cn: "1602 32 19",
      pkob: null,
      unit: "szt.",
      quantity: 10,
      unitPriceNet: 50.5,
      unitPriceGross: 62.12,
      discount: 5.0,
      netValue: null, // Gross-priced line
      grossValue: 621.2,
      vatValue: 142.87,
      vatRate: "zw", // Non-numeric VAT rate
      vatRateOss: null,
      annex15: true,
      excise: 2.5,
      gtuCode: "GTU_01",
      procedureCode: "WSTO_EE",
      exchangeRate: 1.0,
      correctionStateBefore: false,
    };

    replaceInvoiceItems(db, invoice.id, [item]);

    const retrieved = await listInvoiceItems(db, invoice.id);
    expect(retrieved).toHaveLength(1);

    const stored = retrieved[0];
    expect(stored).toBeDefined();
    if (!stored) return;

    expect(stored.uuId).toBe("test-uuid-123");
    expect(stored.vatRate).toBe("zw");
    expect(stored.netValue).toBeNull();
    expect(stored.grossValue).toBe(621.2);
    expect(stored.correctionStateBefore).toBe(false);
    expect(stored.annex15).toBe(true);
    expect(stored.gtuCode).toBe("GTU_01");
  });
});
