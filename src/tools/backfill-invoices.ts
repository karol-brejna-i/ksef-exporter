/**
 * CLI for a historical invoice backfill, one tenant at a time, both
 * directions by default (design/SALES_INVOICES_PLAN.md Step 6). Originally
 * sales-only; generalized to also cover purchase re-backfills, then to run
 * both directions in one invocation, since they hit the exact same
 * continuation-point and date-range hazards and never share a KSeF quota.
 *
 * Makes real KSeF network calls against the tenant selected by `.env` /
 * `DATABASE_PATH` (or `APP_ENV`, see README.md "Selecting an env file") --
 * run once per tenant, switching `APP_ENV`/`.env` between runs.
 * Mirrors `POST /sync`'s bookkeeping exactly (one `sync_runs` row per call,
 * same success/error diagnostics) so the run shows up in Recent Imports like
 * any other sync.
 *
 * Each call to `syncPurchaseInvoices` does at most one export-init request
 * (`maxIterations: 1`, unchanged) to stay well under KSeF's 16/min, 20/hour
 * budget per subject type (see src/sync.ts). For each direction, this script
 * repeats that call, resuming from the persisted continuation point each
 * time, until `hasMore` is false or a safety cap of iterations is reached --
 * never in a tight loop, so a single accidental invocation cannot exhaust the
 * hourly budget. Purchase (Subject2) and sales (Subject1) each keep their own
 * continuation point and their own independent 16/min-20/hour budget, so
 * running both directions' call loops one after another in the same
 * invocation cannot make either direction exceed its own quota.
 *
 * Usage:
 *   BACKFILL_WINDOW_FROM=2026-05-01 BACKFILL_WINDOW_TO=2026-08-28 \
 *     pnpm run backfill:invoices
 *
 * BACKFILL_DIRECTION selects "both" (default), "purchase" (Subject2), or
 * "sales" (Subject1).
 * BACKFILL_MAX_CALLS overrides the default 15-call safety cap **per
 * direction** (e.g. to make exactly one careful call when the hourly quota is
 * already partly spent).
 * BACKFILL_RESET_CONTINUATION=true clears the stored continuation point for
 * every direction being run (all of them, under the "both" default) before
 * its first call -- required before a backfill whose window contains an
 * existing high-water mark, which would otherwise silently win over
 * `windowFrom` (design/SYNC_CONTINUATION_POINT_ANALYSIS.md §3.1) and skip the
 * historical range this script exists to fetch.
 */
import { fileURLToPath } from "node:url";
import type { KsefClient } from "ksef-client";
import "../config/bootstrap-env.js";
import { loadConfig } from "../config/env.js";
import type { Db } from "../db/client.js";
import { createDb } from "../db/client.js";
import type { InvoiceDirection } from "../db/invoices.js";
import { createSyncRun, markSyncRunError, markSyncRunSuccess } from "../db/sync-runs.js";
import { getContinuationPoint, setContinuationPoint } from "../db/sync-state.js";
import { KsefSessionManager } from "../ksef/client.js";
import { classifyKsefError, formatKsefError } from "../ksef/rate-limit.js";
import { SUBJECT_TYPE_BY_DIRECTION, syncPurchaseInvoices } from "../sync.js";

const MAX_CALLS = Number(process.env.BACKFILL_MAX_CALLS ?? 15);
/**
 * Circuit breaker (design/KSEF_PAGINATION_AND_HASMORE.md §7.3): stop after
 * this many consecutive calls that fetched zero invoices, regardless of what
 * `hasMore` reports. Defense in depth for the exact live incident that doc
 * traces -- `hasMore` staying true on empty pages -- so a future regression
 * in the `isTruncated` plumbing (§7.1/§7.2) can't reproduce it here even if
 * `hasMore` itself is wrong again.
 *
 * N=3: large enough that one legitimately sparse period in real invoice data
 * (e.g. a slow week with a single empty page before more arrives) doesn't
 * false-trip the breaker, small enough to decisively stop the zero-fetch-
 * forever pattern from the incident (§3 of that doc: 4-5 consecutive empty
 * calls observed per tenant before the run was stopped by hand) well before
 * burning meaningful export-init quota.
 */
