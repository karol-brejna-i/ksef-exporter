# KSeF Exporter — Expanding Extracted Invoice Attributes: Context & Execution Plan

**Created:** 2026-08-28 09:09 CEST · **Updated:** 2026-08-28 09:25 CEST

**Status:** Planning. Nothing in §5 is implemented yet. This document exists to brief a
future agent (or a set of parallel subagents) on the *next* round of "read more of the
XML, store it, show it" work, using everything already learned from doing this twice
before (line items, then `invoice_kind`/`direction`).

**Companion to** [`SPEC.md`](./SPEC.md), [`INVOICE_ITEMS_PLAN.md`](./INVOICE_ITEMS_PLAN.md)
(line items — implemented), [`INVOICE_TYPES_ANALYSIS.md`](./INVOICE_TYPES_ANALYSIS.md) (the
field-by-field measurement this plan's scope is drawn from), and
[`SCHEMA_TYPES_PLAN.md`](./SCHEMA_TYPES_PLAN.md) (temporal-column rules). **This document
does not require reading any of them** — every fact an executing agent needs is inlined
below. They're linked for a human who wants the full derivation.

**Audience:** Developers / AI coding agents, including subagents dispatched to work on a
slice of this in parallel.

---

## 1. The goal, precisely

Today `invoices` stores 15 columns per document (see §3). The XML behind every one of
them (`raw_xml`, retained on 100% of rows in both tenants) carries dozens more fields that
are parsed by nothing and shown nowhere. The goal is the same shape of work as the two
prior workstreams that closed this gap for line items and for document type:

1. Pick a field (or small group of related fields) still sitting unread in `raw_xml`.
2. Add a nullable column (or child table) for it.
3. Parse it, optionally — never throw on its absence.
4. Backfill it into the invoices already stored (**no new KSeF calls**; see §4).
5. Surface it through the API and the UI.

This document's §6 lists the concrete field candidates already measured and ranked by
value, so "expand attributes" has a menu to start from rather than a blank page. But the
**process** in §7 generalizes to any future field this application decides to read next —
that's the more durable part of this document.

---

## 2. The enabling fact, restated

Both tenant databases retain the complete invoice XML in `invoices.raw_xml` for every
row that has one (100% in both tenants — 249/249 parkowa, 530/530 portowa as of the last
measurement). **Every field discussed in this document is already sitting on disk.**
Adding a new extracted attribute therefore requires:

- **Zero KSeF API calls.** No `POST /invoices/exports`, no export quota consumed (the
  tightest limit in the whole integration — 16/min, 20/hour, and the cause of a real
  production incident; see `SPEC.md` §3.3). This is a pure parse-and-project change.
- **Zero re-import.** The backfill re-derives new columns from the already-stored XML,
  exactly like [`src/invoices/backfill-invoice-kind.ts`](../src/invoices/backfill-invoice-kind.ts)
  and [`src/invoices/backfill-items.ts`](../src/invoices/backfill-items.ts) already do.
- **No risk to live KSeF rate limits, continuation points, or sync windows.** Those
  hazards (documented at length in `SYNC_CONTINUATION_POINT_ANALYSIS.md` and this
  session's work on `SALES_INVOICES_PLAN.md` Stage 6) are **not in scope here** — nothing
  in this plan calls `syncPurchaseInvoices` against KSeF. Do not conflate "backfill" in
  this document (offline, re-parses stored XML) with the sales-invoice historical
  backfill (online, calls KSeF) — they share a name but not a risk profile.

---

## 3. Current schema and pipeline (as of 2026-08-28)

### 3.1 `invoices` table columns today

```
id, source ('ksef'|'manual'), direction ('purchase'|'sales'),
ksef_number (unique, nullable), invoice_number, invoice_kind (nullable,
7-value enum), seller_nip, seller_name, buyer_nip, buyer_name,
issue_date, gross_total REAL, currency, raw_xml,
items_extracted_at, category_id, categorization_confidence, created_at
```

`invoice_kind` and `direction` are the two most recently added columns (2026-08 sessions)
— they are the freshest working precedent for "add a header field the same way again."
`invoice_items` (a full child table, 25 columns) is the precedent for "this needs more
than a scalar column."

### 3.2 The six-stage pipeline every extracted field flows through

```
   XML (raw_xml, already stored)
        │
        ▼
1. PARSE      src/ksef/invoice-parser.ts     — optional extraction fn, never throws
        │
        ▼
2. TYPE       src/db/invoices.ts / src/ksef/invoice-parser.ts  — TS interface field
        │
        ▼
3. SCHEMA     src/db/schema.ts + drizzle/migrations/  — nullable column + CHECK
        │
        ├──────────────► 4a. BACKFILL   src/invoices/backfill-*.ts + src/tools/backfill-*.ts
        │                 (offline, re-derives the column for the 779 already-stored rows)
        │
        └──────────────► 4b. NEW IMPORTS  src/sync.ts → src/db/invoices.ts insert path
                          (automatic once 1–3 are done — every future sync call
                          persists the new field with no further wiring)
        │
        ▼
5. API        src/api/server.ts             — the field rides along in `listInvoices()`'s
        │                                      result; add it to any response validation
        │                                      only if one exists (there mostly isn't —
        │                                      see §7.6)
        ▼
6. UI         web/src/api/client.ts (manually duplicated TS type!)
              web/src/components/InvoicesTable.tsx (or a new component)
```

Concretely, per file:

| Stage                              | File                                                                                                                                                                                                   | What lives there today                                                                                                                                                                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Parse                              | [`src/ksef/invoice-parser.ts`](../src/ksef/invoice-parser.ts)                                                                                                                                          | `parsePurchaseInvoiceXml()` (required header fields, throws on missing), `extractInvoiceKind()` / `extractInvoiceItems()` (optional, never throw), `parseInvoiceFaElement()` (re-derive the `Fa` element from stored XML for backfills) |
| Type                               | [`src/db/invoices.ts`](../src/db/invoices.ts)                                                                                                                                                          | `InvoiceRow`, `InvoiceKind`, `INVOICE_KIND_VALUES`, `InvoiceDirection`                                                                                                                                                                  |
| Schema                             | [`src/db/schema.ts`](../src/db/schema.ts)                                                                                                                                                              | Drizzle `sqliteTable("invoices", …)`, all CHECK constraints                                                                                                                                                                             |
| Persistence                        | [`src/db/invoices.ts`](../src/db/invoices.ts)                                                                                                                                                          | `insertKsefInvoiceIfNotExists()`, `listInvoices()`, `updateInvoiceCategory()`, `updateInvoiceKind()`                                                                                                                                    |
| Backfill precedent (scalar column) | [`src/invoices/backfill-invoice-kind.ts`](../src/invoices/backfill-invoice-kind.ts) + [`src/tools/backfill-invoice-kind.ts`](../src/tools/backfill-invoice-kind.ts) (`pnpm run backfill:invoice-kind`) | Resumable (`WHERE column IS NULL` unless `--force`), dry-run flag, per-row success/skip/fail, offline                                                                                                                                   |
| Backfill precedent (child table)   | [`src/invoices/backfill-items.ts`](../src/invoices/backfill-items.ts)                                                                                                                                  | Same shape, one-to-many insert instead of one column                                                                                                                                                                                    |
| Orchestration                      | [`src/sync.ts`](../src/sync.ts)                                                                                                                                                                        | `syncPurchaseInvoices()` — fetch → persist → categorize; untouched by this workstream unless a new field needs to influence categorization (it should not, see §8)                                                                      |
| API                                | [`src/api/server.ts`](../src/api/server.ts)                                                                                                                                                            | `GET /invoices` returns `listInvoices()`'s rows essentially as-is (no separate response DTO/mapper to update in most cases — verify per field)                                                                                          |
| API client type                    | [`web/src/api/client.ts`](../web/src/api/client.ts)                                                                                                                                                    | `export interface Invoice { … }` — **hand-maintained, not generated from the backend type.** Every new field needs this interface updated too, or the UI won't see it even though the API returns it.                                   |
| UI table                           | [`web/src/components/InvoicesTable.tsx`](../web/src/components/InvoicesTable.tsx)                                                                                                                      | Columns: Date / Seller / Amount / Category / Status, direction-aware rendering already present                                                                                                                                          |
| UI detail/expand precedent         | [`web/src/components/RecentImports.tsx`](../web/src/components/RecentImports.tsx)                                                                                                                      | `<details><summary>` pattern for "more info without a new page" — reuse for anything that doesn't deserve a whole new column                                                                                                            |

---

## 4. Hard-won conventions and hazards (apply to every field you add)

Each of these has already caused a real bug, a real data-loss near-miss, or a real
production incident in this repo. They are not theoretical style preferences.

1. **A field is either "required header" (throws on absence) or "supplementary"
   (nullable, never throws).** The seven original header fields (KSeF number, seller
   NIP/name, `P_2`, `P_1`, `P_15`, `KodWaluty`) earn a hard failure in
   `parsePurchaseInvoiceXml` because a financial record is *wrong* without them. **Every
   field this document is about is supplementary.** Parse it in a separate, optional
   function (`extractInvoiceKind`-style), and an absent or malformed value must yield
   `null`, never an `InvoiceParsingError`. A backfill or import must never fail an entire
   invoice because one optional field couldn't be read.

2. **Decide TEXT-vs-numeric per field by its XSD type, not by what the values look
   like.** `P_12` (VAT rate) looks numeric (`23`, `8`, `5`...) but is `TStawkaPodatku`, an
   enumerated *string* that also legally contains `"zw"`, `"oo"`, `"np I"`, `"0 WDT"` —
   live data already has `"zw"` on 19 rows. A numeric column would silently corrupt those.
   The same trap applies to any new field: check the XSD type
   (`node_modules/ksef-client/**/schemat_FA(3)_v1-0E.xsd` — search for the element name)
   before assuming a percentage-looking or amount-looking field is safe as `REAL`.

3. **Repeated elements need a document-order `ordinal`, never a "natural key."**
   `FaWiersz` (line items) repeats `NrWierszaFa` on 19/249 correction invoices (before/after
   pairs). `DaneFaKorygowanej` (correction references) can repeat up to 50 000 times per
   the XSD with no field guaranteed unique. If a candidate field lives inside a repeated
   block, model it as a child table keyed on `(invoice_id, ordinal)`, not a scalar column
   or a unique constraint on any field inside the block.

4. **Civil dates are not instants — do not convert them.** `P_1` (issue date), `P_6`
   (sale/delivery date), `TerminPlatnosci/Termin` (payment due date) are all **civil
   dates**: store as `TEXT YYYY-MM-DD` with the existing `ISO_DATE_GLOB` CHECK pattern in
   `src/db/schema.ts`, and never run them through `new Date()` or an epoch-ms column.
   Converting a bare date to an instant invents a timezone and produces an off-by-one day
   at every offset boundary. This is documented at length in `SCHEMA_TYPES_PLAN.md` and is
   the single most common mistake this codebase's own history warns about.

5. **Enum-valued fields get a `CHECK` constraint against the exact known value set,
   nullable.** Follow the `invoice_kind` pattern exactly:
   ```ts
   invoiceKind: text("invoice_kind", {
     enum: ["VAT", "KOR", "ZAL", "ROZ", "UPR", "KOR_ZAL", "KOR_ROZ"],
   }),
   // ...
   check(
     "invoices_invoice_kind_enum",
     sql`${table.invoiceKind} IS NULL OR ${table.invoiceKind} IN ('VAT', 'KOR', 'ZAL', 'ROZ', 'UPR', 'KOR_ZAL', 'KOR_ROZ')`,
   ),
   ```
   Get the full legal value set from the bundled XSD, not from live data alone — live
   data may not have exercised every legal value (e.g. only 1 `ROZ` has ever been seen
   across both tenants, and `ZAL`/`UPR`/`KOR_ZAL`/`KOR_ROZ` have never occurred at all,
   yet all seven are legal and the CHECK must allow them).

6. **The migration is the single most dangerous step. Rebuild `invoices` exactly once
   per round of changes, not once per column.** SQLite emulates `ALTER TABLE ADD COLUMN`
   safely for a simple nullable column addition **without** a `CHECK` referencing it, but
   this schema puts a `CHECK` on almost every column, and drizzle-kit's response to that
   is to drop-and-recreate the whole table. `DROP TABLE` with `foreign_keys` enforced
   fires `ON DELETE CASCADE` — this already destroyed 2 437 `invoice_items` rows on a
   trial copy once. Concretely:
   - Batch every column you're adding this round into **one** migration.
   - `createDb()` (`src/db/client.ts`) disables `foreign_keys` **outside** the migration
     transaction already — do not remove that. The `PRAGMA foreign_keys=OFF` drizzle-kit
     writes *inside* the migration file is a no-op (the migrator runs in a transaction).
   - Kill any running `tsx watch src/api/main.ts` before touching a database file — a
     live WAL-mode writer makes a `cp`-based copy unreliable. Use `VACUUM INTO`, not `cp`.
   - Trial the migration on a copy of **both** tenant databases first (there are two live
     databases, not one — `data/tenants/parkowa/ksef-exporter.sqlite` and
     `data/tenants/portowa/ksef-exporter.sqlite`). Compare row counts and sums for
     `invoices`, `invoice_items`, and `sync_runs` before and after. **An unchanged
     `invoice_items` count is the cascade canary** — if it drops, the migration cascaded
     and must not be applied to the real files.
   - Have the `migration-reviewer` subagent (already defined in this repo's `AGENTS.md`)
     review the generated SQL before it touches a copy, let alone the real files.

7. **Backend and frontend types are hand-duplicated, not shared or generated.**
   `src/db/invoices.ts`'s `InvoiceRow` and `web/src/api/client.ts`'s `Invoice` interface
   describe the same JSON shape but are two independent TypeScript declarations. Adding a
   backend column and forgetting the frontend interface is a silent bug: the API will
   return the field, `fetch` will parse it into the response object at runtime, but
   nothing in the frontend's type system will let you reference it until the interface is
   updated too. Update both, in the same change.

8. **Namespace-prefix handling is already solved. Do not re-solve it.** Real invoice XML
   mixes three namespace-prefix styles (`<Faktura>`, `<tns:Faktura>`, `<ns0:Faktura>`)
   across issuers. `removeNSPrefix: true` on the shared `XMLParser` instance in
   `invoice-parser.ts` already normalizes all three to bare element names for every field
   this document discusses. Do not add per-prefix branching for a new field — if
   `asString(fa.SomeNewField)` doesn't work, the problem is the path, not the prefix.

9. **Testing is mandatory per this repo's standing rule, not optional for "just a
   backfill script."** Every new parser function, schema change, backfill script, API
   change, and UI change needs a test before the work is considered done. Run the focused
   test after the first substantive edit; run the full relevant suite
   (`pnpm test` / `pnpm --dir web test`) and both typechecks
   (`pnpm run typecheck` / `pnpm --dir web run typecheck`) plus `pnpm run lint` before
   reporting any wave complete. Unit tests must never make real KSeF network calls — none
   of this workstream needs to, since everything comes from already-stored `raw_xml`.

10. **Categorization stays header-level and seller-based, full stop.** No new field from
    this document may become a categorization input, and sales invoices
    (`direction = 'sales'`, `categorization_confidence = 'not_applicable'`) must never
    reach the correction path regardless of what new fields they gain. This is a product
    invariant repeated in `SPEC.md`, `SALES_INVOICES_PLAN.md`, and the shared
    `copilot-instructions.md` — it is not this document's call to relax.

11. **Nullable is the permanent state for `source = 'manual'` rows, not just a
    migration-time convenience.** Every field in this document comes from `raw_xml`, and
    manual entries (`source = 'manual'`) have no `raw_xml` at all — so a blanket `NOT
    NULL` can never be added to any column this document introduces, no matter how
    complete the backfill turns out to be. If a field later measures at ~100% presence
    across **KSeF-sourced** rows and the owner wants that enforced, the correct tool is a
    **conditional CHECK**, not `NOT NULL`:
    ```sql
    CHECK (source != 'ksef' OR sale_date IS NOT NULL)
    ```
    Two things to weigh before doing this, not just "presence looks high enough":
    - **Tightening a constraint is itself a migration**, subject to the exact same
      drop-and-recreate/cascade hazard as adding the column in the first place (§4.6) —
      it is not a free follow-up. Only do it in its own reviewed migration, trialled on a
      copy of both tenant databases first, same as any other schema change here.
    - **100% today does not mean 100% forever.** These are facts about issuers' XML, not
      about the schema (`ZAL`/`UPR`/`KOR_ZAL`/`KOR_ROZ` invoice kinds have *never* been
      observed in either tenant, yet are legal FA(3) values — the same absence-of-evidence
      trap applies to any field an agent might be tempted to tighten). Treat a
      conditional `NOT NULL` as a deliberate, re-reviewed decision per field, not
      something to batch into the original nullable-column migration "while we're in
      there."
    Default position: leave every column from this document nullable indefinitely unless
    a future round explicitly revisits this trade-off.

---

## 5. What is already implemented (do not redo)

- `invoice_kind` (`Fa/RodzajFaktury`, 7-value enum) — column, parser (`extractInvoiceKind`),
  backfill (`pnpm run backfill:invoice-kind`), CHECK constraint. **Not yet surfaced in the
  API response or the UI** — verify whether that's still true before assuming it needs
  parsing work; it may only need steps 6–7 of §7.
- `direction` (`purchase`/`sales`) — column, sync-time assignment, API filter, UI toggle.
  Fully shipped end-to-end (`SALES_INVOICES_PLAN.md`).
- Line items (`invoice_items`, 25 columns covering the full `FaWiersz` structure) — fully
  shipped end-to-end, including the expandable-row UI.

---

## 6. Candidate fields for this round (ranked by value, all measured against real data)

Source: `INVOICE_TYPES_ANALYSIS.md` §5, measured against both live tenant databases (249
+ 530 = 779 invoices) before any of this was implemented. Percentages are presence rates
per tenant (parkowa / portowa); re-derive rather than trust if the databases have grown
since — see §9 for the reproduction query pattern.

### 6.1 Recommended default scope — "Step 1": amounts, dates, one enum

| Column (proposed)  | XML source                              | Type                | Presence           | Note                                                                                                     |
| ------------------ | --------------------------------------- | ------------------- | ------------------ | -------------------------------------------------------------------------------------------------------- |
| `net_total`        | `Σ Fa/P_13_*` (13 buckets, see below)   | `REAL`              | derivable on ~100% | matches `gross_total`'s representation                                                                   |
| `vat_total`        | `Σ Fa/P_14_*` **excluding `*W` suffix** | `REAL`              | derivable on ~100% | see the exclusion warning below                                                                          |
| `sale_date`        | `Fa/P_6`                                | `TEXT` (civil date) | 59.4% / 59.6%      | fallback chain: `P_6` → per-line `P_6A` (already stored as `invoice_items.delivery_date`) → `issue_date` |
| `payment_due_date` | `Fa/Platnosc/TerminPlatnosci/Termin`    | `TEXT` (civil date) | 90.8% / 79.2%      | highest-value field in this list after VAT — enables an "overdue" view                                   |
| `payment_method`   | `Fa/Platnosc/FormaPlatnosci`            | `INTEGER` enum 1–7  | 54.2% / 73.6%      | `1` Gotówka, `2` Karta, `3` Bon, `4` Czek, `5` Kredyt, `6` Przelew, `7` Mobilna                          |

**Net/VAT computation, exact formula:**

```
net = P_13_1 + P_13_2 + P_13_3 + P_13_4 + P_13_5 + P_13_6_1 + P_13_6_2 +
      P_13_6_3 + P_13_7 + P_13_8 + P_13_9 + P_13_10 + P_13_11
vat = P_14_1 + P_14_2 + P_14_3 + P_14_4 + P_14_5
```

> ⚠️ **Exclude `P_14_1W`/`P_14_2W`/`P_14_3W`/`P_14_4W`.** These are the PLN-equivalent VAT
> amount for foreign-currency invoices. 17.7% of parkowa invoices emit `P_14_1W` even
> though every invoice in both tenants is `PLN` — including them double-counts VAT.
> Measured reconciliation with these excluded: `net_total + vat_total == gross_total`
> (±0.01) on **249/249 parkowa and 529/530 portowa** rows — the one portowa exception is
> a `KOR` with `gross_total = 0` and no `P_13_*` element at all; treat that shape as
> **excluded from the check**, not a mismatch.

**CHECK constraints:**
```sql
CHECK (invoice_kind IS NULL OR invoice_kind IN
  ('VAT','KOR','ZAL','ROZ','UPR','KOR_ZAL','KOR_ROZ'))  -- already exists
CHECK (payment_method IS NULL OR payment_method BETWEEN 1 AND 7)
-- sale_date / payment_due_date: reuse the existing ISO_DATE_GLOB pattern,
-- same as invoices.issue_date's own CHECK.
```

### 6.2 Second-tier candidates (do not build without an explicit ask)

| Field                    | XML source                                      | Presence                       | Why it's second-tier                                                       |
| ------------------------ | ----------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------- |
| Bank account             | `Fa/Platnosc/RachunekBankowy/{NrRB,NazwaBanku}` | 92.4%/82.7%, 77.7%/67.5%       | Useful, but lower ceiling than due date/VAT                                |
| Paid marker/date         | `Zaplacono` / `DataZaplaty`                     | 11.2% / 13.2%                  | Too sparse to be a source of truth on its own                              |
| `WZ` (delivery-note ref) | `Fa/WZ`                                         | 41.0% / 60.0%                  | Reconciliation-only, no reporting value alone                              |
| `DodatkowyOpis`          | key/value extras                                | 20.1% / 55.1%                  | Unstructured, issuer-specific                                              |
| Contact email/phone      | `Podmiot1/DaneKontaktowe/*`                     | ~45–54%                        | Display-only                                                               |
| `P_16` cash-method flag  | `Fa/Adnotacje/P_16`                             | fires on 2 parkowa / 4 portowa | Genuinely affects VAT-deduction timing when it fires, but extremely sparse |

### 6.3 A structural child table (bigger scope — its own plan if picked up)

**Correction references** (`DaneFaKorygowanej`, one row per referenced invoice, not a
column — a single correction can reference up to 50 000 invoices per the XSD, and one
real document here already references ten):

```
invoice_corrections(
  id, invoice_id → invoices.id ON DELETE CASCADE,
  ordinal,                       -- document order = identity; nothing inside the
                                  -- block is guaranteed unique (§4.3)
  corrected_issue_date TEXT,     -- DataWystFaKorygowanej, civil date
  corrected_invoice_number TEXT, -- NrFaKorygowanej
  corrected_ksef_number TEXT,    -- NrKSeFFaKorygowanej; NULL when NrKSeFN = "1" instead
  issued_outside_ksef INTEGER    -- boolean, from NrKSeFN
)
```

Deliberately **no foreign key** from `corrected_ksef_number` to `invoices.ksef_number`:
13% (parkowa) / 10% (portowa) of references point outside the sync window and would be
rejected by an FK. Resolve by `LEFT JOIN` at read time instead.

### 6.4 Explicitly do not build without a fresh, explicit ask

- **Per-venue reporting** (`Podmiot3`/`Rola=2`) — highest ceiling but genuinely messy: two
  incompatible representations across the two tenants (structured `Podmiot3` vs. free
  text crammed into the buyer name). Needs its own plan document, not a column.
- **FX/multi-currency handling** — all 779 invoices observed are `PLN`. Not worth it.
- **`Adnotacje` flags other than `P_16`** (`P_17` self-billing, `P_18` reverse charge,
  `P_18A` split payment) — all `2` (the "no" value) on all 779 invoices observed.
- **`Skonto`/early-payment discount, `Zamowienie`, `WarunkiDostawy`, `Transport`,
  `OkresFaOd`/`OkresFaDo`, `Rachunki`** — absent from both tenants entirely.
- **Netting corrections into originals**, or any change to how existing totals are
  computed — display new relationships, never silently rewrite arithmetic.
- **Category rules keyed on any new field.** Categorization stays seller-based (§4.10).

---

## 7. Execution steps (generic — applies to whichever fields are picked from §6)

Mirrors the shape of `INVOICE_ITEMS_PLAN.md` §5, which is the proven precedent for this
exact kind of change.

1. **Confirm scope.** Which columns from §6 (or a future field not listed here) are in
   this round? Get this settled before touching code — it determines how many columns
   land in the one migration (§4.6).
2. **Migration.** Add the columns to `src/db/schema.ts` with their CHECK constraints,
   `pnpm run db:generate`, review the generated SQL (`migration-reviewer` subagent),
   trial on a copy of both tenant databases, then apply.
3. **Parser.** Add one optional extraction function per field/group in
   `src/ksef/invoice-parser.ts`, following `extractInvoiceKind`'s shape: takes the parsed
   `Fa` record, returns the value or `null`, never throws. Reuse `asString`/`parseAmount`/
   `parseInteger` — do not write new leaf-parsing helpers.
4. **Persistence.** Extend `InvoiceRow` and the insert path in `src/db/invoices.ts` to
   carry the new fields. Add an `update*` function only if the field is ever corrected
   after import (none of §6.1's fields are — they're derived facts, not user input).
5. **Backfill.** New script under `src/tools/`, thin wrapper around a function in
   `src/invoices/`, following `backfill-invoice-kind.ts`'s exact shape: resumable
   (`WHERE new_column IS NULL` unless `--force`), dry-run flag, per-row success/skip/fail
   result, offline (no KSeF client, no network). Register it in `package.json` as
   `"backfill:<name>": "tsx src/tools/backfill-<name>.ts"`.
6. **Verify sync integration is automatic.** Once 3–4 are done, the next real
   `syncPurchaseInvoices()` call should persist the new fields with zero further changes
   to `src/sync.ts` — confirm this with a sync-engine test rather than assuming it.
7. **API.** Confirm the new columns ride along in `GET /invoices`'s response (there is
   mostly no separate response DTO to update — `listInvoices()`'s row shape flows through
   largely as-is; verify per field rather than assuming). Add a query filter only if the
   UI needs one (e.g. filtering to overdue invoices).
8. **UI.** Update `web/src/api/client.ts`'s `Invoice` interface (§4.7 — this is a silent
   gap if skipped) and `web/src/components/InvoicesTable.tsx` (or a new component, e.g. an
   "overdue" view). Reuse the `<details><summary>` expandable-row pattern from
   `RecentImports.tsx` for anything that doesn't deserve a permanent column.
9. **Tests, at every step above**, plus a final full-suite pass: `pnpm test`,
   `pnpm --dir web test`, `pnpm run typecheck`, `pnpm --dir web run typecheck`,
   `pnpm run lint`.
10. **Acceptance checks**, before calling any step done — reuse the measured figures in
    §6.1 as the expected outcome, e.g.: `net_total + vat_total = gross_total` within 0.01
    on 249/249 parkowa and 529/530 portowa rows (the one exception is a known,
    zero-value `KOR`); `payment_due_date` non-NULL on ~226/249 and ~420/530 rows. A
    backfill run that produces materially different numbers than these means something
    is wrong with the new parsing, not that the historical measurement was wrong.

---

## 8. Explicitly out of scope for this whole workstream

- Any KSeF network call of any kind — everything needed is already in `raw_xml`.
- Re-importing any invoice from KSeF.
- Changing money representation (stays `REAL`, matching `gross_total`).
- Item-level anything (already fully solved by `INVOICE_ITEMS_PLAN.md`).
- Anything in §6.4.
- Manual-entry (Phase 8) work — unrelated, currently the next numbered phase in
  `IMPLEMENTATION_PLAN.md`; this workstream is a companion, not a renumbering.

---

## 9. Reproducing the field-presence measurements

Read-only, safe to re-run against either tenant database. Kill any
`tsx watch src/api/main.ts` first — a live WAL-mode writer makes a `?mode=ro` snapshot
unreliable, and prefer `sqlite3 path/to/db.sqlite "SELECT …"` (no URI) over
`"file:...?mode=ro"` if the URI form throws `unable to open database file` — both were
seen to behave differently across shells in this session; the plain-path form is the more
reliable one.

Presence of an element across all invoices, tolerating all three namespace-prefix styles:

```sh
sqlite3 data/tenants/<tenant>/ksef-exporter.sqlite \
  "SELECT count(*) FILTER (WHERE raw_xml LIKE '%<TerminPlatnosci>%'
                              OR raw_xml LIKE '%<tns:TerminPlatnosci>%'
                              OR raw_xml LIKE '%<ns0:TerminPlatnosci>%'),
          count(*) FROM invoices WHERE raw_xml IS NOT NULL;"
```

For anything beyond presence (actual values, reconciliation sums), real XML parsing is
required — a one-off `node:sqlite` + the existing `parseInvoiceFaElement` is the fastest
path, mirroring how `INVOICE_TYPES_ANALYSIS.md` §7/§9.5 derived its numbers. **Re-derive
rather than trust a stale figure** — nothing in §6 is pinned by an automated test yet.

---

## 10. Suggested division of work across subagents

The goal here is wall-clock speed (parallel, independent work) and token efficiency (each
agent gets only the slice of context it needs, not this whole document plus the full
codebase). This mirrors the ownership discipline already documented in this repo's
`AGENTS.md`/`CLAUDE.md`: give each agent exclusive write ownership of its files, have it
run only its own focused tests, and have the primary agent run the full suite, typecheck,
and lint at each wave boundary — never a concurrent agent running `db:generate` or writing
to a live tenant database.

### Wave 0 — Primary agent only, not parallelizable

Confirm the field scope (§7 step 1), write and review the single migration (§4.6, §7 step
2), trial it on copies of both tenant databases, and apply it. This is the one genuinely
dangerous step and the one place parallelism actively hurts: two agents racing
`db:generate` against the same schema file is how a migration gets split across two files
by accident. Dispatch the `migration-reviewer` subagent here before applying anything.

Do not proceed to Wave 1 until the migration is applied to both real tenant databases (or
both agents in Wave 1 are working against a schema that already has the new columns
locally).

### Wave 1 — Two agents in parallel, after the migration lands

| Agent                  | Owns                                                                                              | Depends on                                                      | Deliverable                                                                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A — Parser & types** | `src/ksef/invoice-parser.ts`, `src/db/invoices.ts` (types + insert path), their test files        | Wave 0's migration                                              | New optional extraction functions, updated `InvoiceRow`, updated insert path, tests proving each field parses correctly and degrades to `null` on absence/malformed input |
| **B — Backfill tool**  | New file(s) under `src/invoices/` + `src/tools/`, `package.json`'s script entry, their test files | **Agent A's output shape** (the field names/types it will call) | A resumable, dry-run-capable, offline backfill script following `backfill-invoice-kind.ts`'s exact shape                                                                  |

Agent B has a soft dependency on Agent A's exact function signatures — resolve this by
having the primary agent hand Agent B the **agreed field list and types from §6.1 up
front** (which is already fixed by this document) rather than making B wait for A to
finish; B can write against the agreed interface and adjust imports once A lands, or the
two can be one agent if the coordination overhead isn't worth splitting for a small scope.

### Wave 2 — Two agents in parallel, after Wave 1 lands and the backfill has been run

| Agent       | Owns                                                                                                                         | Depends on                                                                                                                           | Deliverable                                                                                                                             |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| **C — API** | `src/api/server.ts` (only the relevant endpoint(s)), its test file                                                           | Wave 1                                                                                                                               | New fields confirmed present in `GET /invoices` responses (and a new filter/endpoint only if §6.1's due-date view needs one), API tests |
| **D — UI**  | `web/src/api/client.ts` (`Invoice` interface), `web/src/components/InvoicesTable.tsx` (or a new component), their test files | Wave 1 (**not** Agent C, if D works against the already-known field names from §6.1 rather than waiting on C's exact response shape) | New columns/detail view rendering the new fields, frontend tests                                                                        |

C and D can genuinely run concurrently against the agreed field list from §6.1 without
waiting on each other, since the field names and types are already fixed by this
document — the usual "UI needs the API's exact shape first" dependency is avoided by
fixing the shape in the plan instead of discovering it mid-implementation.

### Wave 3 — Primary agent

Run the full suite (`pnpm test`, `pnpm --dir web test`), both typechecks, and lint. Run
the acceptance checks from §7 step 10 against a **copy** of each live tenant database
(never the running files while `tsx watch` is live) or a `--dry-run` backfill invocation.
Update this document's §5 ("already implemented") and commit.

### Token-optimization notes for whoever dispatches these

- Give each subagent **only** this document plus the specific files listed in its "Owns"
  column — not the full `INVOICE_TYPES_ANALYSIS.md`/`INVOICE_ITEMS_PLAN.md` history. This
  document already extracted everything they'd need from those.
- Use the `runner` subagent (already defined in `AGENTS.md`) for the mechanical
  build/lint/typecheck/test passes between waves instead of pasting full command output
  into the primary conversation.
- Use `failure-diagnoser` if any wave's tests fail in a way that isn't immediately
  obvious, rather than iterating fixes blind in the primary context.
- Do not delegate the migration step (Wave 0) or anything touching a live tenant
  `.sqlite` file to a subagent that isn't explicitly told it's working on a **copy**.
