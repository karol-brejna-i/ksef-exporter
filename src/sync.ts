import type { ContinuationPoints, KsefClient } from "ksef-client";
import { categorize } from "./categorization/engine.js";
import type { Db } from "./db/client.js";
import { replaceInvoiceItems } from "./db/invoice-items.js";
import {
  getInvoiceByKsefNumber,
  type InvoiceRow,
  insertKsefInvoiceIfNotExists,
  updateInvoiceCategory,
} from "./db/invoices.js";
import { listRules } from "./db/rules.js";
import { getContinuationPoint, setContinuationPoint } from "./db/sync-state.js";
import type { InvoiceItemRecord } from "./ksef/invoice-parser.js";
import { fetchPurchaseInvoices } from "./ksef/invoices.js";

/** KSeF's buyer role (see design/SPEC.md §3); Parkowa only pulls its purchases. */
const SUBJECT_TYPE = "Subject2";

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
}

export interface SyncPurchaseInvoicesResult {
  invoices: InvoiceRow[];
  diagnostics: SyncDiagnostics;
  /**
   * Heuristic: true when the new continuation point (KSeF's high-water mark)
   * hasn't reached `windowTo` yet, meaning more invoices are likely still
   * available in this window. KSeF's incremental workflow doesn't expose an
   * exact "isTruncated" flag through this aggregate result, so this is a
   * string comparison against the requested window end -- always safe to
   * act on (calling sync again just resumes from the saved continuation
   * point), but can occasionally under/over-report right at a day boundary.
   */
  hasMore: boolean;
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

/** Both values are KSeF `PermanentStorage` ISO-8601 timestamps, so string order is chronological. */
function laterContinuationPoint(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a >= b ? a : b;
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

  const storedContinuationPoint = await getContinuationPoint(db, SUBJECT_TYPE);
  // The SDK queries `from: continuationPoint ?? windowFrom`, so a stored point
  // past windowTo (backfilling an earlier period) would build an invalid
  // `from > to` range and be rejected before any request is sent.
  const appliedContinuationPoint =
    storedContinuationPoint != null && storedContinuationPoint <= options.windowTo
      ? storedContinuationPoint
      : null;
  const continuationPoints: ContinuationPoints =
    appliedContinuationPoint != null ? { [SUBJECT_TYPE]: appliedContinuationPoint } : {};
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
    windowStartSkipped: effectiveFrom > options.windowFrom,
    maxIterations,
  });
  const fetchStartedAt = now();
  const fetchResult = await fetchInvoices(client, {
    windowFrom: options.windowFrom,
    windowTo: options.windowTo,
    continuationPoints,
    maxIterations,
  });
  logger.info("sync.fetch.completed", {
    durationMs: now() - fetchStartedAt,
    fetchedCount: fetchResult.invoices.length,
    referenceCount: fetchResult.referenceNumbers.length,
    continuationAfterFetch: fetchResult.continuationPoints[SUBJECT_TYPE] ?? null,
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
    const row = await insertKsefInvoiceIfNotExists(db, invoice);
    if (existing) {
      duplicateCount++;
    } else {
      insertedCount++;
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

  const newContinuationPoint = fetchResult.continuationPoints[SUBJECT_TYPE];
  // Monotonic: a backfill of an earlier period must not rewind the high-water
  // mark, or the next incremental sync re-downloads everything since then and
  // burns the tight export-init quota.
  const persistedContinuationPoint = laterContinuationPoint(
    storedContinuationPoint ?? null,
    newContinuationPoint ?? null,
  );
  await setContinuationPoint(db, SUBJECT_TYPE, persistedContinuationPoint);
  const hasMore = newContinuationPoint !== undefined && newContinuationPoint < options.windowTo;
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
  };
  logger.info("sync.persist.completed", {
    durationMs: persistDurationMs,
    ...diagnostics,
    hasMore,
  });

  return { invoices, hasMore, diagnostics };
}
