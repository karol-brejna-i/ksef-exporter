import type { ContinuationPoints, KsefClient } from "ksef-client";
import { categorize } from "./categorization/engine.js";
import type { Db } from "./db/client.js";
import { replaceInvoiceItems } from "./db/invoice-items.js";
import {
  getInvoiceByKsefNumber,
  type InvoiceDirection,
  type InvoiceRow,
  insertKsefInvoiceIfNotExists,
  updateInvoiceCategory,
} from "./db/invoices.js";
import { listRules } from "./db/rules.js";
import { getContinuationPoint, setContinuationPoint } from "./db/sync-state.js";
import type { InvoiceItemRecord } from "./ksef/invoice-parser.js";
import { fetchPurchaseInvoices } from "./ksef/invoices.js";
import {
  assertIsoDate,
  continuationPointToEpochMs,
  dateEndExclusiveMs,
  dateStartMs,
} from "./time.js";

/** KSeF subject type per direction (see design/SALES_INVOICES_PLAN.md §4). */
export const SUBJECT_TYPE_BY_DIRECTION: Record<InvoiceDirection, "Subject1" | "Subject2"> = {
  purchase: "Subject2",
  sales: "Subject1",
};

export interface SyncPurchaseInvoicesOptions {
  windowFrom: string;
  windowTo: string;
  /**
   * How many KSeF export packages ("pages") to fetch in this call. Defaults
   * to **1**, not the SDK's own default of 20: KSeF's `POST /invoices/exports`
   * only allows 16 req/min / 20 req/h per subject type (see
   * https://github.com/CIRFMF/ksef-api/blob/main/limity/limity-api.md), and
   * the incremental-fetch workflow can burn through that whole hourly budget
   * within seconds if it needs many pages for a wide window. One page per
   * call keeps each `/sync` well under the limit; if `hasMore` comes back
   * true, call sync again to continue from the persisted continuation point.
   */
  maxIterations?: number;
  /**
   * "purchase" (Subject2) or "sales" (Subject1). Defaults to "purchase" --
   * unchanged behavior for existing callers. Each call syncs exactly one
   * direction, keyed to its own continuation point in `sync_state`.
   */
  direction?: InvoiceDirection;
  /**
   * The `sync_runs` row this call is part of, threaded onto every invoice it
   * inserts (design/KSEF_PAGINATION_AND_HASMORE.md §7.4). Omitted by callers
   * that don't yet track one; left null on those rows rather than guessed.
   */
  syncRunId?: number;
}

/**
 * Why `syncPurchaseInvoices` did or didn't report `hasMore` (see the JSDoc on
 * `SyncPurchaseInvoicesResult.hasMore` for the decision itself). These three
 * exact string values are committed into `sync_runs.has_more_reason`'s CHECK
 * constraint (`drizzle/migrations/0012_stale_khan.sql`) -- do not add, rename,
 * or remove a value here without a migration to match.
 */
export type HasMoreReason = "truncated" | "window_exhausted" | "stalled";

export interface SyncPurchaseInvoicesResult {
  invoices: InvoiceRow[];
  diagnostics: SyncDiagnostics;
  /**
   * Driven directly by KSeF's own `isTruncated` signal on the fetched package
   * (`FetchPurchaseInvoicesResult.isTruncated`), not reconstructed from a bare
   * timestamp (design/KSEF_PAGINATION_AND_HASMORE.md documents why the old
   * timestamp heuristic over-reported in production, burning export-init
   * quota on empty pages).
   *
   * - `isTruncated === true` -- KSeF is telling us directly there is more data
   *   in this window right now, so `hasMore` is true unless the resulting
   *   continuation point has already reached/passed the effective window end
   *   (`min(windowTo's exclusive end, now())`), in which case that data lies
   *   outside the requested window and there is nothing more for *this* call.
   * - `isTruncated === false` -- the page covers everything available right
   *   now. `hasMore` is always false, but which of `hasMoreReason`'s two
   *   remaining values applies depends on whether the continuation point
   *   reached the effective window end (genuinely done: `"window_exhausted"`)
   *   or not (KSeF's own high-water mark just hasn't scanned that far yet,
   *   typically because `windowTo` is today or later: `"stalled"`).
   * - `isTruncated === undefined` -- the signal genuinely wasn't populated
   *   (an older test fake, or a package with no data at all). Fails closed:
   *   `hasMore` is false and `hasMoreReason` is `null`. Never guess `true`
   *   when the signal is missing -- a caller that still needs another page
   *   gets it on the next sync once the signal is present; defaulting to
   *   `false` can at worst cost a one-call delay, never a wasted export-init
   *   call.
   */
  hasMore: boolean;
  /** See `hasMore`'s JSDoc. `null` only when `isTruncated` was undefined. */
  hasMoreReason: HasMoreReason | null;
}