const MAX_CONSECUTIVE_EMPTY = Number(process.env.BACKFILL_MAX_CONSECUTIVE_EMPTY ?? 3);
const DELAY_BETWEEN_CALLS_MS = 3_000;
const ALL_DIRECTIONS: InvoiceDirection[] = ["purchase", "sales"];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Injectable seam for `backfillDirection` (mirrors `src/api/server.ts`'s
 * `BuildServerDeps` convention: `deps.sync ?? syncPurchaseInvoices`), so a
 * test can drive the call loop with a fake `syncPurchaseInvoices` and a fake
 * delay without waiting on real timers or KSeF network calls. All fields
 * default to the real implementation / env-configured constant.
 */
export interface BackfillDirectionDeps {
  /** Injectable for tests; defaults to the real `syncPurchaseInvoices`. */
  sync?: typeof syncPurchaseInvoices;
  /** Injectable for tests; defaults to a real `setTimeout`-based delay. */
  sleep?: (ms: number) => Promise<void>;
  /** Overridable per-direction call cap; defaults to `MAX_CALLS` (env `BACKFILL_MAX_CALLS`). */
  maxCalls?: number;
  /** Overridable consecutive-empty-fetch circuit breaker; defaults to `MAX_CONSECUTIVE_EMPTY` (env `BACKFILL_MAX_CONSECUTIVE_EMPTY`). */
  maxConsecutiveEmpty?: number;
}

function resolveDirections(): InvoiceDirection[] {
  const raw = process.env.BACKFILL_DIRECTION;
  if (raw === undefined || raw === "both") return ALL_DIRECTIONS;
  if (raw === "purchase" || raw === "sales") return [raw];
  throw new Error(`Unknown BACKFILL_DIRECTION "${raw}" -- use "purchase", "sales", or "both".`);
}

/**
 * Paced call loop for a single direction. Independent of any other
 * direction: its own continuation point, its own export-init quota, its own
 * safety cap -- so running this for "purchase" then "sales" in the same
 * process is exactly as safe as two separate invocations. Returns false only
 * on a KSeF error; a spent safety cap (`MAX_CALLS`) or a tripped
 * consecutive-empty circuit breaker (`MAX_CONSECUTIVE_EMPTY`) is a warning,
 * not a failure, since rerunning the script always resumes from the
 * persisted continuation point.
 */
