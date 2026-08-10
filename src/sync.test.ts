import { describe, expect, it, vi } from "vitest";
import { seedCategorizationRules } from "./categorization/seed-rules.js";
import { createDb } from "./db/client.js";
import { getInvoiceByKsefNumber, updateInvoiceCategory } from "./db/invoices.js";
import { getContinuationPoint, setContinuationPoint } from "./db/sync-state.js";
import type { FetchPurchaseInvoicesResult } from "./ksef/invoices.js";
import { syncPurchaseInvoices } from "./sync.js";

function record(overrides: Partial<FetchPurchaseInvoicesResult["invoices"][number]> = {}) {
  return {
    ksefNumber: "5265877635-2025-01-15-000001-00-XXXXXXXXXX",
    invoiceNumber: "FV/1",
    sellerNip: "1112223344",
    sellerName: "Energa Obrót S.A.",
    buyerNip: "1111111111",
    buyerName: "Parkowa Sp. z o.o.",
    issueDate: "2025-01-15",
    grossTotal: 123.45,
    currency: "PLN",
    rawXml: "<Faktura/>",
    ...overrides,
  };
}

function fakeClient() {
  // syncPurchaseInvoices only forwards this to the injected fetchInvoices,
  // never touches it directly -- an empty object is enough.
  return {} as never;
}

