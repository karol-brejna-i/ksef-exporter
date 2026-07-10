import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCategory } from "../db/categories.js";
import type { Db } from "../db/client.js";
import { createDb } from "../db/client.js";
import { insertKsefInvoiceIfNotExists, insertManualInvoice } from "../db/invoices.js";
import { listRules } from "../db/rules.js";
import { correctInvoiceCategory, InvoiceNotFoundError } from "./correct.js";
import { categorize } from "./engine.js";

const SAMPLE_INVOICE = {
  ksefNumber: "5265877635-20250115-123456789012-01",
  invoiceNumber: "FV/2025/01/001",
  sellerNip: "5265877635",
  sellerName: "Totally New Vendor Sp. z o.o.",
  buyerNip: "1111111111",
  buyerName: "Parkowa Sp. z o.o.",
  issueDate: "2025-01-15",
  grossTotal: 1234.56,
  currency: "PLN",
  rawXml: "<Faktura></Faktura>",
};

describe("correctInvoiceCategory", () => {
  let db: Db;
  let close: () => void;

  beforeEach(() => {
    const opened = createDb(":memory:");
    db = opened.db;
    close = () => opened.sqlite.close();
  });

  afterEach(() => close());

  it("updates the invoice's category to matched confidence", async () => {
    const category = await createCategory(db, "Media");
    const invoice = await insertKsefInvoiceIfNotExists(db, SAMPLE_INVOICE);
    expect(invoice.categorizationConfidence).toBe("needs_review");

    const corrected = await correctInvoiceCategory(db, invoice.id, category.id);

    expect(corrected.categoryId).toBe(category.id);
    expect(corrected.categorizationConfidence).toBe("matched");
  });

  it("creates a seller-NIP rule so a subsequent invoice from the same seller auto-categorizes", async () => {
    const category = await createCategory(db, "Media");
    const invoice = await insertKsefInvoiceIfNotExists(db, SAMPLE_INVOICE);

    await correctInvoiceCategory(db, invoice.id, category.id);

    const rules = await listRules(db);
    expect(rules).toEqual([
      expect.objectContaining({
        matchType: "seller_nip",
        matchValue: SAMPLE_INVOICE.sellerNip,
        categoryId: category.id,
      }),
    ]);

    const nextInvoice = {
      sellerNip: SAMPLE_INVOICE.sellerNip,
      sellerName: SAMPLE_INVOICE.sellerName,
    };
    expect(categorize(nextInvoice, rules)).toEqual({
      categoryId: category.id,
      confidence: "matched",
    });
  });

  it("falls back to a seller-name-contains rule when the invoice has no seller NIP", async () => {
    const category = await createCategory(db, "Inne");
    const invoice = await insertManualInvoice(db, {
      invoiceNumber: "RECEIPT-001",
      sellerName: "Foreign Vendor Ltd",
      issueDate: "2025-01-20",
      grossTotal: 45.99,
      currency: "USD",
    });

    await correctInvoiceCategory(db, invoice.id, category.id);

    const rules = await listRules(db);
    expect(rules).toEqual([
      expect.objectContaining({
        matchType: "seller_name_contains",
        matchValue: "Foreign Vendor Ltd",
        categoryId: category.id,
      }),
    ]);
  });

  it("updates the existing rule instead of creating a duplicate when re-correcting the same seller", async () => {
    const media = await createCategory(db, "Media");
    const other = await createCategory(db, "Inne");
    const invoice = await insertKsefInvoiceIfNotExists(db, SAMPLE_INVOICE);

    await correctInvoiceCategory(db, invoice.id, media.id);
    await correctInvoiceCategory(db, invoice.id, other.id);

    const rules = await listRules(db);
    expect(rules).toHaveLength(1);
    expect(rules[0]?.categoryId).toBe(other.id);
  });

  it("throws InvoiceNotFoundError for a non-existent invoice", async () => {
    const category = await createCategory(db, "Media");

    await expect(correctInvoiceCategory(db, 999, category.id)).rejects.toThrow(
      InvoiceNotFoundError,
    );
  });
});
