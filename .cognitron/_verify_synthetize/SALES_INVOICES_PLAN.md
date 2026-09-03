# KSeF Exporter — Sales Invoices (`Subject1`): Ingestion & Revenue Reporting

**Last updated:** 2026-08-27 21:50 CEST

**Status:** Complete. Stages 0–5: reconnaissance, documentation, the schema migration, the
`invoice_kind` backfill, the direction-aware sync engine, the API, and the Purchases/Sales
UI toggle are all implemented, tested, and applied to both live tenant databases. Stage 6
(historical sales backfill) has been run against both tenants for 2026-05-01 → 2026-08-27.

**Companion to** [`SPEC.md`](./SPEC.md) and
[`INVOICE_TYPES_ANALYSIS.md`](./INVOICE_TYPES_ANALYSIS.md). Like
[`INVOICE_ITEMS_PLAN.md`](./INVOICE_ITEMS_PLAN.md) and
[`IMPORT_OBSERVABILITY_PLAN.md`](./IMPORT_OBSERVABILITY_PLAN.md), this is a companion
workstream: it does **not** renumber the phases in
[`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md). Phase 8 (manual entry) remains the
next numbered phase and Phase 9 remains deferred.

**Audience:** Developers / AI coding agents. Self-contained — every fact needed is here.

---

## 1. Purpose

The application pulls only purchase invoices. Revenue has therefore been tracked outside
the system entirely — [`SPEC.md`](./SPEC.md) recorded this as *"Turnover/revenue figures
are tracked separately, outside this system."* That was an inherited assumption, not a
considered decision, and it means the owner cannot see cost and revenue in one place.

This workstream ingests sales invoices (KSeF `Subject1`, where the tenant is the seller)
into the existing `invoices` table behind a stored `direction` column, and lets the UI show
either direction.

### In scope

- A `direction` column on `invoices`, plus the `invoice_kind` column
  [`INVOICE_TYPES_ANALYSIS.md`](./INVOICE_TYPES_ANALYSIS.md) §6 already proposed — both in
  **one** migration, because both require the same table rebuild.
- Parameterising the subject type through the KSeF fetch, the sync engine, and the API.
- A second continuation point, which `sync_state` already supports.
- Sales invoices bypassing categorization entirely.
- A Purchases/Sales toggle on the existing Invoices screen, with per-direction totals.
- A historical backfill of sales invoices.

### Explicitly out of scope

- **VAT reconciliation.** No `net_total`/`vat_total` columns, no per-rate VAT child table,
  no JPK export. Only `gross_total` is stored today and that does not change here.
- **Categorizing sales invoices.** See §4.2.
- **Changing the reporting period.** See §4.4.
- **Netting sales corrections into their originals.** §9 of the analysis measured only two
  `KOR` documents, both with *positive* totals. That is too little to build arithmetic on.
- **A correction-to-original foreign key.** Still deferred, both directions.
- **`invoice_kind` UI semantics.** The column is added and backfilled; filtering or badging
  by document kind stays deferred.
- **Syncing both directions in one trigger.** See §4.3.

---

## 2. Current state

### 2.1 What already works unchanged

Measured, not assumed — see [`INVOICE_TYPES_ANALYSIS.md`](./INVOICE_TYPES_ANALYSIS.md) §9:

- **The KSeF token already authorises `Subject1`.** No permission or token change.
- **The parser is already direction-agnostic.** All 39 sampled sales invoices parsed with
  zero errors through `parsePurchaseInvoiceXml` unmodified. Only its *name* is misleading.
- **`sync_state` is already keyed by subject type** —
  [`src/db/schema.ts`](../src/db/schema.ts) declares `subjectType` as the primary key, so a
  second continuation point needs no migration.
- **The SDK imposes nothing.** `ksef-client` types `subjectType` as a bare `string`; the
  restriction to `Subject2` is this project's, in three lines of our own code.
- **`invoices` already stores `buyerNip` and `buyerName`**, which is the counterparty for a
  sales invoice.
- `invoice_items`, `RecentImports`, and `InvoiceItemsTable` are direction-agnostic.

### 2.2 What is hardcoded to `Subject2`

| Location | Form |
| --- | --- |
| [`src/ksef/invoices.ts`](../src/ksef/invoices.ts#L8) | `const PURCHASE_INVOICE_SUBJECT_TYPE = "Subject2"` |
| [`src/sync.ts`](../src/sync.ts#L23) | `const SUBJECT_TYPE = "Subject2"` |
| [`src/api/server.ts`](../src/api/server.ts#L154) | literal `"Subject2"` |
| [`src/ksef/dump-invoices.ts`](../src/ksef/dump-invoices.ts) | **already parameterised** in Stage 0 |

### 2.3 The gap, stated precisely

Four things are missing, and one of them is not obvious:

1. `invoices` has no `direction` column; direction is implied by the hardcoded constant.
2. `sync_runs` has no `subject_type` column, so a run cannot say which direction it synced.
3. `listInvoices` filters on month and category only, so the moment sales rows land, every
   existing total silently changes meaning.
4. **The non-obvious one.** `categorizationConfidence` is `NOT NULL DEFAULT 'needs_review'`
   with `CHECK IN ('matched','needs_review')`. Sales invoices are not categorized, so
   without a third value every one of them would land in the owner's review queue.

---

## 3. Measured data

See [`INVOICE_TYPES_ANALYSIS.md`](./INVOICE_TYPES_ANALYSIS.md) §9 for the full table. The
five facts that drive this plan:

- 39 sales invoices across 90 days (parkowa 5, portowa 34) against 779 stored purchases —
  **low volume**, so the backfill is cheap.
- Seller NIP equalled the tenant NIP on **39/39** — direction is checkable after the fact.
- Zero parse failures with the existing parser.
- Zero KSeF-number collisions with stored purchases.
- Both sales `KOR` documents had *positive* totals, unlike purchase corrections.

---

## 4. Design decisions

### 4.1 One table plus a `direction` column

Sales invoices are the same document shape, need the same line items, the same dedup, and
the same browsing UI. A separate table would duplicate all of it.
[`INVOICE_TYPES_ANALYSIS.md`](./INVOICE_TYPES_ANALYSIS.md) §8 Q3 anticipated exactly this
and asked that `direction` ship in the same migration as `invoice_kind`. It does.

`direction` is written from the subject type that fetched the invoice — not inferred by
comparing NIPs. The NIP identity measured in §9.4 is an *integrity check* available later,
not the source of truth.

### 4.2 Sales invoices are never categorized

The categories are cost categories, and Tier-1 rules match on the **seller**
([`src/categorization/engine.ts`](../src/categorization/engine.ts)). On a sales invoice the
seller is the tenant itself, so the first human correction would create one rule that
matches every sales invoice the company will ever issue
([`src/categorization/correct.ts`](../src/categorization/correct.ts) upserts a rule keyed on
seller NIP or name).

Therefore: sales invoices skip `categorize()` entirely, store `category_id = NULL`, and
carry a new confidence value **`not_applicable`**. They must never reach
`correctInvoiceCategory`, and the UI must not offer the correction control on them.

The alternative — filtering needs-review reads by direction — was rejected because it
leaves the intent implicit in every query instead of stated once in the data.

### 4.3 One direction per sync trigger

`POST /invoices/exports` is capped at 20/hour **per subject type**, so a second stream gets
its own budget rather than halving the existing one. But `syncPurchaseInvoices` already
defaults `maxIterations` to 1 precisely because the SDK's default of 20 caused a real
production rate-limit incident (`SPEC.md` §3.3).

So: a sync call takes one direction and does at most one export-init request for it. The UI
triggers them separately. `maxIterations` stays **1 per direction** — do not "helpfully"
sync both in one call.

### 4.4 The reporting period stays `issue_date`

Revenue arguably belongs to the sale date rather than the issue date, and
[`INVOICE_TYPES_ANALYSIS.md`](./INVOICE_TYPES_ANALYSIS.md) §8 Q5 raises exactly that. It is
**an explicit non-goal here.** Switching would silently change every month total the owner
has already looked at, in both directions, and that needs its own sign-off — it is not a
side effect of adding sales invoices.

---

## 5. Implementation plan

### Step 0 — Reconnaissance ✅ complete (2026-08-23)

`DUMP_SUBJECT_TYPE` added to [`src/ksef/dump-invoices.ts`](../src/ksef/dump-invoices.ts);
both tenants sampled; findings in `INVOICE_TYPES_ANALYSIS.md` §9. The permission gate that
could have stopped this workstream is closed.

### Step 1 — Documentation

Retire the purchase-only invariant everywhere it is asserted:
[`SPEC.md`](./SPEC.md) §2.5/§3/§5, `.github/copilot-instructions.md`,
[`KSEF_INTEGRATION_REFERENCE.md`](./KSEF_INTEGRATION_REFERENCE.md),
[`INVOICE_TYPES_ANALYSIS.md`](./INVOICE_TYPES_ANALYSIS.md) §6/§8, and a companion pointer in
[`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md).