describe("syncPurchaseInvoices", () => {
  it("persists a new invoice and auto-categorizes it via a matching seed rule", async () => {
    const { db, sqlite } = createDb(":memory:");
    await seedCategorizationRules(db);

    const fetchInvoices = async (): Promise<FetchPurchaseInvoicesResult> => ({
      invoices: [record()],
      continuationPoints: { Subject2: "2025-01-31T00:00:00Z" },
      referenceNumbers: ["ref-1"],
    });

    const result = await syncPurchaseInvoices(
      db,
      fakeClient(),
      { windowFrom: "2025-01-01", windowTo: "2025-01-31" },
      { fetchInvoices },
    );

    expect(result.invoices).toHaveLength(1);
    expect(result.invoices[0]?.categorizationConfidence).toBe("matched");
    expect(result.invoices[0]?.categoryId).not.toBeNull();
    expect(result.diagnostics).toMatchObject({
      fetchedCount: 1,
      insertedCount: 1,
      duplicateCount: 0,
      categorizedCount: 1,
      needsReviewCount: 0,
      maxIterations: 1,
    });

    sqlite.close();
  });

  it("flags a new invoice with no matching rule as needs_review", async () => {
    const { db, sqlite } = createDb(":memory:");
    await seedCategorizationRules(db);

    const fetchInvoices = async (): Promise<FetchPurchaseInvoicesResult> => ({
      invoices: [
        record({ ksefNumber: "unmatched-ksef-number", sellerName: "Totally Unrelated Vendor" }),
      ],
      continuationPoints: { Subject2: "2025-01-31T00:00:00Z" },
      referenceNumbers: ["ref-1"],
    });

    const result = await syncPurchaseInvoices(
      db,
      fakeClient(),
      { windowFrom: "2025-01-01", windowTo: "2025-01-31" },
      { fetchInvoices },
    );

    expect(result.invoices[0]?.categorizationConfidence).toBe("needs_review");
    expect(result.invoices[0]?.categoryId).toBeNull();

    sqlite.close();
  });

  it("never overwrites a category a human already assigned on re-sync", async () => {
    const { db, sqlite } = createDb(":memory:");
    await seedCategorizationRules(db);

    const invoiceRecord = record();
    const fetchInvoices = async (): Promise<FetchPurchaseInvoicesResult> => ({
      invoices: [invoiceRecord],
      continuationPoints: { Subject2: "2025-01-31T00:00:00Z" },
      referenceNumbers: ["ref-1"],
    });

    await syncPurchaseInvoices(
      db,
      fakeClient(),
      { windowFrom: "2025-01-01", windowTo: "2025-01-31" },
      { fetchInvoices },
    );

    // Simulate a human manually re-assigning the category to something the
    // rules engine would never have picked (a made-up category id).
    const stored = await getInvoiceByKsefNumber(db, invoiceRecord.ksefNumber);
    if (!stored) throw new Error("test setup bug: invoice not found");
    const humanCategoryId = stored.categoryId === 1 ? 2 : 1;
    await updateInvoiceCategory(db, stored.id, humanCategoryId, "matched");

    // Re-run the sync with the same invoice (as would happen on overlapping windows).
    const result = await syncPurchaseInvoices(
      db,
      fakeClient(),
      { windowFrom: "2025-01-01", windowTo: "2025-01-31" },
      { fetchInvoices },
    );

    expect(result.invoices[0]?.categoryId).toBe(humanCategoryId);
    expect(result.diagnostics).toMatchObject({ insertedCount: 0, duplicateCount: 1 });

    sqlite.close();
  });

  it("persists the updated continuation point for the next sync", async () => {
    const { db, sqlite } = createDb(":memory:");
    await seedCategorizationRules(db);

    const fetchInvoices = async (): Promise<FetchPurchaseInvoicesResult> => ({
      invoices: [record()],
      continuationPoints: { Subject2: "2025-01-31T00:00:00Z" },
      referenceNumbers: ["ref-1"],
    });

    expect(await getContinuationPoint(db, "Subject2")).toBeUndefined();

    await syncPurchaseInvoices(
      db,
      fakeClient(),
      { windowFrom: "2025-01-01", windowTo: "2025-01-31" },
      { fetchInvoices },
    );

    expect(await getContinuationPoint(db, "Subject2")).toBe("2025-01-31T00:00:00Z");

    sqlite.close();
  });

  it("passes the previously persisted continuation point into the next fetch call", async () => {
    const { db, sqlite } = createDb(":memory:");
    await seedCategorizationRules(db);

    let capturedContinuationPoints: unknown;
    const fetchInvoices = (async (
      _client: unknown,
      opts: { continuationPoints: unknown },
    ): Promise<FetchPurchaseInvoicesResult> => {
      capturedContinuationPoints = opts.continuationPoints;
      return {
        invoices: [],
        continuationPoints: { Subject2: "2025-02-28T00:00:00Z" },
        referenceNumbers: [],
      };
    }) as unknown as typeof import("./ksef/invoices.js").fetchPurchaseInvoices;

    await setContinuationPoint(db, "Subject2", "2025-01-31T00:00:00Z");

    await syncPurchaseInvoices(
      db,
      fakeClient(),
      { windowFrom: "2025-02-01", windowTo: "2025-02-28" },
      { fetchInvoices },
    );

    expect(capturedContinuationPoints).toEqual({ Subject2: "2025-01-31T00:00:00Z" });

    sqlite.close();
  });

  it("reports progress via the injected logger", async () => {
    const { db, sqlite } = createDb(":memory:");
    await seedCategorizationRules(db);

    const fetchInvoices = async (): Promise<FetchPurchaseInvoicesResult> => ({
      invoices: [record()],
      continuationPoints: { Subject2: "2025-01-31T00:00:00Z" },
      referenceNumbers: ["ref-1"],
    });
    const info = vi.fn();

    await syncPurchaseInvoices(
      db,
      fakeClient(),
      { windowFrom: "2025-01-01", windowTo: "2025-01-31" },
      { fetchInvoices, logger: { info } },
    );

    expect(info).toHaveBeenCalledWith("sync.fetch.started", expect.any(Object));
    expect(info).toHaveBeenCalledWith(
      "sync.fetch.completed",
      expect.objectContaining({ fetchedCount: 1 }),
    );
    expect(info).toHaveBeenCalledWith("sync.persist.started", { fetchedCount: 1 });
    expect(info).toHaveBeenCalledWith(
      "sync.persist.completed",
      expect.objectContaining({ insertedCount: 1, categorizedCount: 1 }),
    );

    sqlite.close();
  });

  it("defaults maxIterations to 1 so a single call only fetches one KSeF export page", async () => {
    const { db, sqlite } = createDb(":memory:");
    await seedCategorizationRules(db);

    const fetchInvoices = vi.fn(
      async (): Promise<FetchPurchaseInvoicesResult> => ({
        invoices: [],
        continuationPoints: {},
        referenceNumbers: [],
      }),
    );

    await syncPurchaseInvoices(
      db,
      fakeClient(),
      { windowFrom: "2025-01-01", windowTo: "2025-01-31" },
      { fetchInvoices },
    );

    expect(fetchInvoices).toHaveBeenCalledWith(
      fakeClient(),
      expect.objectContaining({ maxIterations: 1 }),
    );

    sqlite.close();
  });

  it("reports hasMore when the new continuation point hasn't reached windowTo yet", async () => {
    const { db, sqlite } = createDb(":memory:");
    await seedCategorizationRules(db);

    const fetchInvoices = async (): Promise<FetchPurchaseInvoicesResult> => ({
      invoices: [],
      // Truncated/partial page: KSeF's HWM only advanced to the 15th, well
      // short of the requested windowTo (the 31st).
      continuationPoints: { Subject2: "2025-01-15T00:00:00Z" },
      referenceNumbers: ["ref-1"],
    });

    const result = await syncPurchaseInvoices(
      db,
      fakeClient(),
      { windowFrom: "2025-01-01", windowTo: "2025-01-31" },
      { fetchInvoices },
    );

    expect(result.hasMore).toBe(true);

    sqlite.close();
  });

  it("reports hasMore as false once the continuation point reaches windowTo", async () => {
    const { db, sqlite } = createDb(":memory:");
    await seedCategorizationRules(db);

    const fetchInvoices = async (): Promise<FetchPurchaseInvoicesResult> => ({
      invoices: [],
      continuationPoints: { Subject2: "2025-01-31" },
      referenceNumbers: ["ref-1"],
    });

    const result = await syncPurchaseInvoices(
      db,
      fakeClient(),
      { windowFrom: "2025-01-01", windowTo: "2025-01-31" },
      { fetchInvoices },
    );

    expect(result.hasMore).toBe(false);

    sqlite.close();
  });
});
