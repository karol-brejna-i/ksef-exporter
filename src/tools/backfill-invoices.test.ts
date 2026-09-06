import type { KsefClient } from "ksef-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../db/client.js";
import { createDb } from "../db/client.js";
import type { SyncPurchaseInvoicesResult, syncPurchaseInvoices } from "../sync.js";
import { backfillDirection } from "./backfill-invoices.js";

/**
 * `backfillDirection`'s injectable-seam tests
 * (design/KSEF_PAGINATION_AND_HASMORE.md §7.3). The real KSeF client is never
 * touched -- every scenario below injects a fake `syncPurchaseInvoices` via
 * `deps.sync`, and a no-op `deps.sleep` so the 3s inter-call delay doesn't
 * slow the suite down. The `db` is a real ephemeral SQLite instance (matches
 * this repo's convention in `src/db/invoices.test.ts` / `src/api/server.test.ts`)
 * since `backfillDirection` also exercises `createSyncRun`/`markSyncRunSuccess`
 * against it on every call.
 */

function diagnostics(
  overrides: Partial<SyncPurchaseInvoicesResult["diagnostics"]> = {},
): SyncPurchaseInvoicesResult["diagnostics"] {
  return {
    continuationBefore: null,
    continuationAfter: null,
    fetchedCount: 0,
    insertedCount: 0,
    duplicateCount: 0,
    categorizedCount: 0,
    needsReviewCount: 0,
    itemsInsertedCount: 0,
    itemsFailedCount: 0,
    maxIterations: 1,
    isTruncated: null,
    ...overrides,
  };
}

function syncResult(input: { hasMore: boolean; fetchedCount: number }): SyncPurchaseInvoicesResult {
  return {
    invoices: [],
    hasMore: input.hasMore,
    hasMoreReason: input.hasMore ? "truncated" : null,
    diagnostics: diagnostics({ fetchedCount: input.fetchedCount }),
  };
}

/** A fake `syncPurchaseInvoices` that returns each queued result in order,
 * repeating the last one if called more times than results were queued. */
function makeSync(results: [SyncPurchaseInvoicesResult, ...SyncPurchaseInvoicesResult[]]) {
  let call = 0;
  return vi.fn<typeof syncPurchaseInvoices>(async (..._args) => {
    const next = results[Math.min(call, results.length - 1)] ?? results[0];
    call++;
    return next as SyncPurchaseInvoicesResult;
  });
}

const noopSleep = async () => {};
// The real client is never dereferenced: every test injects `deps.sync`, so
// `backfillDirection` never calls the real `syncPurchaseInvoices` that would
// need a real `KsefClient` shape.
const fakeClient = {} as KsefClient;

