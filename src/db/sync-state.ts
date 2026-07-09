import { eq } from "drizzle-orm";
import type { Db } from "./client.js";
import { syncState } from "./schema.js";

/**
 * Reads the persisted High-Water-Mark continuation point for a KSeF subject
 * type (SPEC §3.2). Returns `null` if a sync has run before but produced no
 * continuation point yet, or `undefined` if this subject type has never
 * been synced at all.
 */
export async function getContinuationPoint(
  db: Db,
  subjectType: string,
): Promise<string | null | undefined> {
  const row = await db.query.syncState.findFirst({
    where: eq(syncState.subjectType, subjectType),
  });
  if (!row) {
    return undefined;
  }
  return row.continuationPoint;
}

export async function setContinuationPoint(
  db: Db,
  subjectType: string,
  continuationPoint: string | null,
): Promise<void> {
  await db
    .insert(syncState)
    .values({ subjectType, continuationPoint })
    .onConflictDoUpdate({
      target: syncState.subjectType,
      set: { continuationPoint },
    })
    .run();
}
