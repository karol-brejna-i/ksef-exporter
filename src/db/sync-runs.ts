import { desc, eq } from "drizzle-orm";
import type { Db } from "./client.js";
import { syncRuns } from "./schema.js";

export type SyncRunStatus = "running" | "success" | "error";

export interface SyncRun {
  id: number;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  windowFrom: string;
  windowTo: string;
  status: SyncRunStatus;
  invoiceCount: number | null;
  errorMessage: string | null;
  continuationBefore: string | null;
  continuationAfter: string | null;
  fetchedCount: number | null;
  insertedCount: number | null;
  duplicateCount: number | null;
  categorizedCount: number | null;
  needsReviewCount: number | null;
  /** NULL on runs recorded before line-item extraction existed, and on errors. */
  itemsInsertedCount: number | null;
  /** NULL as above; 0 means every extraction attempted in the run succeeded. */
  itemsFailedCount: number | null;
  hasMore: boolean | null;
  maxIterations: number | null;
  errorType: string | null;
  errorCode: string | null;
  httpStatus: number | null;
  retryAfterSeconds: number | null;
}

export interface CreateSyncRunInput {
  windowFrom: string;
  windowTo: string;
  startedAt?: string;
  continuationBefore?: string | null;
  maxIterations?: number;
}

export interface SyncRunSuccessDiagnostics {
  completedAt: string;
  durationMs: number;
  invoiceCount: number;
  continuationAfter: string | null;
  fetchedCount: number;
  insertedCount: number;
  duplicateCount: number;
  categorizedCount: number;
  needsReviewCount: number;
  /**
   * Line-item extraction outcome for the run, straight from `SyncDiagnostics`
   * (design/INVOICE_ITEMS_PLAN.md §5 Step 4). Required rather than optional so
   * a caller cannot quietly leave the columns NULL on a successful run --
   * "no items written" and "nobody recorded it" must stay distinguishable.
   */
  itemsInsertedCount: number;
  itemsFailedCount: number;
  hasMore: boolean;
}

export interface SyncRunErrorDiagnostics {
  completedAt: string;
  durationMs: number;
  errorMessage: string;
  errorType: string;
  errorCode?: string | null;
  httpStatus?: number | null;
  retryAfterSeconds?: number | null;
}

/**
 * Records that an import was requested (SPEC §2.2 NFR 5, Phase 7), before
 * the actual KSeF fetch happens -- so even a run that crashes or hangs
 * still shows up in the history as "running" rather than vanishing.
 */
export async function createSyncRun(db: Db, input: CreateSyncRunInput): Promise<SyncRun> {
  const [row] = await db
    .insert(syncRuns)
    .values({
      windowFrom: input.windowFrom,
      windowTo: input.windowTo,
      startedAt: input.startedAt,
      continuationBefore: input.continuationBefore,
      maxIterations: input.maxIterations,
    })
    .returning();
  if (!row) {
    throw new Error("Failed to create sync run: no row returned");
  }
  return row;
}

export async function markSyncRunSuccess(
  db: Db,
  id: number,
  diagnostics: SyncRunSuccessDiagnostics,
): Promise<SyncRun> {
  const [row] = await db
    .update(syncRuns)
    .set({
      status: "success",
      ...diagnostics,
      errorMessage: null,
      errorType: null,
      errorCode: null,
      httpStatus: null,
      retryAfterSeconds: null,
    })
    .where(eq(syncRuns.id, id))
    .returning();
  if (!row) {
    throw new Error(`Sync run ${id} not found`);
  }
  return row;
}

export async function markSyncRunError(
  db: Db,
  id: number,
  diagnostics: SyncRunErrorDiagnostics,
): Promise<SyncRun> {
  const [row] = await db
    .update(syncRuns)
    .set({ status: "error", ...diagnostics, invoiceCount: null })
    .where(eq(syncRuns.id, id))
    .returning();
  if (!row) {
    throw new Error(`Sync run ${id} not found`);
  }
  return row;
}

/** Most recent import runs first, capped so the list stays reasonable. */
export async function listRecentSyncRuns(db: Db, limit = 20): Promise<SyncRun[]> {
  return db.select().from(syncRuns).orderBy(desc(syncRuns.id)).limit(limit).all();
}