describe("backfillDirection", () => {
  let db: Db;
  let close: () => void;

  beforeEach(() => {
    const opened = createDb(":memory:");
    db = opened.db;
    close = () => opened.sqlite.close();
  });

  afterEach(() => close());

  it("stops when hasMore becomes false (happy path)", async () => {
    const sync = makeSync([
      syncResult({ hasMore: true, fetchedCount: 5 }),
      syncResult({ hasMore: false, fetchedCount: 5 }),
    ]);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const ok = await backfillDirection(db, fakeClient, "purchase", "2025-01-01", "2025-01-31", {
        sync,
        sleep: noopSleep,
      });
      expect(ok).toBe(true);
      expect(sync).toHaveBeenCalledTimes(2);
      // The second call's fixture has hasMore: false, which syncResult() maps
      // to hasMoreReason: null -- confirms the per-call log line falls back to
      // "unknown" for a legitimate null rather than printing the literal
      // string "null".
      expect(
        logSpy.mock.calls.some((args) =>
          args.some((arg) => typeof arg === "string" && arg.includes("hasMoreReason=unknown")),
        ),
      ).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("passes each call's own sync_runs id through to sync() as syncRunId", async () => {
    // Regression: a live smoke test against parkowa (2026-09-06) found that
    // backfillDirection created a sync_runs row per call but never actually
    // passed its id to sync() -- inserted invoices silently kept sync_run_id
    // NULL. This asserts the exact argument, not just that sync() was called.
    const sync = makeSync([
      syncResult({ hasMore: true, fetchedCount: 1 }),
      syncResult({ hasMore: false, fetchedCount: 1 }),
    ]);
    const ok = await backfillDirection(db, fakeClient, "purchase", "2025-01-01", "2025-01-31", {
      sync,
      sleep: noopSleep,
    });
    expect(ok).toBe(true);
    expect(sync).toHaveBeenCalledTimes(2);
    const firstCallSyncRunId = sync.mock.calls[0]?.[2]?.syncRunId;
    const secondCallSyncRunId = sync.mock.calls[1]?.[2]?.syncRunId;
    expect(typeof firstCallSyncRunId).toBe("number");
    expect(typeof secondCallSyncRunId).toBe("number");
    // Each call creates its own sync_runs row, so each must carry a distinct id.
    expect(secondCallSyncRunId).not.toBe(firstCallSyncRunId);
  });

  it("stops at maxCalls when hasMore never goes false", async () => {
    const sync = vi.fn(async () => syncResult({ hasMore: true, fetchedCount: 5 }));
    const ok = await backfillDirection(db, fakeClient, "purchase", "2025-01-01", "2025-01-31", {
      sync,
      sleep: noopSleep,
      maxCalls: 4,
      // Non-empty fetches every call, so the circuit breaker must never be
      // the thing that stops this loop -- only the maxCalls cap should.
      maxConsecutiveEmpty: 100,
    });
    expect(ok).toBe(true);
    expect(sync).toHaveBeenCalledTimes(4);
  });

  it("trips the circuit breaker after exactly maxConsecutiveEmpty zero-fetch calls, well before maxCalls", async () => {
    // This is the regression this investigation is about: hasMore stays true
    // forever on fetchedCount: 0, exactly the production incident in
    // design/KSEF_PAGINATION_AND_HASMORE.md §3.
    const sync = vi.fn(async () => syncResult({ hasMore: true, fetchedCount: 0 }));
    const ok = await backfillDirection(db, fakeClient, "purchase", "2025-01-01", "2025-01-31", {
      sync,
      sleep: noopSleep,
      maxCalls: 15,
      maxConsecutiveEmpty: 3,
    });
    expect(ok).toBe(true);
    // Exactly 3, not fewer (asserts the breaker doesn't false-trip on 1 or 2
    // empty calls) and not 15 (asserts it stops well short of the maxCalls
    // cap instead of burning the whole budget).
    expect(sync).toHaveBeenCalledTimes(3);
  });

  it("does not trip the breaker after only one or two consecutive empty calls", async () => {
    // Two empty calls followed by hasMore: false -- must reach the genuine
    // "done" exit, not the breaker, since the breaker threshold (3) was
    // never reached.
    const sync = makeSync([
      syncResult({ hasMore: true, fetchedCount: 0 }),
      syncResult({ hasMore: true, fetchedCount: 0 }),
      syncResult({ hasMore: false, fetchedCount: 0 }),
    ]);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ok = await backfillDirection(db, fakeClient, "purchase", "2025-01-01", "2025-01-31", {
        sync,
        sleep: noopSleep,
        maxCalls: 15,
        maxConsecutiveEmpty: 3,
      });
      expect(ok).toBe(true);
      expect(sync).toHaveBeenCalledTimes(3);
      // No breaker warning should have fired -- the loop ended via hasMore
      // becoming false, not via the circuit breaker.
      expect(
        warnSpy.mock.calls.some((args) =>
          args.some((arg) => typeof arg === "string" && arg.includes("circuit breaker")),
        ),
      ).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("resets the consecutive-empty counter after a call that fetches something", async () => {
    const sync = makeSync([
      syncResult({ hasMore: true, fetchedCount: 0 }),
      syncResult({ hasMore: true, fetchedCount: 0 }),
      // A real page of data resets the counter -- two prior empty calls must
      // not count toward the breaker threshold anymore.
      syncResult({ hasMore: true, fetchedCount: 7 }),
      syncResult({ hasMore: true, fetchedCount: 0 }),
      syncResult({ hasMore: true, fetchedCount: 0 }),
      // This is the 3rd consecutive empty call *since the reset* -- trips
      // the breaker here, at call 6, not call 3.
      syncResult({ hasMore: true, fetchedCount: 0 }),
    ]);
    const ok = await backfillDirection(db, fakeClient, "purchase", "2025-01-01", "2025-01-31", {
      sync,
      sleep: noopSleep,
      maxCalls: 15,
      maxConsecutiveEmpty: 3,
    });
    expect(ok).toBe(true);
    expect(sync).toHaveBeenCalledTimes(6);
  });
});
