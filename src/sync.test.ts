import { describe, expect, it, vi } from "vitest";
import { seedCategorizationRules } from "./categorization/seed-rules.js";
import { createDb } from "./db/client.js";
import { listInvoiceItems } from "./db/invoice-items.js";
import { getInvoiceByKsefNumber, updateInvoiceCategory } from "./db/invoices.js";
import { createSyncRun, markSyncRunSuccess } from "./db/sync-runs.js";
import { getContinuationPoint, setContinuationPoint } from "./db/sync-state.js";
import type { InvoiceItemRecord } from "./ksef/invoice-parser.js";
import type { FetchPurchaseInvoicesResult } from "./ksef/invoices.js";
import { syncPurchaseInvoices } from "./sync.js";

/** A parsed FaWiersz line, with every optional field null unless overridden. */
function item(overrides: Partial<InvoiceItemRecord> = {}): InvoiceItemRecord {
  return {
    ordinal: 1,
    lineNumber: 1,
    uuId: null,
    deliveryDate: null,
    name: "Stripsy z kurczaka 1kg",
    indexCode: null,
    gtin: null,
    pkwiu: null,
    cn: null,
    pkob: null,
    unit: "szt.",
    quantity: 6,
    unitPriceNet: 41.19,
    unitPriceGross: null,
    discount: null,
    netValue: 247.14,
    grossValue: null,
    vatValue: null,
    vatRate: "5",
    vatRateOss: null,
    annex15: null,
    excise: null,
    gtuCode: null,
    procedureCode: null,
    exchangeRate: null,
    correctionStateBefore: null,
    ...overrides,
  };
}

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
    netTotal: null,
    vatTotal: null,
    paymentDueDate: null,
    rawXml: "<Faktura/>",
    items: [],
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

  it("persists net_total/vat_total/payment_due_date on a fresh sync, with no separate backfill step", async () => {
    // design/INVOICE_HEADER_FIELDS_PLAN.md §6.5: unlike invoice_kind (which is
    // only ever set by the offline backfill), these three fields are wired
    // into the same insert-time parse step as grossTotal, so a newly-synced
    // invoice must have them populated immediately.
    const { db, sqlite } = createDb(":memory:");
    await seedCategorizationRules(db);

    const fetchInvoices = async (): Promise<FetchPurchaseInvoicesResult> => ({
      invoices: [record({ netTotal: 100.5, vatTotal: 22.95, paymentDueDate: "2025-02-14" })],
      continuationPoints: { Subject2: "2025-01-31T00:00:00Z" },
      referenceNumbers: ["ref-1"],
    });

    const result = await syncPurchaseInvoices(
      db,
      fakeClient(),
      { windowFrom: "2025-01-01", windowTo: "2025-01-31" },
      { fetchInvoices },
    );

    expect(result.invoices[0]?.netTotal).toBe(100.5);
    expect(result.invoices[0]?.vatTotal).toBe(22.95);
    expect(result.invoices[0]?.paymentDueDate).toBe("2025-02-14");

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

  it("logs each invoice that is inserted", async () => {
    const { db, sqlite } = createDb(":memory:");
    await seedCategorizationRules(db);

    const invoiceRecord = record();
    const fetchInvoices = async (): Promise<FetchPurchaseInvoicesResult> => ({
      invoices: [invoiceRecord],
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

    expect(info).toHaveBeenCalledWith(
      "sync.persist.inserted",
      expect.objectContaining({
        ksefNumber: invoiceRecord.ksefNumber,
        invoiceNumber: invoiceRecord.invoiceNumber,
      }),
    );

    sqlite.close();
  });

  it("logs each invoice that was fetched but not inserted because it already exists", async () => {
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

    const info = vi.fn();
    await syncPurchaseInvoices(
      db,
      fakeClient(),
      { windowFrom: "2025-01-01", windowTo: "2025-01-31" },
      { fetchInvoices, logger: { info } },
    );

    expect(info).toHaveBeenCalledWith(
      "sync.persist.duplicate",
      expect.objectContaining({ ksefNumber: invoiceRecord.ksefNumber }),
    );

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

    await setContinuationPoint(db, "Subject2", "2025-02-10T00:00:00Z");

    await syncPurchaseInvoices(
      db,
      fakeClient(),
      { windowFrom: "2025-02-01", windowTo: "2025-02-28" },
      { fetchInvoices },
    );

    expect(capturedContinuationPoints).toEqual({ Subject2: "2025-02-10T00:00:00Z" });

    sqlite.close();
  });

  it("ignores a continuation point earlier than windowFrom so the requested window starts at windowFrom", async () => {
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
        continuationPoints: { Subject2: "2026-02-28T00:00:00+00:00" },
        referenceNumbers: [],
      };
    }) as unknown as typeof import("./ksef/invoices.js").fetchPurchaseInvoices;
    const warn = vi.fn();

    await setContinuationPoint(db, "Subject2", "2026-01-15T00:00:00+00:00");

    await syncPurchaseInvoices(
      db,
      fakeClient(),
      { windowFrom: "2026-02-01", windowTo: "2026-02-28" },
      { fetchInvoices, logger: { info: vi.fn(), warn } },
    );

    expect(capturedContinuationPoints).toEqual({});
    expect(warn).toHaveBeenCalledWith(
      "sync.continuation.conflict",
      expect.objectContaining({ effectiveFrom: "2026-02-01" }),
    );
    // Monotonic: the newer fetched high-water mark is kept.
    expect(await getContinuationPoint(db, "Subject2")).toBe("2026-02-28T00:00:00+00:00");

    sqlite.close();
  });

  it("does not backfill a gap day between two non-overlapping import windows", async () => {
    const { db, sqlite } = createDb(":memory:");

    const universe = [
      record({ ksefNumber: "TEST-08-01", issueDate: "2026-08-01" }),
      record({ ksefNumber: "TEST-08-02", issueDate: "2026-08-02" }),
      record({ ksefNumber: "TEST-08-03", issueDate: "2026-08-03" }), // unrequested gap day
      record({ ksefNumber: "TEST-08-04", issueDate: "2026-08-04" }),
      record({ ksefNumber: "TEST-08-05", issueDate: "2026-08-05" }),
      record({ ksefNumber: "TEST-08-06", issueDate: "2026-08-06" }),
      record({ ksefNumber: "TEST-08-07", issueDate: "2026-08-07" }),
    ];

    const fetchInvoices = (async (
      _client: unknown,
      opts: { windowFrom: string; windowTo: string; continuationPoints: { Subject2?: string } },
    ): Promise<FetchPurchaseInvoicesResult> => {
      const from = opts.continuationPoints.Subject2 ?? opts.windowFrom;
      const invoices = universe.filter(
        (i) => i.issueDate >= from.slice(0, 10) && i.issueDate <= opts.windowTo,
      );
      const nextDay = new Date(`${opts.windowTo}T00:00:00Z`);
      nextDay.setUTCDate(nextDay.getUTCDate() + 1);
      return {
        invoices,
        continuationPoints: { Subject2: nextDay.toISOString() },
        referenceNumbers: [],
      };
    }) as unknown as typeof import("./ksef/invoices.js").fetchPurchaseInvoices;

    await syncPurchaseInvoices(
      db,
      fakeClient(),
      { windowFrom: "2026-08-01", windowTo: "2026-08-02" },
      { fetchInvoices },
    );
    await syncPurchaseInvoices(
      db,
      fakeClient(),
      { windowFrom: "2026-08-04", windowTo: "2026-08-07" },
      { fetchInvoices },
    );

    // The gap day (Aug 3) was never requested in either window, and the stored
    // HWM from import 1 lies before import 2's windowFrom, so it must not be
    // backfilled.
    expect(await getInvoiceByKsefNumber(db, "TEST-08-03")).toBeUndefined();
    expect(await getInvoiceByKsefNumber(db, "TEST-08-04")).toBeDefined();
    expect(await getContinuationPoint(db, "Subject2")).toBe("2026-08-08T00:00:00.000Z");

    sqlite.close();
  });

  it("ignores a continuation point that is later than windowTo so a backfill can run", async () => {
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
        continuationPoints: { Subject2: "2026-07-31T00:00:00+00:00" },
        referenceNumbers: [],
      };
    }) as unknown as typeof import("./ksef/invoices.js").fetchPurchaseInvoices;
    const warn = vi.fn();

    await setContinuationPoint(db, "Subject2", "2026-08-10T15:32:59.989017+00:00");

    const result = await syncPurchaseInvoices(
      db,
      fakeClient(),
      { windowFrom: "2026-07-01", windowTo: "2026-07-31" },
      { fetchInvoices, logger: { info: vi.fn(), warn } },
    );

    expect(capturedContinuationPoints).toEqual({});
    expect(warn).toHaveBeenCalledWith(
      "sync.continuation.conflict",
      expect.objectContaining({ effectiveFrom: "2026-07-01" }),
    );
    // Monotonic: the backfill's older high-water mark must not rewind the stored one.
    expect(await getContinuationPoint(db, "Subject2")).toBe("2026-08-10T15:32:59.989017+00:00");
    expect(result.diagnostics.continuationAfter).toBe("2026-08-10T15:32:59.989017+00:00");

    sqlite.close();
  });

  it("keeps the stored continuation point when the fetch returns none", async () => {
    const { db, sqlite } = createDb(":memory:");
    await seedCategorizationRules(db);

    const fetchInvoices = async (): Promise<FetchPurchaseInvoicesResult> => ({
      invoices: [],
      continuationPoints: {},
      referenceNumbers: [],
    });

    await setContinuationPoint(db, "Subject2", "2025-01-31T00:00:00Z");

    await syncPurchaseInvoices(
      db,
      fakeClient(),
      { windowFrom: "2025-01-01", windowTo: "2025-01-31" },
      { fetchInvoices },
    );

    expect(await getContinuationPoint(db, "Subject2")).toBe("2025-01-31T00:00:00Z");

    sqlite.close();
  });

  it("logs the effective query start, which the continuation point can move past windowFrom", async () => {
    const { db, sqlite } = createDb(":memory:");
    await seedCategorizationRules(db);

    const fetchInvoices = async (): Promise<FetchPurchaseInvoicesResult> => ({
      invoices: [],
      continuationPoints: { Subject2: "2026-08-20T00:00:00+00:00" },
      referenceNumbers: [],
    });
    const info = vi.fn();

    await setContinuationPoint(db, "Subject2", "2026-08-10T15:32:59.989017+00:00");

    await syncPurchaseInvoices(
      db,
      fakeClient(),
      { windowFrom: "2026-08-01", windowTo: "2026-08-31" },
      { fetchInvoices, logger: { info } },
    );

    expect(info).toHaveBeenCalledWith(
      "sync.fetch.started",
      expect.objectContaining({
        effectiveFrom: "2026-08-10T15:32:59.989017+00:00",
        continuationApplied: true,
        windowStartSkipped: true,
      }),
    );

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

  it("reports hasMore as false once the continuation point passes the end of windowTo", async () => {
    const { db, sqlite } = createDb(":memory:");
    await seedCategorizationRules(db);

    const fetchInvoices = async (): Promise<FetchPurchaseInvoicesResult> => ({
      invoices: [],
      // Past the exclusive end of the window (2025-02-01T00:00Z), so the whole
      // window has been covered.
      continuationPoints: { Subject2: "2025-02-01T00:00:00+00:00" },
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

  it("regression, Defect C: reports hasMore for a point on the final day of the window", async () => {
    const { db, sqlite } = createDb(":memory:");
    await seedCategorizationRules(db);

    const fetchInvoices = async (): Promise<FetchPurchaseInvoicesResult> => ({
      invoices: [],
      continuationPoints: { Subject2: "2026-08-31T05:00:00+00:00" },
      referenceNumbers: ["ref-1"],
    });

    const result = await syncPurchaseInvoices(
      db,
      fakeClient(),
      { windowFrom: "2026-08-01", windowTo: "2026-08-31" },
      // hasMore is also capped by wall-clock "now" (see the future-windowTo
      // regression test below), so this must inject a "now" past the window
      // for the scenario -- "the 31st has already happened" -- to hold.
      { fetchInvoices, now: () => Date.parse("2026-09-01T00:00:00Z") },
    );

    // Lexicographically the instant sorts after the bare date, which used to
    // report the import complete while the rest of the 31st went unimported.
    expect("2026-08-31T05:00:00+00:00" < "2026-08-31").toBe(false);
    expect(result.hasMore).toBe(true);

    sqlite.close();
  });

  it("regression: does not report hasMore forever when windowTo is in the future", async () => {
    const { db, sqlite } = createDb(":memory:");
    await seedCategorizationRules(db);

    // KSeF found nothing new and advanced its high-water mark to roughly
    // "now" (a few seconds after the injected clock), not to windowTo, which
    // is still 3 days away -- comparing only against windowTo would report
    // hasMore forever since "now" always creeps forward but windowTo never
    // arrives on its own.
    const fetchInvoices = async (): Promise<FetchPurchaseInvoicesResult> => ({
      invoices: [],
      continuationPoints: { Subject2: "2026-08-28T18:00:05+00:00" },
      referenceNumbers: [],
    });

    const result = await syncPurchaseInvoices(
      db,
      fakeClient(),
      { windowFrom: "2026-06-01", windowTo: "2026-08-31" },
      { fetchInvoices, now: () => Date.parse("2026-08-28T18:00:00Z") },
    );

    expect(result.hasMore).toBe(false);

    sqlite.close();
  });

  it("regression: does not report hasMore forever when the high-water mark stalls in a past window", async () => {
    const { db, sqlite } = createDb(":memory:");
    await seedCategorizationRules(db);

    // Simulates the call after a truncated first page: the continuation point
    // already persisted is exactly what KSeF returns again on this call --
    // no new data, and windowTo is in the past, so there is nothing more this
    // engine can do to make the high-water mark move.
    const stalled = "2026-08-30T22:00:00+00:00";
    await setContinuationPoint(db, "Subject2", stalled);

    const fetchInvoices = async (): Promise<FetchPurchaseInvoicesResult> => ({
      invoices: [],
      continuationPoints: { Subject2: stalled },
      referenceNumbers: [],
    });

    const result = await syncPurchaseInvoices(
      db,
      fakeClient(),
      { windowFrom: "2026-08-01", windowTo: "2026-08-31" },
      { fetchInvoices, now: () => Date.parse("2026-09-03T00:00:00Z") },
    );

    expect(result.hasMore).toBe(false);

    sqlite.close();
  });

  it("still reports hasMore when the high-water mark keeps advancing toward a past windowTo", async () => {
    const { db, sqlite } = createDb(":memory:");
    await seedCategorizationRules(db);

    // Same shape as the stall regression above, but this call's continuation
    // point genuinely advances past the one already stored -- real progress,
    // still short of windowTo, so hasMore must stay true.
    await setContinuationPoint(db, "Subject2", "2026-08-20T00:00:00+00:00");

    const fetchInvoices = async (): Promise<FetchPurchaseInvoicesResult> => ({
      invoices: [],
      continuationPoints: { Subject2: "2026-08-25T00:00:00+00:00" },
      referenceNumbers: [],
    });

    const result = await syncPurchaseInvoices(
      db,
      fakeClient(),
      { windowFrom: "2026-08-01", windowTo: "2026-08-31" },
      { fetchInvoices, now: () => Date.parse("2026-09-03T00:00:00Z") },
    );

    expect(result.hasMore).toBe(true);

    sqlite.close();
  });

  it("regression, Defect C: never rewinds the high-water mark to an earlier instant", async () => {
    const { db, sqlite } = createDb(":memory:");
    await seedCategorizationRules(db);

    // '+02:00' sorts above '+00:00' because '0' < '2', yet it is two hours
    // earlier. String order would have persisted the earlier instant.
    const stored = "2026-08-10T15:32:59.989017+00:00";
    const fetched = "2026-08-10T15:32:59.989017+02:00";
    expect(fetched > stored).toBe(true);

    const fetchInvoices = async (): Promise<FetchPurchaseInvoicesResult> => ({
      invoices: [],
      continuationPoints: { Subject2: fetched },
      referenceNumbers: ["ref-1"],
    });

    await setContinuationPoint(db, "Subject2", stored);

    const result = await syncPurchaseInvoices(
      db,
      fakeClient(),
      { windowFrom: "2026-08-01", windowTo: "2026-08-31" },
      { fetchInvoices },
    );

    expect(await getContinuationPoint(db, "Subject2")).toBe(stored);
    expect(result.diagnostics.continuationAfter).toBe(stored);

    sqlite.close();
  });

  it("regression, Defect B: applies a stored point that falls on the window's final day", async () => {
    const { db, sqlite } = createDb(":memory:");
    await seedCategorizationRules(db);

    let capturedContinuationPoints: unknown;
    const warn = vi.fn();

    const fetchInvoices = async (
      _client: unknown,
      opts: { continuationPoints: unknown },
    ): Promise<FetchPurchaseInvoicesResult> => {
      capturedContinuationPoints = opts.continuationPoints;
      return {
        invoices: [],
        continuationPoints: { Subject2: "2026-08-10T18:00:00+00:00" },
        referenceNumbers: ["ref-1"],
      };
    };

    const stored = "2026-08-10T15:32:59.989017+00:00";
    await setContinuationPoint(db, "Subject2", stored);

    await syncPurchaseInvoices(
      db,
      fakeClient(),
      { windowFrom: "2026-08-01", windowTo: "2026-08-10" },
      { fetchInvoices, logger: { info: () => {}, warn } },
    );

    // The stored instant shares windowTo's prefix and is longer, so `<= windowTo`
    // used to reject it and re-download the whole window against a 16/min cap.
    expect(stored <= "2026-08-10").toBe(false);
    expect(capturedContinuationPoints).toEqual({ Subject2: stored });
    expect(warn).not.toHaveBeenCalledWith("sync.continuation.conflict", expect.anything());

    sqlite.close();
  });

  it("falls back to the requested window when the stored point cannot be parsed", async () => {
    const { db, sqlite } = createDb(":memory:");
    await seedCategorizationRules(db);

    let capturedContinuationPoints: unknown;
    const warn = vi.fn();

    const fetchInvoices = async (
      _client: unknown,
      opts: { continuationPoints: unknown },
    ): Promise<FetchPurchaseInvoicesResult> => {
      capturedContinuationPoints = opts.continuationPoints;
      return {
        invoices: [],
        continuationPoints: { Subject2: "2026-08-31T00:00:00+00:00" },
        referenceNumbers: ["ref-1"],
      };
    };

    await setContinuationPoint(db, "Subject2", "not-a-timestamp");

    await syncPurchaseInvoices(
      db,
      fakeClient(),
      { windowFrom: "2026-08-01", windowTo: "2026-08-31" },
      { fetchInvoices, logger: { info: () => {}, warn } },
    );

    expect(capturedContinuationPoints).toEqual({});
    expect(warn).toHaveBeenCalledWith("sync.continuation.unparseable", expect.anything());

    sqlite.close();
  });

  it("rejects a window bound that is not a calendar date", async () => {
    const { db, sqlite } = createDb(":memory:");
    await seedCategorizationRules(db);

    await expect(
      syncPurchaseInvoices(
        db,
        fakeClient(),
        { windowFrom: "2026-02-30", windowTo: "2026-03-31" },
        {
          fetchInvoices: async () => ({
            invoices: [],
            continuationPoints: {},
            referenceNumbers: [],
          }),
        },
      ),
    ).rejects.toThrow(TypeError);

    sqlite.close();
  });

  it("persists the line items of a newly imported invoice", async () => {
    const { db, sqlite } = createDb(":memory:");
    await seedCategorizationRules(db);

    const fetchInvoices = async (): Promise<FetchPurchaseInvoicesResult> => ({
      invoices: [
        record({
          items: [
            item({ ordinal: 1, lineNumber: 1, name: "Energia elektryczna", vatRate: "23" }),
            // Same line number as ordinal 1, as correction invoices emit it.
            item({ ordinal: 2, lineNumber: 1, correctionStateBefore: true }),
            item({ ordinal: 3, lineNumber: 2, netValue: null, grossValue: 5500, vatRate: "zw" }),
          ],
        }),
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

    const invoiceId = result.invoices[0]?.id;
    if (invoiceId === undefined) throw new Error("test setup bug: invoice not persisted");
    const items = await listInvoiceItems(db, invoiceId);

    expect(items.map((row) => row.ordinal)).toEqual([1, 2, 3]);
    expect(items[0]?.name).toBe("Energia elektryczna");
    expect(items[1]?.correctionStateBefore).toBe(true);
    expect(items[2]).toMatchObject({ netValue: null, grossValue: 5500, vatRate: "zw" });
    expect(result.diagnostics).toMatchObject({ itemsInsertedCount: 3, itemsFailedCount: 0 });
    // Stamped, so a re-sync (and the backfill) both know to leave this invoice alone.
    expect(
      (await getInvoiceByKsefNumber(db, record().ksefNumber))?.itemsExtractedAt,
    ).not.toBeNull();

    sqlite.close();
  });

  it("does not duplicate items when the same window is re-synced", async () => {
    const { db, sqlite } = createDb(":memory:");
    await seedCategorizationRules(db);

    const invoiceRecord = record({
      items: [item({ ordinal: 1 }), item({ ordinal: 2, lineNumber: 2 })],
    });
    const fetchInvoices = async (): Promise<FetchPurchaseInvoicesResult> => ({
      invoices: [invoiceRecord],
      continuationPoints: { Subject2: "2025-01-31T00:00:00Z" },
      referenceNumbers: ["ref-1"],
    });

    const first = await syncPurchaseInvoices(
      db,
      fakeClient(),
      { windowFrom: "2025-01-01", windowTo: "2025-01-31" },
      { fetchInvoices },
    );
    const second = await syncPurchaseInvoices(
      db,
      fakeClient(),
      { windowFrom: "2025-01-01", windowTo: "2025-01-31" },
      { fetchInvoices },
    );

    const invoiceId = first.invoices[0]?.id;
    if (invoiceId === undefined) throw new Error("test setup bug: invoice not persisted");
    expect(await listInvoiceItems(db, invoiceId)).toHaveLength(2);
    expect(first.diagnostics.itemsInsertedCount).toBe(2);
    // Already extracted, so the second run skips it entirely rather than
    // rewriting the same rows.
    expect(second.diagnostics).toMatchObject({ itemsInsertedCount: 0, itemsFailedCount: 0 });

    sqlite.close();
  });

  it("keeps the invoice stored and counts the failure when item extraction fails", async () => {
    const { db, sqlite } = createDb(":memory:");
    await seedCategorizationRules(db);

    const fetchInvoices = async (): Promise<FetchPurchaseInvoicesResult> => ({
      invoices: [
        // Two lines claiming the same document position violates
        // invoice_items_invoice_ordinal_unique, so the whole item transaction
        // rolls back -- the closest stand-in for any item-write failure.
        record({ items: [item({ ordinal: 1 }), item({ ordinal: 1 })] }),
      ],
      continuationPoints: { Subject2: "2025-01-31T00:00:00Z" },
      referenceNumbers: ["ref-1"],
    });
    const warn = vi.fn();

    const result = await syncPurchaseInvoices(
      db,
      fakeClient(),
      { windowFrom: "2025-01-01", windowTo: "2025-01-31" },
      { fetchInvoices, logger: { info: vi.fn(), warn } },
    );

    // The import still succeeded: items are supplementary detail (§6.1).
    expect(result.diagnostics).toMatchObject({
      insertedCount: 1,
      itemsInsertedCount: 0,
      itemsFailedCount: 1,
    });
    const stored = await getInvoiceByKsefNumber(db, record().ksefNumber);
    expect(stored?.grossTotal).toBe(123.45);
    // NULL, so the backfill can retry it later without any KSeF call.
    expect(stored?.itemsExtractedAt).toBeNull();
    expect(stored ? await listInvoiceItems(db, stored.id) : null).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      "sync.items.failed",
      expect.objectContaining({ ksefNumber: record().ksefNumber, itemCount: 2 }),
    );

    sqlite.close();
  });

  it("retries extraction on the next sync after a failure, and succeeds", async () => {
    const { db, sqlite } = createDb(":memory:");
    await seedCategorizationRules(db);

    const failing = async (): Promise<FetchPurchaseInvoicesResult> => ({
      invoices: [record({ items: [item({ ordinal: 1 }), item({ ordinal: 1 })] })],
      continuationPoints: { Subject2: "2025-01-31T00:00:00Z" },
      referenceNumbers: ["ref-1"],
    });
    const succeeding = async (): Promise<FetchPurchaseInvoicesResult> => ({
      invoices: [record({ items: [item({ ordinal: 1 })] })],
      continuationPoints: { Subject2: "2025-01-31T00:00:00Z" },
      referenceNumbers: ["ref-1"],
    });

    const window = { windowFrom: "2025-01-01", windowTo: "2025-01-31" };
    await syncPurchaseInvoices(db, fakeClient(), window, { fetchInvoices: failing });
    const second = await syncPurchaseInvoices(db, fakeClient(), window, {
      fetchInvoices: succeeding,
    });

    expect(second.diagnostics).toMatchObject({
      duplicateCount: 1,
      itemsInsertedCount: 1,
      itemsFailedCount: 0,
    });

    sqlite.close();
  });

  it("treats an invoice with zero items as a successful extraction, not a failure", async () => {
    const { db, sqlite } = createDb(":memory:");
    await seedCategorizationRules(db);

    // FaWiersz is minOccurs=0 in FA(3) (advance invoices, some corrections).
    const fetchInvoices = async (): Promise<FetchPurchaseInvoicesResult> => ({
      invoices: [record({ items: [] })],
      continuationPoints: { Subject2: "2025-01-31T00:00:00Z" },
      referenceNumbers: ["ref-1"],
    });
    const warn = vi.fn();

    const result = await syncPurchaseInvoices(
      db,
      fakeClient(),
      { windowFrom: "2025-01-01", windowTo: "2025-01-31" },
      { fetchInvoices, logger: { info: vi.fn(), warn } },
    );

    expect(result.diagnostics).toMatchObject({ itemsInsertedCount: 0, itemsFailedCount: 0 });
    // Stamped: "extracted, genuinely empty" is not "never extracted" (§6.3).
    expect(
      (await getInvoiceByKsefNumber(db, record().ksefNumber))?.itemsExtractedAt,
    ).not.toBeNull();
    expect(warn).not.toHaveBeenCalledWith("sync.items.failed", expect.anything());

    sqlite.close();
  });

  it("reports the item stage through the injected logger", async () => {
    const { db, sqlite } = createDb(":memory:");
    await seedCategorizationRules(db);

    const fetchInvoices = async (): Promise<FetchPurchaseInvoicesResult> => ({
      invoices: [record({ items: [item({ ordinal: 1 }), item({ ordinal: 2, lineNumber: 2 })] })],
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

    expect(info).toHaveBeenCalledWith(
      "sync.items.started",
      expect.objectContaining({ pendingCount: 1, skippedCount: 0 }),
    );
    expect(info).toHaveBeenCalledWith(
      "sync.items.completed",
      expect.objectContaining({
        itemsInsertedCount: 2,
        itemsFailedCount: 0,
        extractedInvoiceCount: 1,
      }),
    );
    expect(info).toHaveBeenCalledWith(
      "sync.persist.completed",
      expect.objectContaining({ itemsInsertedCount: 2, itemsFailedCount: 0 }),
    );

    sqlite.close();
  });

  it("carries the item counters into the sync_runs audit row", async () => {
    const { db, sqlite } = createDb(":memory:");
    await seedCategorizationRules(db);

    const fetchInvoices = async (): Promise<FetchPurchaseInvoicesResult> => ({
      invoices: [
        record({ items: [item({ ordinal: 1 })] }),
        record({
          ksefNumber: "5265877635-2025-01-16-000002-00-XXXXXXXXXX",
          items: [item({ ordinal: 1 }), item({ ordinal: 1 })],
        }),
      ],
      continuationPoints: { Subject2: "2025-01-31T00:00:00Z" },
      referenceNumbers: ["ref-1"],
    });

    // Mirrors how POST /sync records a run around the sync call.
    const run = await createSyncRun(db, { windowFrom: "2025-01-01", windowTo: "2025-01-31" });
    const result = await syncPurchaseInvoices(
      db,
      fakeClient(),
      { windowFrom: "2025-01-01", windowTo: "2025-01-31" },
      { fetchInvoices },
    );
    const stored = await markSyncRunSuccess(db, run.id, {
      completedAt: new Date("2025-02-01T10:00:01.000Z"),
      durationMs: 1000,
      invoiceCount: result.invoices.length,
      hasMore: result.hasMore,
      ...result.diagnostics,
    });

    expect(stored.itemsInsertedCount).toBe(1);
    expect(stored.itemsFailedCount).toBe(1);

    sqlite.close();
  });

  it("defaults to purchase direction, querying Subject2 and persisting direction='purchase'", async () => {
    const { db, sqlite } = createDb(":memory:");
    await seedCategorizationRules(db);

    const fetchInvoices = vi.fn(
      async (): Promise<FetchPurchaseInvoicesResult> => ({
        invoices: [record()],
        continuationPoints: { Subject2: "2025-01-31T00:00:00Z" },
        referenceNumbers: ["ref-1"],
      }),
    );

    const result = await syncPurchaseInvoices(
      db,
      fakeClient(),
      { windowFrom: "2025-01-01", windowTo: "2025-01-31" },
      { fetchInvoices },
    );

    expect(fetchInvoices).toHaveBeenCalledWith(
      fakeClient(),
      expect.objectContaining({ subjectType: "Subject2" }),
    );
    expect(result.invoices[0]?.direction).toBe("purchase");

    sqlite.close();
  });

  it("requests Subject1 for direction='sales' and bypasses categorization entirely", async () => {
    const { db, sqlite } = createDb(":memory:");
    await seedCategorizationRules(db);

    const fetchInvoices = vi.fn(
      async (): Promise<FetchPurchaseInvoicesResult> => ({
        invoices: [record()],
        continuationPoints: { Subject1: "2025-01-31T00:00:00Z" },
        referenceNumbers: ["ref-1"],
      }),
    );

    const result = await syncPurchaseInvoices(
      db,
      fakeClient(),
      { windowFrom: "2025-01-01", windowTo: "2025-01-31", direction: "sales" },
      { fetchInvoices },
    );

    expect(fetchInvoices).toHaveBeenCalledWith(
      fakeClient(),
      expect.objectContaining({ subjectType: "Subject1" }),
    );
    expect(result.invoices[0]?.direction).toBe("sales");
    expect(result.invoices[0]?.categorizationConfidence).toBe("not_applicable");
    expect(result.invoices[0]?.categoryId).toBeNull();
    expect(result.diagnostics.categorizedCount).toBe(0);
    expect(result.diagnostics.needsReviewCount).toBe(0);

    sqlite.close();
  });

  it("keeps purchase and sales continuation points independent in sync_state", async () => {
    const { db, sqlite } = createDb(":memory:");
    await seedCategorizationRules(db);

    const fetchPurchases = async (): Promise<FetchPurchaseInvoicesResult> => ({
      invoices: [],
      continuationPoints: { Subject2: "2025-01-31T00:00:00Z" },
      referenceNumbers: [],
    });
    const fetchSales = async (): Promise<FetchPurchaseInvoicesResult> => ({
      invoices: [],
      continuationPoints: { Subject1: "2025-01-20T00:00:00Z" },
      referenceNumbers: [],
    });

    await syncPurchaseInvoices(
      db,
      fakeClient(),
      { windowFrom: "2025-01-01", windowTo: "2025-01-31" },
      { fetchInvoices: fetchPurchases },
    );
    await syncPurchaseInvoices(
      db,
      fakeClient(),
      { windowFrom: "2025-01-01", windowTo: "2025-01-31", direction: "sales" },
      { fetchInvoices: fetchSales },
    );

    expect(await getContinuationPoint(db, "Subject2")).toBe("2025-01-31T00:00:00Z");
    expect(await getContinuationPoint(db, "Subject1")).toBe("2025-01-20T00:00:00Z");

    sqlite.close();
  });
});