export async function backfillDirection(
  db: Db,
  client: KsefClient,
  direction: InvoiceDirection,
  windowFrom: string,
  windowTo: string,
  deps: BackfillDirectionDeps = {},
): Promise<boolean> {
  const sync = deps.sync ?? syncPurchaseInvoices;
  const delay = deps.sleep ?? sleep;
  const maxCalls = deps.maxCalls ?? MAX_CALLS;
  const maxConsecutiveEmpty = deps.maxConsecutiveEmpty ?? MAX_CONSECUTIVE_EMPTY;
  const subjectType = SUBJECT_TYPE_BY_DIRECTION[direction];

  if (process.env.BACKFILL_RESET_CONTINUATION === "true") {
    await setContinuationPoint(db, subjectType, null);
    console.log(`Reset stored ${subjectType} continuation point to null.`);
  }

  let totalInvoices = 0;
  let consecutiveEmptyFetches = 0;
  for (let call = 1; call <= maxCalls; call++) {
    const startedAtMs = Date.now();
    const continuationBefore = await getContinuationPoint(db, subjectType);
    const run = await createSyncRun(db, {
      windowFrom,
      windowTo,
      startedAt: new Date(startedAtMs),
      continuationBefore: continuationBefore ?? null,
      maxIterations: 1,
      subjectType,
    });
    console.log(
      `\n[${direction} call ${call}] sync_runs id=${run.id}, continuationBefore=${continuationBefore ?? "null"}`,
    );

    try {
      const result = await sync(
        db,
        client,
        { windowFrom, windowTo, direction, syncRunId: run.id },
        { logger: { info: () => {}, warn: (event, meta) => console.warn(event, meta) } },
      );
      const completedAtMs = Date.now();
      await markSyncRunSuccess(db, run.id, {
        completedAt: new Date(completedAtMs),
        durationMs: completedAtMs - startedAtMs,
        invoiceCount: result.invoices.length,
        continuationAfter: result.diagnostics.continuationAfter,
        fetchedCount: result.diagnostics.fetchedCount,
        insertedCount: result.diagnostics.insertedCount,
        duplicateCount: result.diagnostics.duplicateCount,
        categorizedCount: result.diagnostics.categorizedCount,
        needsReviewCount: result.diagnostics.needsReviewCount,
        itemsInsertedCount: result.diagnostics.itemsInsertedCount,
        itemsFailedCount: result.diagnostics.itemsFailedCount,
        hasMore: result.hasMore,
        isTruncated: result.diagnostics.isTruncated,
        hasMoreReason: result.hasMoreReason,
      });
      totalInvoices += result.invoices.length;
      console.log(
        `[${direction} call ${call}] fetched=${result.diagnostics.fetchedCount} inserted=${result.diagnostics.insertedCount} ` +
          `duplicate=${result.diagnostics.duplicateCount} hasMore=${result.hasMore} hasMoreReason=${result.hasMoreReason ?? "unknown"}`,
      );

      if (result.diagnostics.fetchedCount === 0) {
        consecutiveEmptyFetches++;
      } else {
        consecutiveEmptyFetches = 0;
      }

      if (!result.hasMore) {
        console.log(
          `\nDone. ${totalInvoices} ${direction} invoice(s) inserted across ${call} call(s).`,
        );
        return true;
      }

      if (consecutiveEmptyFetches >= maxConsecutiveEmpty) {
        console.warn(
          `\nStopped ${direction} after ${consecutiveEmptyFetches} consecutive calls that fetched zero ` +
            `invoices (circuit breaker, BACKFILL_MAX_CONSECUTIVE_EMPTY=${maxConsecutiveEmpty}) even though ` +
            `hasMore was still true -- rerun to resume from the persisted continuation point.`,
        );
        return true;
      }
    } catch (error) {
      const completedAtMs = Date.now();
      const diagnostics = classifyKsefError(error);
      await markSyncRunError(db, run.id, {
        completedAt: new Date(completedAtMs),
        durationMs: completedAtMs - startedAtMs,
        errorMessage: diagnostics.message,
        errorType: diagnostics.errorType,
        errorCode: diagnostics.errorCode,
        httpStatus: diagnostics.httpStatus,
        retryAfterSeconds: diagnostics.retryAfterSeconds,
      });
      console.error(`[${direction} call ${call}] failed:`, formatKsefError(error));
      return false;
    }

    await delay(DELAY_BETWEEN_CALLS_MS);
  }

  console.warn(
    `\nStopped ${direction} after the ${maxCalls}-call safety cap with more data still available.`,
  );
  return true;
}

async function main() {
  const windowFrom = process.env.BACKFILL_WINDOW_FROM;
  const windowTo = process.env.BACKFILL_WINDOW_TO;
  if (!windowFrom || !windowTo) {
    console.error("Set BACKFILL_WINDOW_FROM and BACKFILL_WINDOW_TO (YYYY-MM-DD) first.");
    process.exitCode = 1;
    return;
  }
  const directions = resolveDirections();

  const config = loadConfig();
  console.log(
    `Backfilling ${directions.join(" + ")} invoices for NIP ${config.KSEF_NIP} (${config.KSEF_ENVIRONMENT}) ` +
      `into ${config.DATABASE_PATH}, window ${windowFrom} -> ${windowTo}...`,
  );

  const { db } = createDb(config.DATABASE_PATH);
  const manager = new KsefSessionManager(config);
  const client = await manager.getClient();

  let allOk = true;
  for (const direction of directions) {
    if (directions.length > 1) console.log(`\n=== ${direction} ===`);
    const ok = await backfillDirection(db, client, direction, windowFrom, windowTo);
    allOk = allOk && ok;
  }
  if (!allOk) process.exitCode = 1;
}

// Guards the real KSeF-calling entry point so importing this module (e.g.
// from `src/tools/backfill-invoices.test.ts`, importing `backfillDirection`
// for the injectable-seam tests below) never runs `main()` as a side effect.
const isMainModule =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) {
  main().catch((error) => {
    console.error("Invoice backfill failed:", formatKsefError(error));
    process.exitCode = 1;
  });
}
