import type { ContinuationPoints, KsefClient } from "ksef-client";
import { categorize } from "./categorization/engine.js";
import type { Db } from "./db/client.js";
import {
  type InvoiceRow,
  insertKsefInvoiceIfNotExists,
  updateInvoiceCategory,
} from "./db/invoices.js";
import { listRules } from "./db/rules.js";
import { getContinuationPoint, setContinuationPoint } from "./db/sync-state.js";
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

/**
 * Minimal logging interface (satisfied by both Fastify's `request.log` and
 * plain `console`) so callers can see sync progress -- there's otherwise no
 * feedback while the KSeF export/poll/download cycle runs, which can take
 * a while and gives no indication anything is happening.
 */
export interface SyncLogger {
  info: (message: string, meta?: Record<string, unknown>) => void;
}

const noopLogger: SyncLogger = { info: () => {} };

export interface SyncPurchaseInvoicesDeps {
  /** Injectable for tests; defaults to the real `fetchPurchaseInvoices`. */
  fetchInvoices?: typeof fetchPurchaseInvoices;
  /** Injectable for tests; defaults to a no-op logger. */
  logger?: SyncLogger;
}

/**
 * The end-to-end engine flow (SPEC "the engine"): pulls new purchase
 * invoices from KSeF since the last sync (Phase 2), persists them
 * idempotently (Phase 3), then runs each newly-inserted, never-touched
 * invoice through the Tier-1 categorization engine (Phase 4) and persists
 * the result. Invoices that already have a category (from a previous sync
 * or a human correction) are never re-categorized here, so this is always
 * safe to re-run.
 */
export async function syncPurchaseInvoices(
  db: Db,
  client: Pick<KsefClient, "workflows">,
  options: SyncPurchaseInvoicesOptions,
  deps: SyncPurchaseInvoicesDeps = {},
): Promise<SyncPurchaseInvoicesResult> {
  const fetchInvoices = deps.fetchInvoices ?? fetchPurchaseInvoices;
  const logger = deps.logger ?? noopLogger;

  const storedContinuationPoint = await getContinuationPoint(db, SUBJECT_TYPE);
  const continuationPoints: ContinuationPoints =
    storedContinuationPoint != null ? { [SUBJECT_TYPE]: storedContinuationPoint } : {};

  logger.info("sync: requesting export from KSeF", {
    windowFrom: options.windowFrom,
    windowTo: options.windowTo,
    resumingFrom: storedContinuationPoint ?? null,
  });
  const fetchResult = await fetchInvoices(client, {
    windowFrom: options.windowFrom,
    windowTo: options.windowTo,
    continuationPoints,
    maxIterations: options.maxIterations ?? 1,
  });
  logger.info("sync: received invoices from KSeF, persisting", {
    count: fetchResult.invoices.length,
  });

  const rules = await listRules(db);
  const invoices: InvoiceRow[] = [];
  for (const invoice of fetchResult.invoices) {
    const row = await insertKsefInvoiceIfNotExists(db, invoice);

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
    invoices.push(await updateInvoiceCategory(db, row.id, result.categoryId, result.confidence));
  }

  const newContinuationPoint = fetchResult.continuationPoints[SUBJECT_TYPE];
  await setContinuationPoint(db, SUBJECT_TYPE, newContinuationPoint ?? null);
  const hasMore = newContinuationPoint !== undefined && newContinuationPoint < options.windowTo;
  logger.info("sync: complete", {
    persistedCount: invoices.length,
    newContinuationPoint: newContinuationPoint ?? null,
    hasMore,
  });

  return { invoices, hasMore };
}
