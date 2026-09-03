import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCategory } from "../db/categories.js";
import type { Db } from "../db/client.js";
import { createDb } from "../db/client.js";
import { type NewInvoiceItem, replaceInvoiceItems } from "../db/invoice-items.js";
import {
  insertKsefInvoiceIfNotExists,
  insertManualInvoice,
  type NewKsefInvoice,
  updateInvoiceCategory,
  updateInvoiceKind,
} from "../db/invoices.js";
import { assertIsoDate } from "../time.js";
import {
  assertUsableDatabaseFile,
  fetchExportInvoiceItems,
  fetchExportInvoices,
} from "./export-invoices.js";

describe("fetchExportInvoices", () => {
  let db: Db;
  let close: () => void;

  beforeEach(() => {
    const opened = createDb(":memory:");
    db = opened.db;
    close = () => opened.sqlite.close();
  });

  afterEach(() => close());

  let ksefCounter = 0;
  const insertKsef = (
    overrides: Partial<NewKsefInvoice> & { invoiceNumber: string; issueDate: string },
  ) => {
    ksefCounter += 1;
    return insertKsefInvoiceIfNotExists(db, {
      ksefNumber: `5265877635-20260801-12345678901${ksefCounter}-01`,
      sellerNip: "1234567890",
      sellerName: "Test Seller",
      grossTotal: 123,
      currency: "PLN",
      rawXml: "<Faktura></Faktura>",
      ...overrides,
    });
  };

  it("returns all invoices when no filter is given, ordered by issueDate DESC, invoiceNumber ASC", async () => {
    await insertKsef({ invoiceNumber: "A/1", issueDate: "2026-01-15" });
    await insertKsef({ invoiceNumber: "A/2", issueDate: "2026-03-01" });
    await insertKsef({ invoiceNumber: "B/1", issueDate: "2026-03-01" });

    const rows = await fetchExportInvoices(db);

    expect(rows).toHaveLength(3);
    expect(rows.map((r) => [r.issueDate, r.invoiceNumber])).toEqual([
      ["2026-03-01", "A/2"],
      ["2026-03-01", "B/1"],
      ["2026-01-15", "A/1"],
    ]);
  });

  it("filters inclusively with `from` only", async () => {
    await insertKsef({ invoiceNumber: "IN", issueDate: "2026-02-20" });
    await insertKsef({ invoiceNumber: "BOUNDARY", issueDate: "2026-02-15" });
    await insertKsef({ invoiceNumber: "OUT", issueDate: "2026-02-14" });

    const rows = await fetchExportInvoices(db, { from: assertIsoDate("2026-02-15") });

    expect(rows.map((r) => r.invoiceNumber)).toEqual(["IN", "BOUNDARY"]);
  });

  it("filters inclusively with `to` only", async () => {
    await insertKsef({ invoiceNumber: "IN", issueDate: "2026-02-10" });
    await insertKsef({ invoiceNumber: "BOUNDARY", issueDate: "2026-02-15" });
    await insertKsef({ invoiceNumber: "OUT", issueDate: "2026-02-16" });

    const rows = await fetchExportInvoices(db, { to: assertIsoDate("2026-02-15") });

    expect(rows.map((r) => r.invoiceNumber)).toEqual(["BOUNDARY", "IN"]);
  });

  it("filters inclusively with `from` and `to` together, on both boundaries", async () => {
    await insertKsef({ invoiceNumber: "BEFORE", issueDate: "2026-02-09" });
    await insertKsef({ invoiceNumber: "FROM_BOUNDARY", issueDate: "2026-02-10" });
    await insertKsef({ invoiceNumber: "MIDDLE", issueDate: "2026-02-12" });
    await insertKsef({ invoiceNumber: "TO_BOUNDARY", issueDate: "2026-02-15" });
    await insertKsef({ invoiceNumber: "AFTER", issueDate: "2026-02-16" });

    const rows = await fetchExportInvoices(db, {
      from: assertIsoDate("2026-02-10"),
      to: assertIsoDate("2026-02-15"),
    });

    expect(rows.map((r) => r.invoiceNumber).sort()).toEqual(
      ["FROM_BOUNDARY", "MIDDLE", "TO_BOUNDARY"].sort(),
    );
  });

  it("left-joins categories: an assigned category's name is returned, and an uncategorized invoice is never dropped", async () => {
    const category = await createCategory(db, "Media");
    const categorized = await insertKsef({ invoiceNumber: "CAT", issueDate: "2026-01-01" });
    await updateInvoiceCategory(db, categorized.id, category.id, "matched");
    await insertKsef({ invoiceNumber: "UNCAT", issueDate: "2026-01-02" });

    const rows = await fetchExportInvoices(db);

    expect(rows).toHaveLength(2);
    const categorizedRow = rows.find((r) => r.invoiceNumber === "CAT");
    const uncategorizedRow = rows.find((r) => r.invoiceNumber === "UNCAT");

    expect(categorizedRow?.categoryName).toBe("Media");
    // This is the leftJoin regression guard: an innerJoin would drop this row entirely.
    expect(uncategorizedRow).toBeDefined();
    expect(uncategorizedRow?.categoryName).toBeNull();
  });

  it("includes direction, invoiceKind, and itemsExtractedAt with correct values", async () => {
    const sale = await insertKsef({
      invoiceNumber: "SALE",
      issueDate: "2026-01-01",
      direction: "sales",
      categorizationConfidence: "not_applicable",
    });
    await updateInvoiceKind(db, sale.id, "KOR");
    replaceInvoiceItems(db, sale.id, []);

    const rows = await fetchExportInvoices(db);
    const row = rows[0];
    if (!row) throw new Error("expected a row");

    expect(row.direction).toBe("sales");
    expect(row.invoiceKind).toBe("KOR");
    expect(row.itemsExtractedAt).toBeInstanceOf(Date);
  });

  it("defaults direction to purchase and invoiceKind/itemsExtractedAt to null when not set", async () => {
    await insertKsef({ invoiceNumber: "PLAIN", issueDate: "2026-01-01" });

    const rows = await fetchExportInvoices(db);
    const row = rows[0];
    if (!row) throw new Error("expected a row");

    expect(row.direction).toBe("purchase");
    expect(row.invoiceKind).toBeNull();
    expect(row.itemsExtractedAt).toBeNull();
  });

  it("never selects raw_xml", async () => {
    await insertKsef({ invoiceNumber: "X", issueDate: "2026-01-01" });

    const rows = await fetchExportInvoices(db);

    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toHaveProperty("rawXml");
  });

  it("includes manual invoices too", async () => {
    await insertManualInvoice(db, {
      invoiceNumber: "MANUAL/1",
      sellerName: "Manual Seller",
      issueDate: "2026-01-05",
      grossTotal: 50,
      currency: "PLN",
    });

    const rows = await fetchExportInvoices(db);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBe("manual");
    expect(rows[0]?.categoryName).toBeNull();
  });
});