### Step 2 — Schema: one migration

In [`src/db/schema.ts`](../src/db/schema.ts), against the `invoices` table:

| Column | Type | Constraint |
| --- | --- | --- |
| `direction` | `TEXT NOT NULL DEFAULT 'purchase'` | `CHECK (direction IN ('purchase','sales'))` |
| `invoice_kind` | `TEXT` nullable | `CHECK (invoice_kind IS NULL OR invoice_kind IN ('VAT','KOR','ZAL','ROZ','UPR','KOR_ZAL','KOR_ROZ'))` |
| `categorization_confidence` | unchanged type | CHECK extended with `'not_applicable'` |

And against `sync_runs`: `subject_type TEXT` **nullable**. Existing rows genuinely predate
the concept; backfilling them to `'Subject2'` would assert knowledge we do not have.

The `DEFAULT 'purchase'` is what makes every existing row correct without a data migration.

`invoice_kind` is nullable and backfilled separately in Step 2b, so a backfill bug cannot
compromise the migration.

**Status: done (2026-08-23).** Applied as
[`0009_hesitant_kat_farrell.sql`](../drizzle/migrations/0009_hesitant_kat_farrell.sql) to
both tenant databases via `createDb()`, following the migration protocol in §6 exactly.
Verification on both the `VACUUM INTO` trial copies and the real files: `invoices`
count/sum and `invoice_items` count (the cascade canary) unchanged, zero `foreign_key_check`
violations, `integrity_check` clean. Every existing row now has `direction = 'purchase'`
and `invoice_kind`/`subject_type` `NULL`, as intended. `pnpm test` 227/227, `pnpm run
typecheck` clean.

