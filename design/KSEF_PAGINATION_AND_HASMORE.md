# KSeF pagination: `hasMore` heuristic vs. the SDK's discarded `isTruncated`

*Created: 2026-09-06 15:32 CEST*

## 1. Problem / context

`hasMore` in `syncPurchaseInvoices` (`src/sync.ts`) is a heuristic reconstructed from a bare
timestamp. It is meant to answer "is there more data in the requested window," but it has no
access to KSeF's actual answer to that question. In production it reports `hasMore: true` even on
calls that fetched and inserted **zero** invoices, which burns `POST /invoices/exports` quota
(16/min, 20/hour per subject type — `.github/copilot-instructions.md`) for nothing. This is a live
incident, confirmed empirically in both tenant databases (§3).

This document traces the bug to its root cause inside the pinned `ksef-client` SDK, documents the
exact blind spots in the current test suite that let it ship, and lays out a fix plan. **No code
is changed in this document** — it is a plan for whoever picks up `src/sync.ts` next.

Prior related work: `design/SYNC_CONTINUATION_POINT_ANALYSIS.md` §5 ("Unrelated observation:
`hasMore` over-reports") flagged this exact bug class on 2026-08-20 as known-but-unaddressed. This
document supersedes that observation with the actual mechanism and a concrete plan. The affected
operational tool is `design/HISTORICAL_BACKFILL_SCRIPT.md` (`src/tools/backfill-invoices.ts`) —
see §6 for how it is exposed there; this document does not duplicate that CLI's own reference doc.

## 2. Actual observed state

### 2.1 The SDK computes `isTruncated`-driven continuation, then throws it away

`client.workflows.exportsIncremental` (`IncrementalExportWorkflow`, used today by
`fetchPurchaseInvoices` in `src/ksef/invoices.ts`) is a thin loop over three lower-level calls that
are *also* exposed directly on `client.workflows.exports` (`InvoiceExportWorkflow`):
`startExport()`, `waitForExport()`, `downloadAndProcessPackage()`.

Source: `node_modules/ksef-client/src/services/incrementalExportWorkflow.ts`. Its `run()` method
(lines 40–125) calls all three per iteration, then on line 98:

```ts
updateContinuationPoint(
  options.continuationPoints,
  options.subjectType,
  status.package ?? {},
  { dateType: filters.dateRange?.dateType },
);
```

`updateContinuationPoint` (`node_modules/ksef-client/src/services/hwmCoordinator.ts`, lines 5–34)
is where the real signal lives:

```ts
const isTruncated = Boolean(packageInfo.isTruncated);
const lastPermanentStorageDate = packageInfo.lastPermanentStorageDate ?? undefined;
const hwmDate = packageInfo.permanentStorageHwmDate ?? undefined;
if (isTruncated && lastPermanentStorageDate) {
  continuationPoints[subjectType] = lastPermanentStorageDate;
  return;
}
if (hwmDate) {
  continuationPoints[subjectType] = hwmDate;
  return;
}
delete continuationPoints[subjectType];
```

`InvoicePackage.isTruncated` (`node_modules/ksef-client/src/types/invoices.ts`, lines 41–50) is a
**required, non-optional** `boolean` on the export status response — this is KSeF's own
authoritative "is there more data in this window" signal, not something we'd have to infer:

```ts
export interface InvoicePackage {
  invoiceCount: number;
  size: number;
  parts: InvoicePackagePart[];
  isTruncated: boolean;
  lastIssueDate?: string | null;
  lastInvoicingDate?: string | null;
  lastPermanentStorageDate?: string | null;
  permanentStorageHwmDate?: string | null;
}
```

So the SDK's own internal logic already branches correctly on `isTruncated`:
- **Truncated** (more data exists in this window) → advance to `lastPermanentStorageDate`, a real
  data pointer — the timestamp of the last invoice actually included in this package.
- **Not truncated** (page covers everything available) → advance to `permanentStorageHwmDate`, a
  server high-water mark that is essentially "now" — there is nothing more to fetch *yet*, but the
  server is telling us how far it has scanned regardless of whether it found anything.

But `IncrementalExportWorkflow`'s return type, `IncrementalExportResult`
(`incrementalExportWorkflow.ts` lines 26–31), does **not** include `isTruncated`:

```ts
export interface IncrementalExportResult {
  referenceNumbers: string[];
  metadataSummaries: Array<Record<string, unknown>>;
  invoiceXmlFiles: Record<string, string>;
  continuationPoints: ContinuationPoints;
}
```

`isTruncated` is read inside `run()`, used to pick which date to write into `continuationPoints`,
and then discarded. Only the resulting timestamp string survives to the caller. Our own
`fetchPurchaseInvoices` (`src/ksef/invoices.ts`) calls exactly this workflow (line 52,
`client.workflows.exportsIncremental.run(...)`) and returns only
`{ invoices, continuationPoints, referenceNumbers }` — the same three fields, with the same loss.

Confirmed directly on the three-call primitives (`node_modules/ksef-client/src/services/invoiceExportWorkflow.ts`):
`startExport()` (lines 72–89), `waitForExport()` (lines 91–114, returns
`InvoiceExportStatusResponse` which **does** carry `status.package.isTruncated`), and
`downloadAndProcessPackage()` (lines 116–153, takes that same `status` object as its first
argument). All three are public instance methods on `InvoiceExportWorkflow`, which is exactly what
`IncrementalExportWorkflow.run()` calls internally (constructor at line 36: `exports:
InvoiceExportWorkflow`). Nothing prevents calling them directly and keeping `status.package.isTruncated`.

### 2.2 Our own heuristic, verbatim

`src/sync.ts`, near the end of `syncPurchaseInvoices` (current lines ~362–378):

```ts
const newContinuationMs = continuationPointMs(newContinuationPoint ?? null, logger);
// When windowTo is today or later, KSeF has no future invoices to report and
// its own high-water mark advances to roughly "now" instead -- comparing
// only against windowTo would then report hasMore forever, since "now" keeps
// creeping forward on every poll but never reaches a windowTo that hasn't
// happened yet. Capping the comparison at "now" too means hasMore correctly
// means "more to fetch right now", not "more once windowTo actually arrives".
const effectiveWindowEndMs = Math.min(windowEndExclusiveMs, now());
// KSeF's high-water mark can also stall short of the window end with a
// windowTo well in the past -- if it hasn't moved since the point already
// persisted before this call, there is nothing this engine can do to make it
// move, so "still short of windowTo" alone would report hasMore forever.
const madeProgress =
  storedContinuationMs === null ||
  (newContinuationMs !== null && newContinuationMs > storedContinuationMs);
const hasMore =
  newContinuationMs !== null && newContinuationMs < effectiveWindowEndMs && madeProgress;
```

Two guards, added incrementally, each patching a distinct way the naive
`newContinuationMs < windowEndExclusiveMs` comparison loops forever:

1. **`effectiveWindowEndMs = Math.min(windowEndExclusiveMs, now())`** — commit `6dfa06c`
   (`fix(sync): bound hasMore by wall-clock so future windowTo doesn't loop forever`, 2026-08-28).
   Commit message: "hasMore only compared the new continuation point against windowTo, so once
   windowTo was today or later it could never become false... Confirmed live against parkowa: 14
   wasted export-init calls out of a 15-call safety cap."
2. **`madeProgress`** — commit `31c4bdb` (`fix(sync): stop hasMore looping forever on a stalled
   high-water mark`, 2026-09-03). Commit message: "hasMore only compared the freshly-returned
   continuation point against windowTo's exclusive end, never against the point already persisted
   before the call... confirmed on a real parkowa purchase backfill that burned 6 empty export-init
   calls before being stopped by hand."

Both guards were themselves shipped in response to real incidents, and both are stopgaps around the
same missing signal — `isTruncated`. Verify both SHAs with `git show 6dfa06c` / `git show
31c4bdb` if this section is ever suspected stale; do not trust this document over the commit itself.

### 2.3 Why both guards are defeated in production

The server's high-water mark / continuation point is generated **at export-init time**, inside
KSeF, before the export is even processed. Our `now()` is read **after** the full round trip:
`startExport` → poll `waitForExport` → download and decrypt the package. That round trip takes
seconds to low minutes.

- **Guard 1 (`effectiveWindowEndMs`) is defeated** because the HWM always looks like it's in the
  *past* relative to our locally-read `now()` — never in the future — so capping at `now()` never
  actually clips anything in the failure mode that matters. (It still correctly stops the
  future-`windowTo` case the commit describes; the empirical failure mode below is a different,
  additional gap the guard doesn't cover.)
- **Guard 2 (`madeProgress`) is defeated** because the HWM keeps creeping forward, call to call, by
  roughly the wall-clock duration of each round trip — a byproduct of clock drift, not evidence
  that any new invoice data has appeared. `madeProgress` treats that drift as "real progress" and
  keeps `hasMore` true forever, one export-init call at a time.

## 3. Empirical confirmation (measured against live tenant data)

Two read-only queries against `sync_runs` in both tenant databases confirm this mechanism with real
numbers. For each row, `gap_seconds = (completed_at - parsed_continuation_after) / 1000` — how far
behind our locally-read completion time the KSeF-issued continuation point sits.

**parkowa** (`data/tenants/parkowa/ksef-exporter.sqlite`), `sync_runs` ids 48–51, all
`subject_type = Subject2`:

| id | fetched_count | inserted_count | has_more | gap_seconds |
|---|---|---|---|---|
| 48 | 184 | 24 | 1 | 122.341 |
| 49 | 0 | 0 | 1 | 121.920 |
| 50 | 0 | 0 | 1 | 121.943 |
| 51 | 0 | 0 | 1 | 120.210 |

**portowa** (`data/tenants/portowa/ksef-exporter.sqlite`), `sync_runs` ids 31–35:

| id | fetched_count | inserted_count | has_more | gap_seconds |
|---|---|---|---|---|
| 31 | 178 | 42 | 1 | 122.37 |
| 32 | 0 | 0 | 1 | 121.96 |
| 33 | 0 | 0 | 1 | 121.98 |
| 34 | 0 | 0 | 1 | 120.05 |
| 35 | 0 | 0 | 1 | 121.96 |

In both tenants: a consistent ~120–122 second gap on every call, and — critically — `has_more=1`
on calls that fetched and inserted **zero** invoices (portowa 32–35, parkowa 49–51). This is the
exact live incident: a backfill run burns an export-init call for zero new data, repeatedly,
because the heuristic can never distinguish "still more data in this window" from "just wall-clock
drift since the last call."

## 4. Analysis

Both problems in §2.3 exist because the code operates on the *effect* of `isTruncated`
(the resulting timestamp) instead of the flag itself. A ~2-minute round trip is exactly the right
order of magnitude to explain the measured gap: `startExport` → poll until KSeF finishes building
the package (`waitForExport`, default `pollIntervalMs: 2000`, `maxAttempts: 60`) → download,
decrypt, unzip. None of that time is "new data arriving"; all of it is latency between when KSeF
stamped the HWM and when we read our own clock afterward. No amount of tuning the two existing
guards' thresholds fixes this, because the guards are reasoning about a timestamp that was never
designed to answer "is there more data" — that answer was computed once, correctly, inside the SDK,
and discarded before it reached us (§2.1).

## 5. Existing test blind spots

`src/sync.test.ts` covers each guard's *original* incident precisely, but with fixtures that are
inverted relative to what production actually does, or that bake in a state that becomes provably
impossible once `isTruncated` is honored.

1. **`"regression: does not report hasMore forever when windowTo is in the future"`** — line 636.
   Fixture:
   ```ts
   const fetchInvoices = async (): Promise<FetchPurchaseInvoicesResult> => ({
     invoices: [],
     continuationPoints: { Subject2: "2026-08-28T18:00:05+00:00" },
     referenceNumbers: [],
   });
   // ...
   { fetchInvoices, now: () => Date.parse("2026-08-28T18:00:00Z") },
   ```
   The injected HWM (`18:00:05`) is **5 seconds ahead** of the injected `now()` (`18:00:00`). Per
   §3, real production data shows the opposite: the HWM is **~120 seconds behind** `now()` on every
   call, never ahead. A fixture where the HWM leads the clock cannot exercise the actual failure
   mode — it tests a scenario that plausibly never occurs in this codebase's traffic pattern.

2. **`"regression: does not report hasMore forever when the high-water mark stalls in a past window"`**
   — line 663. Fixture stalls the continuation point at a fixed constant,
   `const stalled = "2026-08-30T22:00:00+00:00";` (line 671), returned unchanged from the previous
   call. This one is a reasonable test of genuine stalling (HWM truly frozen), which is a real but
   different scenario from the drift case in §3 — the empirical data show *continuous* forward
   creep call-to-call, not a frozen value. Worth keeping, but it does not cover the drift case
   either.

3. **`"reports hasMore when the new continuation point hasn't reached windowTo yet"`** — line 560.
   Fixture:
   ```ts
   const fetchInvoices = async (): Promise<FetchPurchaseInvoicesResult> => ({
     invoices: [],
     // Truncated/partial page: KSeF's HWM only advanced to the 15th, well
     // short of the requested windowTo (the 31st).
     continuationPoints: { Subject2: "2025-01-15T00:00:00Z" },
     referenceNumbers: ["ref-1"],
   });
   // ...
   expect(result.hasMore).toBe(true);
   ```
   This asserts `hasMore === true` for a fetch that returned **zero invoices**. The test's own
   comment calls this a "truncated/partial page" — but a genuinely truncated, non-empty page from
   KSeF always returns invoices (that's what `isTruncated: true` means: there was more to send than
   fit in the package). An **empty, truncated** page is not something KSeF's API is documented to
   produce, and once `isTruncated` is honored directly (§7), an empty, *non-truncated* page can
   never mean "more data is available" — that is exactly the `has_more=1`/`fetched_count=0`
   combination in §3 that this whole document exists to fix. This fixture encodes the buggy
   behavior as the intended one. The same shape (`invoices: []` plus `hasMore: true`) recurs in at
   least two more tests in the file — `"regression, Defect C: reports hasMore for a point on the
   final day of the window"` (line 608) and `"still reports hasMore when the high-water mark keeps
   advancing toward a past windowTo"` (line 692) — all three will need re-deriving once `isTruncated`
   is the actual signal, not just the one at line 560.

No test file exists yet for `src/tools/backfill-invoices.ts` — `src/tools/` currently has zero
`*.test.ts` files (confirmed: `backfill-invoice-items.ts`, `backfill-invoice-kind.ts`,
`backfill-invoice-totals.ts`, `backfill-invoices.ts`, `export-invoices.ts`, `extract-xlsx.ts`,
`reconcile.ts` — none paired with a test). That CLI's call-loop-vs-`hasMore` interaction (§6) is
completely untested, including its own `MAX_CALLS` safety-cap behavior.

## 6. Operational exposure: the backfill CLI

`design/HISTORICAL_BACKFILL_SCRIPT.md` documents `src/tools/backfill-invoices.ts`
(`pnpm run backfill:invoices`) in full — this section only notes how the bug surfaces there; read
that doc for the CLI's actual usage and env vars.

The CLI's `backfillDirection()` loop (`src/tools/backfill-invoices.ts` lines 77–164) calls
`syncPurchaseInvoices` repeatedly, stopping only when `result.hasMore` is false or its own
`BACKFILL_MAX_CALLS` cap (env `BACKFILL_MAX_CALLS`, default 15) is reached — and that cap is
**per direction**, not a single global budget shared across purchase and sales (§4 of that doc).
So an unattended run does eventually stop; it just does so after burning most of an hourly
export-init quota (16/min, 20/hour per subject type) on empty pages, per direction, exactly as
shown by the `has_more=1`/`fetched_count=0` runs in §3. This is not an infinite loop — it is a
bounded loop that reliably wastes most of its budget.

## 7. The planned fix (not implemented here)

Four parts. This document is the plan; none of this has been coded yet.

1. **`src/ksef/invoices.ts`: bypass `exportsIncremental.run()`.** Call
   `client.workflows.exports.startExport()` → `waitForExport()` → `downloadAndProcessPackage()`
   directly (all three confirmed public on `InvoiceExportWorkflow`, §2.1), so
   `status.package.isTruncated` becomes visible to our code and can be threaded through
   `FetchPurchaseInvoicesResult` into `src/sync.ts`.

   **Correction (2026-09-06, verified against actual call sites via grep, not assumed):** the sync
   engine's path (`syncPurchaseInvoices` → `src/api/server.ts`, `src/tools/backfill-invoices.ts`)
   does always pin `maxIterations: 1`, but `fetchPurchaseInvoices` itself has two other direct
   callers that request real multi-page fetches: `src/ksef/dump-invoices.ts` (`maxIterations: 10`)
   and `src/ksef/smoke-invoices.ts` (`maxIterations: 5`). So the bypass must faithfully replicate
   `IncrementalExportWorkflow.run()`'s own iteration loop (§2.1), not just perform a single call.
   The good news: `updateContinuationPoint`, `getEffectiveStartDate`, and `dedupeByKsefNumber` —
   the three helpers `incrementalExportWorkflow.ts` uses internally between iterations — are all
   re-exported from the package's public root (`src/index.ts`: `export * from
   "./services/hwmCoordinator"`; confirmed present in `dist/index.d.ts`'s export list), so the
   replacement can import and reuse them directly from `"ksef-client"` instead of reimplementing
   or duplicating that logic. The replacement loop is the same `for` loop, calling the three
   `InvoiceExportWorkflow` primitives and these three public helpers each iteration, with one
   addition: capture `status.package.isTruncated` / `lastPermanentStorageDate` /
   `permanentStorageHwmDate` from the **final** iteration's `status` before returning.

   **Flag explicitly:** `.github/copilot-instructions.md` states a general preference for the
   SDK's own workflows over reimplementing authentication, export polling, decryption, or package
   handling. This bypass is a deliberate, documented exception to that preference — not a
   reimplementation of any of those four things, since `startExport`/`waitForExport`/
   `downloadAndProcessPackage` still do all of the polling, decryption, and package handling
   themselves. The only thing we're doing differently is *not* calling the one-line wrapper that
   throws away the field we need immediately after computing it.

2. **`src/sync.ts`: make `hasMore` driven by the real `isTruncated`.** Replace the
   `madeProgress`/timestamp-comparison heuristic with the actual flag, still ANDed with the
   existing window-end bound (`effectiveWindowEndMs`) so a truncated page whose data has moved past
   the requested `windowTo` still correctly reports no more work for *this* window. Add a
   `hasMoreReason` discriminant (e.g. `"truncated"` / `"window-exhausted"` / `"stalled"`) surfaced
   in diagnostics for observability, replacing the need to reverse-engineer intent from timestamps
   the way §3's investigation had to. Fix the three test fixtures identified in §5 (lines 560, 608,
   636, 692 as currently numbered) so they assert against `isTruncated`-driven behavior instead of
   the inverted/impossible states described there.

3. **`src/tools/backfill-invoices.ts`: extract a testable seam and add defense in depth.** Pull the
   call-loop body out of `backfillDirection()` into a unit-testable function (its first-ever test
   file — none exist under `src/tools/` today, §5), log `referenceCount`/`hasMoreReason` per call
   for diagnosability, and add a circuit breaker that stops after N consecutive zero-fetch calls
   regardless of what `hasMore` reports — defense in depth so a future regression in the
   `isTruncated` plumbing can't reproduce this incident even if `hasMore` itself is wrong again.

4. **New traceability columns (purely additive migration, no table rebuild).** A nullable
   `invoices.sync_run_id` column, plus `sync_runs.is_truncated` and `sync_runs.has_more_reason`
   columns. `src/db/schema.ts`'s current `syncRuns` table (lines 271–341) already has
   `hasMore: integer("has_more", { mode: "boolean" })` (line 304) but nothing that records *why*;
   `invoices` (schema.ts line 43 onward) has no run-linking column at all today. Currently the only
   way to find which invoices came from which sync run is a fragile time-range join between
   `sync_runs.started_at`/`completed_at` and `invoices.created_at` (schema.ts line 109) — which
   misses duplicates, since a duplicate (matched by KSeF number, never overwritten) keeps its
   *original* `created_at` from whichever run first inserted it, invisible to any join keyed on the
   later run's time range. Per `.github/copilot-instructions.md`'s migration rules: additive-only,
   apply via `pnpm run db:generate` into `drizzle/migrations/`, never hand-edit the generated
   migration, and trial on a `cp` of the database first.

## 8. Open questions / next steps

- ~~Confirm whether `downloadAndProcessPackage`'s early return for `packageInfo.invoiceCount === 0`
  still leaves `status.package.isTruncated` populated.~~ **Resolved 2026-09-06**: confirmed directly
  from `invoiceExportWorkflow.ts`. `status.package` (including `isTruncated`) is entirely a property
  of the `InvoiceExportStatusResponse` returned by `waitForExport` (lines 91–114) — it is read and
  returned before `downloadAndProcessPackage` is ever called. `downloadAndProcessPackage`'s early
  return for `invoiceCount === 0` (lines 121–124) only short-circuits its own download/decrypt/unzip
  work and returns an empty `PackageProcessingResult`; it never touches or depends on `status`. So
  `status.package.isTruncated` is available and correct on an empty package with zero code changes
  needed to recover it — the bypass in §7.1 just needs to read `status.package.isTruncated` off the
  `waitForExport` result and pass it through, regardless of whether `downloadAndProcessPackage`
  found anything to download.
- Decide the exact `hasMoreReason` enum values before implementing §7.2, so the CLI logging in §7.3
  and the new `sync_runs.has_more_reason` column in §7.4 agree on the same vocabulary from the
  start rather than needing a follow-up migration.
- The circuit breaker in §7.3 ("N consecutive zero-fetch calls") needs an actual N chosen and
  justified — not decided in this document.
- Whether `hasMoreReason` should also flow into the API response consumed by the web UI (so
  "Recent Imports" could show *why* another import is suggested) is out of scope here and left to
  whoever picks up the API/UI side of this work.