describe("fetchExportInvoiceItems", () => {
  let db: Db;
  let close: () => void;

  beforeEach(() => {
    const opened = createDb(":memory:");
    db = opened.db;
    close = () => opened.sqlite.close();
  });

  afterEach(() => close());

  it("returns items across multiple invoices ordered by (invoiceId, ordinal), with ksefNumber/invoiceNumber attached", async () => {
    const invoiceA = await insertKsefInvoiceIfNotExists(db, {
      ksefNumber: "5265877635-20260801-123456789012-01",
      invoiceNumber: "A/1",
      sellerNip: "1234567890",
      sellerName: "Seller A",
      issueDate: "2026-01-01",
      grossTotal: 100,
      currency: "PLN",
      rawXml: "<Faktura></Faktura>",
    });
    const invoiceB = await insertKsefInvoiceIfNotExists(db, {
      ksefNumber: "5265877635-20260801-123456789012-02",
      invoiceNumber: "B/1",
      sellerNip: "1234567890",
      sellerName: "Seller B",
      issueDate: "2026-01-02",
      grossTotal: 200,
      currency: "PLN",
      rawXml: "<Faktura></Faktura>",
    });
    // invoiceC has zero items -- must contribute zero rows.
    const invoiceC = await insertKsefInvoiceIfNotExists(db, {
      ksefNumber: "5265877635-20260801-123456789012-03",
      invoiceNumber: "C/1",
      sellerNip: "1234567890",
      sellerName: "Seller C",
      issueDate: "2026-01-03",
      grossTotal: 300,
      currency: "PLN",
      rawXml: "<Faktura></Faktura>",
    });
    replaceInvoiceItems(db, invoiceC.id, []);

    const itemsA: NewInvoiceItem[] = [
      { invoiceId: invoiceA.id, ordinal: 2, name: "Item A2" },
      { invoiceId: invoiceA.id, ordinal: 1, name: "Item A1" },
    ];
    const itemsB: NewInvoiceItem[] = [{ invoiceId: invoiceB.id, ordinal: 1, name: "Item B1" }];
    replaceInvoiceItems(db, invoiceA.id, itemsA);
    replaceInvoiceItems(db, invoiceB.id, itemsB);

    const parents = [invoiceA, invoiceB, invoiceC].map((invoice) => ({
      id: invoice.id,
      ksefNumber: invoice.ksefNumber,
      invoiceNumber: invoice.invoiceNumber,
    }));

    const rows = await fetchExportInvoiceItems(db, parents);

    expect(rows).toHaveLength(3);
    // Ordered by (invoiceId, ordinal): invoiceA's two items (in ordinal order), then invoiceB's one item.
    expect(rows.map((r) => [r.invoiceId, r.ordinal, r.name])).toEqual([
      [invoiceA.id, 1, "Item A1"],
      [invoiceA.id, 2, "Item A2"],
      [invoiceB.id, 1, "Item B1"],
    ]);

    const rowA1 = rows.find((r) => r.invoiceId === invoiceA.id && r.ordinal === 1);
    expect(rowA1?.ksefNumber).toBe(invoiceA.ksefNumber);
    expect(rowA1?.invoiceNumber).toBe(invoiceA.invoiceNumber);

    const rowB1 = rows.find((r) => r.invoiceId === invoiceB.id);
    expect(rowB1?.ksefNumber).toBe(invoiceB.ksefNumber);
    expect(rowB1?.invoiceNumber).toBe(invoiceB.invoiceNumber);

    // invoiceC contributed zero rows.
    expect(rows.some((r) => r.invoiceId === invoiceC.id)).toBe(false);
  });

  it("returns an empty array when given no parent invoices", async () => {
    const rows = await fetchExportInvoiceItems(db, []);
    expect(rows).toEqual([]);
  });
});