export interface SyncDiagnostics {
  continuationBefore: string | null;
  continuationAfter: string | null;
  fetchedCount: number;
  insertedCount: number;
  duplicateCount: number;
  categorizedCount: number;
  needsReviewCount: number;
  /** Line items written across the run (see design/INVOICE_ITEMS_PLAN.md §5 Step 4). */
  itemsInsertedCount: number;
  /**
   * Invoices whose line-item extraction failed. The invoices themselves are
   * still stored and still counted in `insertedCount`: items are supplementary
   * detail and never fail an import (§6.1).
   */
  itemsFailedCount: number;
  maxIterations: number;
  /**
   * KSeF's raw `isTruncated` signal for the fetched package, before the
   * window-end bound is applied. Kept alongside `hasMoreReason` (not implied
   * by it) because the one case they diverge in is exactly the one worth
   * being able to tell apart later: `isTruncated: true` with the window
   * already exhausted still yields `hasMoreReason: "window_exhausted"`. Null
   * when the signal genuinely wasn't populated (see `hasMore`'s JSDoc).
   */
  isTruncated: boolean | null;
}

/**
 * Minimal logging interface (satisfied by both Fastify's `request.log` and
 * plain `console`) so callers can see sync progress -- there's otherwise no
 * feedback while the KSeF export/poll/download cycle runs, which can take
 * a while and gives no indication anything is happening.
 */
export interface SyncLogger {
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn?: (message: string, meta?: Record<string, unknown>) => void;
}

const noopLogger: SyncLogger = { info: () => {} };

/**
 * Continuation points are opaque KSeF tokens, so an unrecognised shape must not
 * abort a sync that has already persisted invoices; the caller treats `null` as
 * "cannot reason about this one" and falls back to the requested window.
 */
function continuationPointMs(point: string | null, logger: SyncLogger): number | null {
  if (point === null) return null;
  try {
    return continuationPointToEpochMs(point);
  } catch {
    logger.warn?.("sync.continuation.unparseable", { continuationPoint: point });
    return null;
  }
}

/** Picks the chronologically later point. Never compare these as strings: an
 * offset of `+02:00` sorts above `+00:00` yet is two hours earlier. */
function laterContinuationPoint(
  a: string | null,
  b: string | null,
  logger: SyncLogger,
): string | null {
  if (a === null) return b;
  if (b === null) return a;

  const aMs = continuationPointMs(a, logger);
  const bMs = continuationPointMs(b, logger);
  if (aMs === null) return b;
  if (bMs === null) return a;

  return aMs >= bMs ? a : b;
}

export interface SyncPurchaseInvoicesDeps {
  /** Injectable for tests; defaults to the real `fetchPurchaseInvoices`. */
  fetchInvoices?: typeof fetchPurchaseInvoices;
  /** Injectable for tests; defaults to a no-op logger. */
  logger?: SyncLogger;
  /** Injectable monotonic-enough clock for stage-duration tests. */
  now?: () => number;
}

