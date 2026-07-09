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
  maxIterations?: number;
}

export interface SyncPurchaseInvoicesResult {
  invoices: InvoiceRow[];
}

export interface SyncPurchaseInvoicesDeps {
  /** Injectable for tests; defaults to the real `fetchPurchaseInvoices`. */
  fetchInvoices?: typeof fetchPurchaseInvoices;
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

  const storedContinuationPoint = await getContinuationPoint(db, SUBJECT_TYPE);
  const continuationPoints: ContinuationPoints =
    storedContinuationPoint != null ? { [SUBJECT_TYPE]: storedContinuationPoint } : {};

  const fetchResult = await fetchInvoices(client, {
    windowFrom: options.windowFrom,
    windowTo: options.windowTo,
    continuationPoints,
    ...(options.maxIterations !== undefined ? { maxIterations: options.maxIterations } : {}),
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

  return { invoices };
}