**A real drizzle-kit codegen bug was found and worked around — read this before touching
this migration again or generating a new one against a table with `CHECK` constraints.**
Once a SQLite table has any `CHECK` constraint, `drizzle-kit generate` fully rebuilds it
(drop + recreate + rename) for *any* change to that table, even a plain new nullable
column with only a self-referencing `CHECK` — splitting the change into two migrations
does not avoid this. The generated rebuild's `INSERT INTO __new_t (...) SELECT (...) FROM
t` then references the brand-new columns **by name** in the `SELECT` half, where they do
not exist yet in the pre-migration table (`no such column: direction`). Since this repo
forbids hand-editing a generated migration, the fix was: `drizzle-kit generate --custom`
for a tool-sanctioned empty file, but its accompanying snapshot is stale (carried forward
unchanged rather than diffed against `schema.ts`); a throwaway ordinary `db:generate` run
was used purely to obtain a correct snapshot (its buggy SQL was discarded), which was then
paired with hand-written SQL — identical to drizzle-kit's own rebuild, with only the new
columns' `SELECT`-list entries replaced by literal defaults/`NULL` — under one matching
migration tag. A follow-up `db:generate` reporting "No schema changes" confirmed the
schema, migration, and snapshot were all consistent before it was trialled or applied.

### Step 2b — Backfill `invoice_kind`

Offline, from `invoices.raw_xml`, no KSeF calls — mirroring
[`src/invoices/backfill-items.ts`](../src/invoices/backfill-items.ts). The extraction must
tolerate `<RodzajFaktury>`, `<ns0:RodzajFaktury>`, and `<tns:RodzajFaktury>`; all three
prefix styles occur in the live data. Dry-run first.

**Status: done (2026-08-27).** Implemented as
[`extractInvoiceKind`](../src/ksef/invoice-parser.ts) (raw, unvalidated extraction — the
namespace-prefix tolerance above turned out to already be free: the parser is configured
with `removeNSPrefix: true`, so all three prefix styles normalize to the same field before
any extraction code runs), [`updateInvoiceKind`](../src/db/invoices.ts), and
[`backfillInvoiceKind`](../src/invoices/backfill-invoice-kind.ts) plus its CLI wrapper
(`pnpm run backfill:invoice-kind`). An invoice with no `RodzajFaktury` is skipped
(non-fatal); one with a value outside the 7 XSD kinds is failed (non-fatal), since the
column has a CHECK constraint. Dry-run against both live tenants first (parkowa 249/249,
portowa 530/530 eligible, zero skipped/failed), then a `VACUUM INTO` backup of each
(`data/backup/pre-invoice-kind-backfill/{parkowa,portowa}.sqlite`), then applied for real:
both tenants now report zero remaining `invoice_kind IS NULL` rows. Resulting distribution:
parkowa VAT 228 / KOR 20 / ROZ 1; portowa VAT 504 / KOR 26. `pnpm test` 235/235 (8 new),
`pnpm run typecheck` clean.

### Step 3 — Sync ✅ complete (2026-08-27)

- [`src/ksef/invoices.ts`](../src/ksef/invoices.ts): take the subject type as a parameter.
- [`src/sync.ts`](../src/sync.ts): accept a direction, map it to a subject type, use that
  subject type for both the continuation-point read and write, and pass `direction` to the
  insert. Keep `maxIterations` defaulting to 1.
- [`src/db/invoices.ts`](../src/db/invoices.ts): persist `direction` on insert; add a
  `direction` filter to `listInvoices`.
- [`src/db/sync-runs.ts`](../src/db/sync-runs.ts): record the subject type.
- Categorization bypass per §4.2.

Implemented as specified; sales invoices skip `categorize()` entirely and land with
`categorizationConfidence: "not_applicable"` and `categoryId: null`. Each direction keeps
its own continuation point in `sync_state`, verified independent in tests.

### Step 4 — API ✅ complete (2026-08-27)

- `GET /invoices` accepts a validated `direction` query parameter.
- `POST /sync` accepts a `direction` body field, one direction per call (§4.3).
- [`src/api/server.ts`](../src/api/server.ts#L154)'s literal `"Subject2"` follows the
  requested direction.
- `GET /sync/runs` surfaces the subject type.

Implemented as specified, including validation rejecting an invalid `direction` on both
routes.

### Step 5 — UI ✅ complete (2026-08-27)

- [`web/src/api/client.ts`](../web/src/api/client.ts): direction parameter and a `direction`
  field on the `Invoice` type.
- [`web/src/App.tsx`](../web/src/App.tsx): a Purchases/Sales toggle on the Invoices screen —
  not a new navigation item.
- [`web/src/components/InvoicesSummary.tsx`](../web/src/components/InvoicesSummary.tsx):
  totals for the selected direction only.
- [`web/src/components/InvoicesTable.tsx`](../web/src/components/InvoicesTable.tsx): no
  category cell or correction control on sales rows.
- [`web/src/components/SyncButton.tsx`](../web/src/components/SyncButton.tsx):
  direction-aware trigger.

Implemented as specified. `InvoicesSummary.tsx` needed no change — it already recomputes
from whatever `invoices` array it's given, so the direction filter upstream is sufficient.
Backend `pnpm test` 247/247, frontend `pnpm --dir web test` 49/49, both typecheck and
`pnpm run lint` clean (Stages 3–5 committed as `ef30f96`, `66113da`, `64d860d`).

### Step 6 — Historical sales backfill

Windowed pulls, one direction at a time, respecting the 20/hour export-init budget. Run by
a human against real tenants after Step 5 ships.

[`src/tools/backfill-invoices.ts`](../src/tools/backfill-invoices.ts) (`pnpm run backfill:invoices`)
drives this: it repeatedly calls `syncPurchaseInvoices(..., { direction: "sales" })` against
the live database named by `DATABASE_PATH`/`.env`, recording a `sync_runs` row per call
(mirroring `POST /sync`'s bookkeeping exactly). One tenant per invocation — `.env` selects
which.

**Three things discovered only by running this live, none previously documented:**

1. **KSeF's export query rejects a `filters.dateRange` wider than 3 months** — surfaces as
   a client-side `KsefValidationError` ( `Invoice query filters.dateRange cannot exceed 3
   months.` ) before any HTTP request is made, so it costs no export-init quota. Any window
   wider than 3 months must be split into ≤3-month chunks run as separate invocations.
2. **A `windowTo` at or after today never lets `hasMore` become false.** The continuation
   point KSeF returns is a "caught up as of now" watermark, not tied to query content, so
   for a live/ongoing window the loop's own stop condition never fires and it always hits
   the safety cap. Don't rely on `hasMore` to know when a backfill chunk is done — trust
   `fetchedCount`/`insertedCount` for that, and pass `BACKFILL_MAX_CALLS=1` per chunk.
3. **A stored continuation point from an unrelated prior sync silently overrides
   `windowFrom`** whenever it falls inside `[windowFrom, windowTo]` (the rule documented in
   [`SYNC_CONTINUATION_POINT_ANALYSIS.md`](./SYNC_CONTINUATION_POINT_ANALYSIS.md) §3.1) —
   with no error, it just silently skips the older history. Set
   `BACKFILL_RESET_CONTINUATION=true` before any deliberate backfill into a range that
   might already have a continuation point.

**Run log** (each row is one `BACKFILL_RESET_CONTINUATION=true BACKFILL_MAX_CALLS=1` chunk):

| Date | Tenant | Window | Result |
| --- | --- | --- | --- |
| 2026-08-27 | portowa | 2026-05-01 → 2026-06-30 | 18 fetched / 18 inserted / 0 duplicate |
| 2026-08-27 | portowa | 2026-07-01 → 2026-08-27 | 20 fetched / 19 inserted / 1 duplicate |
| 2026-08-27 | parkowa | 2026-05-01 → 2026-06-30 | 0 fetched / 0 inserted / 0 duplicate |
| 2026-08-27 | parkowa | 2026-07-01 → 2026-08-27 | 4 fetched / 4 inserted / 0 duplicate |

Final state: portowa has 40 sales invoices (2026-04-20 → 2026-08-27, including 3 from an
earlier ad hoc test sync); parkowa has 4 (2026-07-06 → 2026-07-28). Both verified directly
against the live databases after the run.

---

## 6. Migration protocol

SQLite cannot add a table-level `CHECK` via `ALTER TABLE`, so drizzle-kit will rebuild
`invoices`. **Verify the generated SQL rather than assuming its shape.** That rebuild is
the dangerous operation in this entire plan.

Rebuilding `invoices` once already destroyed 2 437 `invoice_items` rows on a trial copy:
SQLite emulates `ALTER TABLE` by drop-and-recreate, and `DROP TABLE` with foreign keys
enforced fires `ON DELETE CASCADE`. `createDb` disables the pragma **outside** the
transaction; the `PRAGMA foreign_keys=OFF` drizzle-kit writes into the migration file is a
no-op inside the migrator's transaction. Do not remove either safeguard. See
[`SCHEMA_TYPES_PLAN.md`](./SCHEMA_TYPES_PLAN.md) §8.

Order of operations:

1. Kill any `tsx watch src/api/main.ts`. A live WAL-mode writer makes copies unreliable.
2. `VACUUM INTO` a copy of **both** tenant databases — not `cp`.
3. `pnpm run db:generate`.
4. Have the **`migration-reviewer`** subagent review the generated SQL *before* it runs.
5. Apply to the copies. Compare row counts and sums for `invoices`, `invoice_items`, and
   `sync_runs`. **An unchanged `invoice_items` count is the cascade canary.**
6. Only then apply to the real files, both tenants.

There is more than one live database: `.env` is a symlink to a per-tenant env file and
`DATABASE_PATH` differs between them.

---

## 7. Tests

Mandatory, per the engineering conventions in
[`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md). No real KSeF calls.

