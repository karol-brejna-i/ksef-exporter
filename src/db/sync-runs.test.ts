import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./client.js";
import { createDb } from "./client.js";
import {
  createSyncRun,
  listRecentSyncRuns,
  markSyncRunError,
  markSyncRunSuccess,
} from "./sync-runs.js";

describe("sync-runs repository", () => {
  let db: Db;
  let close: () => void;

  beforeEach(() => {
    const opened = createDb(":memory:");
    db = opened.db;
    close = () => opened.sqlite.close();
  });

  afterEach(() => close());

  it("creates a run in 'running' status", async () => {
    const startedAt = new Date("2025-02-01T10:00:00.000Z");
    const run = await createSyncRun(db, {
      windowFrom: "2025-01-01",
      windowTo: "2025-01-31",
      startedAt,
      continuationBefore: "2025-01-15T00:00:00.000Z",
      maxIterations: 1,
    });

    expect(run.status).toBe("running");
    expect(run.windowFrom).toBe("2025-01-01");
    expect(run.windowTo).toBe("2025-01-31");
    expect(run.invoiceCount).toBeNull();
    expect(run.errorMessage).toBeNull();
    expect(run.startedAt).toEqual(startedAt);
    expect(run.continuationBefore).toBe("2025-01-15T00:00:00.000Z");
    expect(run.maxIterations).toBe(1);
  });

  it("marks a run as successful with an invoice count", async () => {
    const run = await createSyncRun(db, { windowFrom: "2025-01-01", windowTo: "2025-01-31" });

    const completedAt = new Date("2025-02-01T10:00:02.500Z");
    const updated = await markSyncRunSuccess(db, run.id, {
      completedAt,
      durationMs: 2500,
      invoiceCount: 12,
      continuationAfter: "2025-01-31T00:00:00.000Z",
      fetchedCount: 12,
      insertedCount: 10,
      duplicateCount: 2,
      categorizedCount: 8,
      needsReviewCount: 4,
      itemsInsertedCount: 96,
      itemsFailedCount: 1,
      hasMore: false,
    });

    expect(updated.status).toBe("success");
    expect(updated.invoiceCount).toBe(12);
    expect(updated.errorMessage).toBeNull();
    expect(updated.durationMs).toBe(2500);
    expect(updated.completedAt).toEqual(completedAt);
    expect(updated.insertedCount).toBe(10);
    expect(updated.duplicateCount).toBe(2);
    expect(updated.hasMore).toBe(false);
    expect(updated.itemsInsertedCount).toBe(96);
    expect(updated.itemsFailedCount).toBe(1);
  });

  it("records zero line-item counters distinctly from the NULL of an unrecorded run", async () => {
    const run = await createSyncRun(db, { windowFrom: "2025-01-01", windowTo: "2025-01-31" });

    // A "running" row has never had an extraction result recorded...
    expect(run.itemsInsertedCount).toBeNull();
    expect(run.itemsFailedCount).toBeNull();

    // ...whereas a successful run that found nothing to extract stores 0, which
    // is what lets the UI tell "no items" from "predates this feature" (§6.3).
    const completedAt = new Date("2025-02-01T10:00:01.000Z");
    const updated = await markSyncRunSuccess(db, run.id, {
      completedAt,
      durationMs: 1000,
      invoiceCount: 0,
      continuationAfter: null,
      fetchedCount: 0,
      insertedCount: 0,
      duplicateCount: 0,
      categorizedCount: 0,
      needsReviewCount: 0,
      itemsInsertedCount: 0,
      itemsFailedCount: 0,
      hasMore: false,
    });

    expect(updated.itemsInsertedCount).toBe(0);
    expect(updated.itemsFailedCount).toBe(0);
    expect(updated.completedAt).toEqual(completedAt);
  });

  it("marks a run as failed with an error message", async () => {
    const run = await createSyncRun(db, { windowFrom: "2025-01-01", windowTo: "2025-01-31" });

    const completedAt = new Date("2025-02-01T10:00:01.000Z");
    const updated = await markSyncRunError(db, run.id, {
      completedAt,
      durationMs: 1000,
      errorMessage: "rate limited, retry after 52m",
      errorType: "KsefRateLimitError",
      httpStatus: 429,
      retryAfterSeconds: 3120,
    });

    expect(updated.status).toBe("error");
    expect(updated.errorMessage).toBe("rate limited, retry after 52m");
    expect(updated.completedAt).toEqual(completedAt);
    expect(updated.invoiceCount).toBeNull();
    expect(updated.errorType).toBe("KsefRateLimitError");
    expect(updated.httpStatus).toBe(429);
    expect(updated.retryAfterSeconds).toBe(3120);
  });

  it("throws when marking a non-existent run", async () => {
    await expect(
      markSyncRunSuccess(db, 999, {
        completedAt: new Date("2025-02-01T10:00:00.000Z"),
        durationMs: 1,
        invoiceCount: 1,
        continuationAfter: null,
        fetchedCount: 1,
        insertedCount: 1,
        duplicateCount: 0,
        categorizedCount: 0,
        needsReviewCount: 1,
        itemsInsertedCount: 0,
        itemsFailedCount: 0,
        hasMore: false,
      }),
    ).rejects.toThrow();
    await expect(
      markSyncRunError(db, 999, {
        completedAt: new Date("2025-02-01T10:00:00.000Z"),
        durationMs: 1,
        errorMessage: "boom",
        errorType: "Error",
      }),
    ).rejects.toThrow();
  });

  it("lists recent runs newest-first, capped at the given limit", async () => {
    for (let i = 0; i < 3; i++) {
      await createSyncRun(db, { windowFrom: `2025-0${i + 1}-01`, windowTo: `2025-0${i + 1}-28` });
    }

    const runs = await listRecentSyncRuns(db, 2);

    expect(runs).toHaveLength(2);
    expect(runs[0]?.windowFrom).toBe("2025-03-01");
    expect(runs[1]?.windowFrom).toBe("2025-02-01");
  });

  it("requestedAt is a Date instance with millisecond precision in the valid epoch range", async () => {
    const run = await createSyncRun(db, {
      windowFrom: "2025-01-01",
      windowTo: "2025-01-31",
    });

    expect(run.requestedAt).toBeInstanceOf(Date);
    const epochMs = run.requestedAt.getTime();
    expect(epochMs).toBeGreaterThanOrEqual(946684800000); // 2000-01-01
    expect(epochMs).toBeLessThanOrEqual(4102444800000); // 2100-01-01
    // Pins milliseconds, not seconds: this value should be 13 digits, not 10
    expect(epochMs.toString().length).toBe(13);
  });

  it("inserting a sync_runs row without specifying requestedAt still populates it", async () => {
    // createSyncRun omits requestedAt from the input
    const run = await createSyncRun(db, {
      windowFrom: "2025-01-01",
      windowTo: "2025-01-31",
    });

    // The application-side default should have populated it
    expect(run.requestedAt).toBeInstanceOf(Date);
    expect(run.requestedAt.getTime()).toBeGreaterThan(0);
  });
});
