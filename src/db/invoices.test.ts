import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCategory } from "./categories.js";
import type { Db } from "./client.js";
import { createDb } from "./client.js";
import {
  getInvoiceById,
  getInvoiceByKsefNumber,
  insertKsefInvoiceIfNotExists,
  insertManualInvoice,
  listInvoices,
  updateInvoiceCategory,
} from "./invoices.js";

const SAMPLE_KSEF_INVOICE = {
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

describe("invoices repository", () => {
  let db: Db;
  let close: () => void;

  beforeEach(() => {
    const opened = createDb(":memory:");
    db = opened.db;
    close = () => opened.sqlite.close();
  });

  afterEach(() => close());

  it("inserts a KSeF invoice and reads it back by KSeF number and id", async () => {
    const inserted = await insertKsefInvoiceIfNotExists(db, SAMPLE_KSEF_INVOICE);

    expect(inserted.source).toBe("ksef");
    expect(inserted.ksefNumber).toBe(SAMPLE_KSEF_INVOICE.ksefNumber);
    expect(inserted.categorizationConfidence).toBe("needs_review");
    expect(inserted.categoryId).toBeNull();

    const byKsefNumber = await getInvoiceByKsefNumber(db, SAMPLE_KSEF_INVOICE.ksefNumber);
    const byId = await getInvoiceById(db, inserted.id);

    expect(byKsefNumber).toEqual(inserted);
    expect(byId).toEqual(inserted);
  });

  it("inserting the same KSeF number twice does not create a duplicate row or throw", async () => {
    const first = await insertKsefInvoiceIfNotExists(db, SAMPLE_KSEF_INVOICE);
    const second = await insertKsefInvoiceIfNotExists(db, SAMPLE_KSEF_INVOICE);

    expect(second.id).toBe(first.id);

    const all = await listInvoices(db);
    expect(all.filter((i) => i.ksefNumber === SAMPLE_KSEF_INVOICE.ksefNumber)).toHaveLength(1);
  });

  it("does not overwrite an already-assigned category when re-inserting the same KSeF invoice", async () => {
    const category = await createCategory(db, "Media");
    const inserted = await insertKsefInvoiceIfNotExists(db, SAMPLE_KSEF_INVOICE);
    await updateInvoiceCategory(db, inserted.id, category.id, "matched");

    await insertKsefInvoiceIfNotExists(db, SAMPLE_KSEF_INVOICE);

    const after = await getInvoiceById(db, inserted.id);
    expect(after?.categoryId).toBe(category.id);
    expect(after?.categorizationConfidence).toBe("matched");
  });

  it("allows multiple manual invoices with no KSeF number (no false unique-constraint conflict)", async () => {
    const manual1 = await insertManualInvoice(db, {
      invoiceNumber: "RECEIPT-001",
      sellerName: "Foreign Vendor A",
      issueDate: "2025-01-20",
      grossTotal: 45.99,
      currency: "USD",
    });
    const manual2 = await insertManualInvoice(db, {
      invoiceNumber: "RECEIPT-002",
      sellerName: "Foreign Vendor B",
      issueDate: "2025-01-21",
      grossTotal: 12.5,
      currency: "EUR",
    });

    expect(manual1.source).toBe("manual");
    expect(manual1.ksefNumber).toBeNull();
    expect(manual2.ksefNumber).toBeNull();
    expect(manual1.id).not.toBe(manual2.id);
  });

  it("updates an invoice's category and confidence", async () => {
    const category = await createCategory(db, "Zakup towarów");
    const inserted = await insertKsefInvoiceIfNotExists(db, SAMPLE_KSEF_INVOICE);

    const updated = await updateInvoiceCategory(db, inserted.id, category.id, "matched");

    expect(updated.categoryId).toBe(category.id);
    expect(updated.categorizationConfidence).toBe("matched");
  });

  it("throws when updating the category of a non-existent invoice", async () => {
    const category = await createCategory(db, "Inne");

    await expect(updateInvoiceCategory(db, 999, category.id, "matched")).rejects.toThrow();
  });

  it("filters listed invoices by month", async () => {
    await insertKsefInvoiceIfNotExists(db, SAMPLE_KSEF_INVOICE);
    await insertKsefInvoiceIfNotExists(db, {
      ...SAMPLE_KSEF_INVOICE,
      ksefNumber: "5265877635-20250215-123456789012-01",
      issueDate: "2025-02-15",
    });

    const januaryOnly = await listInvoices(db, { month: "2025-01" });

    expect(januaryOnly).toHaveLength(1);
    expect(januaryOnly[0]?.issueDate).toBe("2025-01-15");
  });

  it("filters listed invoices by categoryId", async () => {
    const media = await createCategory(db, "Media");
    const other = await createCategory(db, "Inne");
    const first = await insertKsefInvoiceIfNotExists(db, SAMPLE_KSEF_INVOICE);
    const second = await insertKsefInvoiceIfNotExists(db, {
      ...SAMPLE_KSEF_INVOICE,
      ksefNumber: "5265877635-20250215-123456789012-01",
      issueDate: "2025-02-15",
    });
    await updateInvoiceCategory(db, first.id, media.id, "matched");
    await updateInvoiceCategory(db, second.id, other.id, "matched");

    const mediaOnly = await listInvoices(db, { categoryId: media.id });

    expect(mediaOnly).toHaveLength(1);
    expect(mediaOnly[0]?.id).toBe(first.id);
  });
});