| Area | Test |
| --- | --- |
| Schema | `direction` defaults to `'purchase'`; invalid direction rejected; invalid `invoice_kind` rejected; `not_applicable` accepted |
| Backfill | all three namespace prefixes recognised; dry-run writes nothing; resumable |
| Sync | requested subject type reaches the SDK; continuation point read and written under that subject type; two continuation points coexist in `sync_state`; `direction` persisted on insert |
| Categorization | sales bypass `categorize()` and land as `not_applicable` with `category_id` NULL; purchases unaffected |
| Repository | `listInvoices` direction filter; no filter still returns both (explicit, so the default is a decision rather than an accident) |
| API | `direction` validated on both routes; invalid value rejected; `sync_runs` exposes subject type |
| UI | toggle switches dataset; summary totals recompute per direction; sales rows expose no correction control |

---

## 8. Verification

1. `pnpm test`, `pnpm --dir web test`, `pnpm run typecheck`,
   `pnpm --dir web run typecheck`, `pnpm run lint`.
2. Migration trialled on `VACUUM INTO` copies of both tenants, with row counts and sums
   compared before and after.
3. Manual smoke: a narrow-window sales import on one tenant; confirm `direction` is stored,
   purchase categories are untouched, and the summary splits correctly.

---

## 9. Deferred follow-ups