describe("assertUsableDatabaseFile", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("throws for a nonexistent path", () => {
    const base = mkdtempSync(join(tmpdir(), "ksef-exporter-export-test-"));
    tempDir = base;
    const dbPath = join(base, "does-not-exist.sqlite");

    expect(() => assertUsableDatabaseFile(dbPath)).toThrow(/not found/i);
  });

  it("throws for a directory path", () => {
    const base = mkdtempSync(join(tmpdir(), "ksef-exporter-export-test-"));
    tempDir = base;

    expect(() => assertUsableDatabaseFile(base)).toThrow(/not a file/i);
  });

  it("throws for a plain text file that isn't a SQLite database", () => {
    const base = mkdtempSync(join(tmpdir(), "ksef-exporter-export-test-"));
    tempDir = base;
    const filePath = join(base, "not-a-db.txt");
    writeFileSync(filePath, "just some text, not a sqlite file at all");

    expect(() => assertUsableDatabaseFile(filePath)).toThrow(/not a valid sqlite database/i);
  });

  it("throws for a real SQLite file with no invoices table", () => {
    const base = mkdtempSync(join(tmpdir(), "ksef-exporter-export-test-"));
    tempDir = base;
    const dbPath = join(base, "no-invoices.sqlite");
    const sqlite = new Database(dbPath);
    sqlite.exec("CREATE TABLE foo (id INTEGER)");
    sqlite.close();

    expect(() => assertUsableDatabaseFile(dbPath)).toThrow(/invoices/i);
  });

  it("does not throw for a real ksef-exporter database", () => {
    const base = mkdtempSync(join(tmpdir(), "ksef-exporter-export-test-"));
    tempDir = base;
    const dbPath = join(base, "ksef-exporter.sqlite");
    const { sqlite } = createDb(dbPath);
    sqlite.close();

    expect(() => assertUsableDatabaseFile(dbPath)).not.toThrow();
  });
});
