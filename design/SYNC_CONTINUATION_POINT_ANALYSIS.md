# Sync failure analysis: continuation point vs. requested window

**Last updated:** 2026-08-10 18:13
**Status:** implemented — see §3 for the shipped behavior.


    > shortly: the implemented windowing mechanism ("sync walking window" presumably due to api quotas) is suspicious.
    > this was just manifestation of this.
    > needed quick fix so implemented suggested solution, but probably revisiting it (the mechanism) is better:
    > - is it really required? if so, probably api should be split to /sync and continue

Observed symptom (web UI, Import):

```
Failed: Invoice query filters.dateRange.to must be greater than or equal to dateRange.from.
```

## 1. Evidence from `api.log`

Three facts, in order:

1. **`syncRunId: 5`** — `sync.started` with `windowFrom: "2026-08-01"`, `windowTo: "2026-08-31"`,
   `continuationBefore: null`. Succeeded: `fetchedCount: 74`, `insertedCount: 74`, and persisted
   `continuationAfter: "2026-08-10T15:32:59.989017+00:00"` — KSeF's `PermanentStorage` high-water
   mark, i.e. effectively "now".
2. **`syncRunId: 6` and `7`** — `windowFrom: "2026-07-01"`, `windowTo: "2026-07-31"` (a backfill of
   the previous month), but `continuationBefore` is still `"2026-08-10T15:32:59.989017+00:00"`.
3. Both failed with `sync.failed`, `errorType: "KsefValidationError"`, `httpStatus: null`,
   `causeChain: []`. Run 7 failed in **3 ms**, with `sync.client.completed` at `durationMs: 0` —
   no HTTP request to KSeF was ever made. The rejection is client-side, inside the SDK.

## 2. Root cause

The stored continuation point **silently replaces** `windowFrom`. From the SDK
(`node_modules/ksef-client/dist/index.js`):

```js
function getEffectiveStartDate(continuationPoints, subjectType, windowFrom) {
  return continuationPoints[subjectType] ?? windowFrom;   // continuation wins
}
// ...
const filters = {
  dateRange: { from: effectiveFrom, to: options.windowTo, dateType: "PermanentStorage" },
};
```

`syncPurchaseInvoices` in `src/sync.ts` always passes the stored point when one exists:

```ts
const continuationPoints: ContinuationPoints =
  storedContinuationPoint != null ? { [SUBJECT_TYPE]: storedContinuationPoint } : {};
```

So the July backfill was actually sent as `from: 2026-08-10T15:32:59Z`, `to: 2026-07-31`, i.e.
`from > to`, which the SDK's own validator rejects before issuing any request.

### 2.1 The silent variant is worse than this crash

A backfill of `2026-07-01 → 2026-09-30` would **not** error. It would quietly start at
`2026-08-10T15:32:59Z`, skip all of July, and report success. The July-only request failed purely
because it *also* violated `from <= to`. Any requested window that starts before the stored
high-water mark is currently ignored without a signal.

### 2.2 Secondary issue: wrong HTTP status

`KsefValidationError` does not extend `KsefApiError`, so it carries no `statusCode` and falls into
the generic branch of the `/sync` catch block in `src/api/server.ts`:

```ts
if (error instanceof KsefApiError && error.statusCode < 500) { /* friendly message */ }
return reply.code(500).send({ error: "internal error", syncRunId: run.id });
```

This is a user-input/state conflict, not an internal error, but it is reported as HTTP 500
`"internal error"`. The user only sees a meaningful message because Recent Imports renders
`errorMessage` from the `sync_runs` row.

## 3. Fix

Implemented in `src/sync.ts` and `src/api/server.ts`:

1. **Drop the stored point only when it is later than `windowTo`.** That is the one case where it
   cannot possibly be a continuation *within* the requested window, so the call is treated as a
   backfill and queries `[windowFrom, windowTo]` directly.
2. **Persist `max(stored, fetched)`** — the high-water mark never moves backwards. Without this, a
   July backfill rewinds the incremental cursor and the next current-month sync re-downloads
   August. Dedupe by KSeF number would absorb the duplicates, but it burns the tight
   `POST /invoices/exports` budget (16/min, 20/h) for nothing. This also means a fetch that
   returns no continuation point keeps the previous one instead of clearing it.
3. **Log the effective query start** and warn on the conflict (see §4), so neither branch is silent.
4. **Map `KsefValidationError` to 400** with the SDK message, instead of 500 `"internal error"`.

### 3.1 Why not "drop the point whenever it falls outside the window"

That was the first idea, and it is wrong in both directions:

- `stored <= windowFrom` (e.g. HWM at 2025-01-31, window February): the point *should* be used.
  Starting at the stored point rather than `windowFrom` closes the gap between the two.
- `windowFrom < stored <= windowTo` is genuinely ambiguous. It is both the backfill-intent case
  from §2.1 *and* the normal "click Import again to continue" pagination flow — an import of the
  current month with the HWM sitting mid-month. Since the two are indistinguishable without an
  explicit mode flag, the point is kept (pagination wins) and the skipped range is surfaced in the
  log via `windowStartSkipped`.

### Alternative not taken

Split `/sync` into two explicit modes: *continue incremental* (ignores the date inputs entirely and
uses the stored point) and *backfill range* (ignores the stored point and does not persist it). That
would remove the ambiguity above, at the cost of two UI modes for a single-user app.

## 4. Logging changes

Ranked by how much each would have shortened this investigation:

1. **`sync.fetch.started` now logs `effectiveFrom`** (the value the SDK actually queries with),
   plus `continuationApplied` and `windowStartSkipped`. Previously only `windowFrom`, `windowTo`,
   and `continuationBefore` were recorded, so the override was invisible. `windowStartSkipped`
   also covers the silent-skip case from §2.1, which produced no log signal at all.
2. **`sync.continuation.conflict`** (level 40) fires when the stored point is later than `windowTo`
   and was therefore dropped. It is deliberately *not* emitted for the mid-window pagination case,
   which happens on every repeat import and would drown the signal.
3. **`sync.failed` now carries `stage`** (`"client" | "fetch" | "persist"`), derived from the last
   `sync.<stage>.<phase>` event. Previously the only hints that nothing reached the network were
   `causeChain: []`, `httpStatus: null`, and a 3 ms duration.
4. `sync.fetch.completed` also records `continuationAfterFetch`, which can differ from the
   persisted `continuationAfter` because of the monotonic rule in §3.
5. **Reading the log** needs no new dependency:

   ```sh
   grep '"event"' api.log | jq -c '{t:(.time/1000|todate), run:.syncRunId, e:.event, msg:.message}'
   ```

## 5. Unrelated observation: `hasMore` over-reports

After run 5, the high-water mark equalled "now", so nothing remained to fetch — yet the response
reported `hasMore: true`. The heuristic in `src/sync.ts` string-compares a full timestamp against a
date-only window end:

```ts
const hasMore = newContinuationPoint !== undefined && newContinuationPoint < options.windowTo;
// "2026-08-10T15:32:59.989017+00:00" < "2026-08-31"  ->  true
```

The UI therefore advised clicking Import again, which would spend export quota for no new invoices.
Not the cause of the reported failure, and not addressed by this fix.