- Persisting the tenant's own NIP and asserting seller-NIP identity as an integrity check
  (`INVOICE_TYPES_ANALYSIS.md` §8 Q1 — §9.4 showed the identity holds on 39/39).
- `invoice_kind` filtering and badging in the UI.
- Sale-date reporting periods (§4.4).
- Net/VAT storage and anything accountant-facing.
- Renaming `parsePurchaseInvoiceXml`, which is now misleadingly named but correct.

---

## 10. Executing this plan with parallel agents

Following [`INVOICE_ITEMS_PLAN.md`](./INVOICE_ITEMS_PLAN.md) §10. The binding constraint is
**shared files**, not logic.

### 10.1 Ownership

| Step | Owns (exclusive write) | Depends on |
| --- | --- | --- |
| **2** Schema | [`src/db/schema.ts`](../src/db/schema.ts), `drizzle/migrations/0009_*.sql` | — |
| **2b** Kind backfill | `src/invoices/backfill-kind.ts` + test, `src/tools/*`, `package.json` | 2 |
| **3** Sync | [`src/sync.ts`](../src/sync.ts), [`src/ksef/invoices.ts`](../src/ksef/invoices.ts), [`src/db/invoices.ts`](../src/db/invoices.ts), [`src/db/sync-runs.ts`](../src/db/sync-runs.ts) + their tests | 2 |
| **4** API | [`src/api/server.ts`](../src/api/server.ts) + test | 2, 3 |
| **5** UI | `web/**` | response shapes only |

