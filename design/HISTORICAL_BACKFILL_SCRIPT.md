# Historical invoice backfill script

*Created: 2026-08-28 20:17 CEST · Updated: 2026-09-03 18:02 CEST*

Reference doc for `src/tools/backfill-invoices.ts` (`pnpm run backfill:invoices`): what it does,
how to control its scope, and why it exists alongside the normal "Import invoices" button
in the web UI instead of replacing it.

## 1. What the script is for

`POST /sync` (the API endpoint behind the UI's Import button) is designed for **routine,
incremental** imports: "fetch whatever's new since last time." The script exists for the
opposite case — a **deliberate, one-off historical fetch** for an explicit date range,
typically because:

- a tenant's data has a gap that predates when its regular sync started (e.g. onboarding a
  new tenant and wanting invoices from before the app existed for them), or
- a specific range needs re-fetching (e.g. after discovering invoices were missed).

It was originally written for the Subject1 (sales) historical backfill in
[SALES_INVOICES_PLAN.md](SALES_INVOICES_PLAN.md) Step 6, then generalized (2026-08-28) to
also cover Subject2 (purchase) backfills, since both hit the exact same hazards below, then
(2026-09-03) to run both directions by default in one invocation.

## 2. Why the UI import button can't do this

The UI's "Import invoices" button (`web/src/components/SyncButton.tsx`) and the script both
ultimately call the same `syncPurchaseInvoices()` (`src/sync.ts`), but the UI wraps it with
choices appropriate for routine use, not historical backfills:

| Capability                               | UI button                 | Script                                    |
| ---------------------------------------- | ------------------------- | ----------------------------------------- |
| Reset the stored continuation point      | No                        | Yes (`BACKFILL_RESET_CONTINUATION=true`)  |
| Repeat calls automatically until done    | No — one click = one call | Yes, paced loop with a safety cap         |
| Pacing between repeated calls            | N/A (manual clicks)       | Fixed 3s delay                            |
| Runs without a logged-in browser session | No                        | Yes (CLI, uses `.env`/`APP_ENV` directly) |

The blocking issue is the **first row**. A stored continuation point (`sync_state`) that
falls inside the requested window silently overrides `windowFrom` — see
[SYNC_CONTINUATION_POINT_ANALYSIS.md](SYNC_CONTINUATION_POINT_ANALYSIS.md) §3.1. Concretely:
if a tenant's purchase sync has already advanced to `2026-08-10`, clicking Import with
`windowFrom=2026-06-01` in the UI does **not** fetch June — KSeF is asked for
`from: 2026-08-10` regardless of what the UI shows, because that's what the stored
continuation point resolves to. There is no button, field, or endpoint to clear that
stored point; it's a direct `sync_state` write (`setContinuationPoint(db, subjectType,
null)`), which only the script (or a manual DB edit) can do. Without clearing it first, a
historical gap that lies *before* an already-advanced continuation point is simply
unreachable through the UI, no matter what dates are typed into the picker.

The other rows are secondary conveniences, not hard blockers, but they matter in practice:
a real backfill can take anywhere from one call to the 15-call safety cap, each one a real
network request against a tight quota (16/min, 20/hour per subject type — see
`.github/copilot-instructions.md`). Doing that by hand — click, wait, read the "click
Import again" hint, click again, 15 times, without fat-fingering a window date in between —
is both tedious and exactly the kind of manual repetition that risks an accidental rapid
double-click blowing through the per-minute limit. The script paces itself and stops at a
safety cap unconditionally, so a single invocation can't exhaust the hourly budget even if
the whole range needs every one of the 15 calls.

## 3. How it works

One invocation:

1. Reads `windowFrom`/`windowTo`/`direction` from environment variables (see §4).
2. Optionally clears the stored continuation point for that direction's subject type
   (`BACKFILL_RESET_CONTINUATION=true`).
3. Loops, calling `syncPurchaseInvoices(db, client, { windowFrom, windowTo, direction })`
   with `maxIterations: 1` (one KSeF export page per call — unchanged from the API's own
   default, see `src/sync.ts`), up to `BACKFILL_MAX_CALLS` times (default 15), with a fixed
   3-second delay between calls.
4. Each call creates its own `sync_runs` row and records the same success/error diagnostics
   `POST /sync` would (`fetchedCount`, `insertedCount`, `duplicateCount`, `hasMore`, etc.),
   so every run shows up in the UI's Recent Imports exactly like a normal sync.
5. Stops early once a call reports `hasMore: false` — otherwise stops at the call cap and
   prints a warning that more data may still be available.
6. New invoices are inserted; anything already in the DB (matched by KSeF number) is
   silently skipped as a duplicate, so re-running the script over a range it already
   partially covers is always safe — it never overwrites or duplicates existing rows.

Because it reuses `syncPurchaseInvoices` unchanged, every existing hazard/mitigation the
sync engine has (categorization, item extraction, error classification, rate-limit
messages) applies exactly as it does for the UI/API path. The script adds nothing new to
that pipeline; it only adds the ability to point it at an arbitrary historical window with
an explicit continuation reset and an unattended repeat loop.

## 4. Controlling the scope

All control is via environment variables, read once at startup:

| Variable                      | Required | Meaning                                                                                                                                                                                           |
| ----------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BACKFILL_WINDOW_FROM`        | yes      | Start of the range, inclusive, `YYYY-MM-DD`.                                                                                                                                                      |
| `BACKFILL_WINDOW_TO`          | yes      | End of the range, inclusive, `YYYY-MM-DD`.                                                                                                                                                        |
| `BACKFILL_DIRECTION`          | no       | `both` (**default**, runs purchase then sales), `purchase` (Subject2 only), or `sales` (Subject1 only).                                                                                           |
| `BACKFILL_RESET_CONTINUATION` | no       | `true` to clear the stored continuation point for every direction being run before its first call. See §2 — required whenever the window's start lies behind an already-advanced continuation point. |
| `BACKFILL_MAX_CALLS`          | no       | Safety cap on repeated calls (default 15). Lower it (e.g. to `1`) to make exactly one careful call — see §5.                                                                                      |

Which **tenant** is affected is not a script flag at all — it follows the same env-file
selection as everything else in the repo (`APP_ENV=<tenant>`, see `README.md` "Selecting an
env file"). Example, filling a historical gap for `parkowa`'s purchase invoices:

```sh
BACKFILL_DIRECTION=purchase \
BACKFILL_WINDOW_FROM=2026-06-01 \
BACKFILL_WINDOW_TO=2026-08-31 \
BACKFILL_RESET_CONTINUATION=true \
APP_ENV=parkowa pnpm run backfill:invoices
```

Each run only ever touches **one tenant**, but backfills both directions by default: since
purchase and sales each keep their own continuation point and their own independent KSeF
export-init quota, the script runs purchase's full paced call loop and then sales's,
one after another, and neither can push the other over its budget. Set `BACKFILL_DIRECTION`
to `purchase` or `sales` to backfill only one. To backfill a second tenant, run the script
again with a different `APP_ENV`.

## 6. Related docs

- [SALES_INVOICES_PLAN.md](SALES_INVOICES_PLAN.md) — original Subject1 backfill plan and
  run log this script was written for.
- [SYNC_CONTINUATION_POINT_ANALYSIS.md](SYNC_CONTINUATION_POINT_ANALYSIS.md) — the
  continuation-point-overrides-`windowFrom` mechanics referenced in §2.
- `.github/copilot-instructions.md` — the repo-wide KSeF rate-limit and `maxIterations`
  ground rules this script (and `src/sync.ts`) both follow.
