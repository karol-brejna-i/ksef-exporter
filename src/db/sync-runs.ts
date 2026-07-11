import { desc, eq } from "drizzle-orm";
import type { Db } from "./client.js";
import { syncRuns } from "./schema.js";

export type SyncRunStatus = "running" | "success" | "error";

export interface SyncRun {
  id: number;
  requestedAt: string;
  windowFrom: string;
  windowTo: string;
  status: SyncRunStatus;
  invoiceCount: number | null;
  errorMessage: string | null;
}

/**
 * Records that an import was requested (SPEC §2.2 NFR 5, Phase 7), before
 * the actual KSeF fetch happens -- so even a run that crashes or hangs
 * still shows up in the history as "running" rather than vanishing.
 */
export async function createSyncRun(
  db: Db,
  window: { windowFrom: string; windowTo: string },
): Promise<SyncRun> {
  const [row] = await db
    .insert(syncRuns)
    .values({ windowFrom: window.windowFrom, windowTo: window.windowTo })
    .returning();
  if (!row) {
    throw new Error("Failed to create sync run: no row returned");
  }
  return row;
}

export async function markSyncRunSuccess(
  db: Db,
  id: number,
  invoiceCount: number,
): Promise<SyncRun> {
  const [row] = await db
    .update(syncRuns)
    .set({ status: "success", invoiceCount, errorMessage: null })
    .where(eq(syncRuns.id, id))
    .returning();
  if (!row) {
    throw new Error(`Sync run ${id} not found`);
  }
  return row;
}

export async function markSyncRunError(db: Db, id: number, errorMessage: string): Promise<SyncRun> {
  const [row] = await db
    .update(syncRuns)
    .set({ status: "error", errorMessage, invoiceCount: null })
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