**Collision resolved:** `src/db/invoices.ts` is wanted by Step 3 (insert) and Step 4 (list
filter). **Step 3 owns it outright**, including the `listInvoices` filter; Step 4 touches
only `server.ts`. This mirrors how `INVOICE_ITEMS_PLAN.md` §10.2 resolved `server.ts`.

### 10.2 Schedule

```
Wave A   2 Schema   ·   5 UI                 (2 concurrent)
Wave B   3 Sync                              (needs 2)
Wave C   4 API      ·   2b Kind backfill     (2 concurrent)
Wave D   integration, real-database migration, §8 verification
```

`web/` imports no backend code and its tests mock `fetch`, so Step 5 can be built against
the documented response shapes before the endpoint exists.

### 10.3 Which subagent does what

| Agent | Role |
| --- | --- |
| `runner` | Routine build/lint/typecheck/test passes between waves |
| `db-inspector` | Read-only live-database measurement and before/after comparisons |
| `migration-reviewer` | **Mandatory** on the Step 2 generated SQL |
| `sync-rate-limit-reviewer` | **Mandatory** on the Step 3 diff |
| `failure-diagnoser` | Root-causing any runner failure |

Agents run **focused tests only**; the coordinator runs full validation at each wave
boundary.

### 10.4 Never delegated, always user-confirmed

`db:generate`, `migrate`, `dump:invoices`, `smoke:*`, non-dry-run backfills, `dev:api` /
`start:api`, and any `git push` / `commit --amend` / `reset --hard`. Never let a concurrent
agent run `db:generate` — drizzle-kit races on `drizzle/migrations/meta/`.