/**
 * The end-to-end engine flow (SPEC "the engine"): pulls new purchase
 * invoices from KSeF since the last sync (Phase 2), persists them
 * idempotently (Phase 3), then runs each newly-inserted, never-touched
 * invoice through the Tier-1 categorization engine (Phase 4) and persists
 * the result. Invoices that already have a category (from a previous sync
 * or a human correction) are never re-categorized here, so this is always
 * safe to re-run.
 *
 * Line items are derived from the same already-parsed records in a separate
 * stage afterwards (design/INVOICE_ITEMS_PLAN.md §5 Step 4), on the same
 * "never clobber prior work" terms: only invoices with no recorded extraction
 * are touched, and an item failure never fails the invoice.
 */
export async function syncPurchaseInvoices(
  db: Db,
  client: Pick<KsefClient, "workflows">,
  options: SyncPurchaseInvoicesOptions,
  deps: SyncPurchaseInvoicesDeps = {},
): Promise<SyncPurchaseInvoicesResult> {
  const fetchInvoices = deps.fetchInvoices ?? fetchPurchaseInvoices;
  const logger = deps.logger ?? noopLogger;
  const now = deps.now ?? Date.now;
  const maxIterations = options.maxIterations ?? 1;
  const direction = options.direction ?? "purchase";
  const subjectType = SUBJECT_TYPE_BY_DIRECTION[direction];

  const storedContinuationPoint = await getContinuationPoint(db, subjectType);
  // The SDK queries `from: continuationPoint ?? windowFrom`, so the stored point
  // is only applied when it lies inside the requested window. A point past
  // windowTo (backfilling an earlier period) would build an invalid `from > to`
  // range and be rejected before any request is sent; a point before windowFrom
  // is stale for this window and must not silently expand the fetch into a
  // range the caller did not request.
  //
  // The bounds are civil dates and the stored point is an instant, so the
  // comparison is made numerically and against the *exclusive* start of the day
  // after windowTo -- a lexicographic `<= windowTo` discards every point on the
  // window's final day.
  const windowFromMs = dateStartMs(assertIsoDate(options.windowFrom));
  const windowEndExclusiveMs = dateEndExclusiveMs(assertIsoDate(options.windowTo));
  const storedContinuationMs = continuationPointMs(storedContinuationPoint ?? null, logger);
  const appliedContinuationPoint =
    storedContinuationPoint != null &&
    storedContinuationMs !== null &&
    storedContinuationMs >= windowFromMs &&
    storedContinuationMs < windowEndExclusiveMs
      ? storedContinuationPoint
      : null;
  const continuationPoints: ContinuationPoints =
    appliedContinuationPoint != null ? { [subjectType]: appliedContinuationPoint } : {};
  const effectiveFrom = appliedContinuationPoint ?? options.windowFrom;

  if (storedContinuationPoint != null && appliedContinuationPoint === null) {
    logger.warn?.("sync.continuation.conflict", {
      windowFrom: options.windowFrom,
      windowTo: options.windowTo,
      continuationBefore: storedContinuationPoint,
      effectiveFrom,
    });
  }

  logger.info("sync.fetch.started", {
    windowFrom: options.windowFrom,
    windowTo: options.windowTo,
    continuationBefore: storedContinuationPoint ?? null,
    effectiveFrom,
    continuationApplied: appliedContinuationPoint !== null,
    // True when the continuation point starts the query later than requested,
    // i.e. invoices in [windowFrom, effectiveFrom) are deliberately not fetched.
    windowStartSkipped:
      storedContinuationMs !== null &&
      appliedContinuationPoint !== null &&
      storedContinuationMs > windowFromMs,
    maxIterations,
  });
  const fetchStartedAt = now();
  const fetchResult = await fetchInvoices(client, {
    windowFrom: options.windowFrom,
    windowTo: options.windowTo,
    continuationPoints,
    subjectType,
    maxIterations,
  });
  logger.info("sync.fetch.completed", {
    durationMs: now() - fetchStartedAt,
    fetchedCount: fetchResult.invoices.length,
    referenceCount: fetchResult.referenceNumbers.length,
    continuationAfterFetch: fetchResult.continuationPoints[subjectType] ?? null,
  });

  logger.info("sync.persist.started", { fetchedCount: fetchResult.invoices.length });
  const persistStartedAt = now();
  const rules = await listRules(db);
  const invoices: InvoiceRow[] = [];
  /**
   * Invoices whose line items still have to be derived, collected here and
   * written in the separate items stage below so item persistence can never
   * interleave with (or interfere with) invoice persistence.
   */
  const itemsPending: { row: InvoiceRow; items: InvoiceItemRecord[] }[] = [];
  let insertedCount = 0;
  let duplicateCount = 0;
  let categorizedCount = 0;
  for (const invoice of fetchResult.invoices) {
    const existing = await getInvoiceByKsefNumber(db, invoice.ksefNumber);
    const row = await insertKsefInvoiceIfNotExists(db, {
      ...invoice,
      direction,
      syncRunId: options.syncRunId ?? null,
      // Sales invoices bypass categorization entirely (design/SALES_INVOICES_PLAN.md
      // §4.2): without this, every one would land in the owner's review queue.
      ...(direction === "sales" ? { categorizationConfidence: "not_applicable" as const } : {}),
    });
    if (existing) {
      duplicateCount++;
      logger.info("sync.persist.duplicate", {
        ksefNumber: invoice.ksefNumber,
        invoiceNumber: invoice.invoiceNumber,
      });
    } else {
      insertedCount++;
      logger.info("sync.persist.inserted", {
        ksefNumber: invoice.ksefNumber,
        invoiceNumber: invoice.invoiceNumber,
      });
    }

    // A newly inserted row always has items_extracted_at NULL, and a re-synced
    // one is only re-derived when no previous attempt ever recorded a result --
    // so this single check covers both cases. Invoices already extracted are
    // skipped, which keeps re-running a window cheap and idempotent, the same
    // "never clobber prior work" rule categorization follows below. NULL also
    // means a failed extraction stays retryable by `backfill:items` without
    // touching KSeF (design/INVOICE_ITEMS_PLAN.md §6.1/§6.3).
    if (row.itemsExtractedAt === null) {
      itemsPending.push({ row, items: invoice.items });
    }

    if (direction === "sales") {
      invoices.push(row);
      continue;
    }

    const isUncategorized =
      row.categoryId === null && row.categorizationConfidence === "needs_review";
    if (!isUncategorized) {
      invoices.push(row);
      continue;
    }

    const result = categorize(row, rules);
    if (result.categoryId === null) {
      invoices.push(row);
      continue;
    }
    categorizedCount++;
    invoices.push(await updateInvoiceCategory(db, row.id, result.categoryId, result.confidence));
  }

  // Snapshotted before the items stage so the persist duration keeps measuring
  // invoice persistence only, even though `sync.persist.completed` is emitted
  // last (it carries the full diagnostics, item counters included).
  const persistDurationMs = now() - persistStartedAt;

  logger.info("sync.items.started", {
    // Invoices about to have their items derived, and those whose items an
    // earlier run already recorded (skipped entirely, no re-parse, no writes).
    pendingCount: itemsPending.length,
    skippedCount: fetchResult.invoices.length - itemsPending.length,
  });
  const itemsStartedAt = now();
  let itemsInsertedCount = 0;
  let itemsFailedCount = 0;
  for (const pending of itemsPending) {
    try {
      // Not awaited on purpose: drizzle's better-sqlite3 transaction is
      // synchronous, so replaceInvoiceItems returns void, not a Promise.
      // It deletes, re-inserts, and stamps items_extracted_at in one
      // transaction, so zero items is a recorded success (§6.3).
      replaceInvoiceItems(
        db,
        pending.row.id,
        pending.items.map((item) => ({ invoiceId: pending.row.id, ...item })),
      );
      itemsInsertedCount += pending.items.length;
    } catch (error) {
      // §6.1: items are supplementary detail, so an extraction failure must
      // never fail the invoice import. The invoice stays stored, its
      // items_extracted_at stays NULL (the transaction rolled back), and the
      // backfill can retry it later without any KSeF call.
      itemsFailedCount++;
      logger.warn?.("sync.items.failed", {
        ksefNumber: pending.row.ksefNumber,
        invoiceId: pending.row.id,
        itemCount: pending.items.length,
        errorType: error instanceof Error ? error.name : typeof error,
        // Message only -- never raw invoice XML or an SDK response body.
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }
  logger.info("sync.items.completed", {
    durationMs: now() - itemsStartedAt,
    itemsInsertedCount,
    itemsFailedCount,
    extractedInvoiceCount: itemsPending.length - itemsFailedCount,
  });

  const newContinuationPoint = fetchResult.continuationPoints[subjectType];
  // Monotonic: a backfill of an earlier period must not rewind the high-water
  // mark, or the next incremental sync re-downloads everything since then and
  // burns the tight export-init quota.
  const persistedContinuationPoint = laterContinuationPoint(
    storedContinuationPoint ?? null,
    newContinuationPoint ?? null,
    logger,
  );
  await setContinuationPoint(db, subjectType, persistedContinuationPoint);
  const newContinuationMs = continuationPointMs(newContinuationPoint ?? null, logger);
  // When windowTo is today or later, KSeF has no future invoices to report and
  // its own high-water mark advances to roughly "now" instead -- comparing
  // only against windowTo would then report hasMore forever, since "now" keeps
  // creeping forward on every poll but never reaches a windowTo that hasn't
  // happened yet. Capping the comparison at "now" too means "reached the
  // window end" correctly means "covered everything requestable right now",
  // not "covered everything once windowTo actually arrives".
  const effectiveWindowEndMs = Math.min(windowEndExclusiveMs, now());
  // Whether the continuation point KSeF just returned has already covered the
  // requested window. `newContinuationMs === null` (no point returned at all)
  // can't be proven to have reached anything, so it reads as "not reached".
  const reachedEffectiveWindowEnd =
    newContinuationMs !== null && newContinuationMs >= effectiveWindowEndMs;
  // design/KSEF_PAGINATION_AND_HASMORE.md §7.2: drive hasMore off KSeF's own
  // isTruncated signal instead of reconstructing intent from a bare timestamp
  // (the old madeProgress/effectiveWindowEndMs-only heuristic this replaces
  // was defeated in production by ordinary round-trip clock drift -- see the
  // design doc's §2.3/§3 for the empirical measurements). The AND against
  // effectiveWindowEndMs when isTruncated is true is mathematically redundant
  // per hwmCoordinator.ts's updateContinuationPoint (a truncated result's
  // continuation point is pinned to lastPermanentStorageDate, the date of the
  // last invoice actually included in a package built for this window, which
  // can never exceed that window's end) but is kept anyway as cheap defensive
  // insurance against that invariant ever changing upstream.
  const hasMore = fetchResult.isTruncated === true && !reachedEffectiveWindowEnd;
  const hasMoreReason: HasMoreReason | null =
    fetchResult.isTruncated === undefined
      ? null
      : fetchResult.isTruncated
        ? hasMore
          ? "truncated"
          : "window_exhausted"
        : reachedEffectiveWindowEnd
          ? "window_exhausted"
          : "stalled";
  const needsReviewCount = invoices.filter(
    (invoice) => invoice.categorizationConfidence === "needs_review",
  ).length;
  const diagnostics: SyncDiagnostics = {
    continuationBefore: storedContinuationPoint ?? null,
    continuationAfter: persistedContinuationPoint,
    fetchedCount: fetchResult.invoices.length,
    insertedCount,
    duplicateCount,
    categorizedCount,
    needsReviewCount,
    itemsInsertedCount,
    itemsFailedCount,
    maxIterations,
    isTruncated: fetchResult.isTruncated ?? null,
  };
  logger.info("sync.persist.completed", {
    durationMs: persistDurationMs,
    ...diagnostics,
    hasMore,
    hasMoreReason,
  });

  return { invoices, hasMore, hasMoreReason, diagnostics };
}
