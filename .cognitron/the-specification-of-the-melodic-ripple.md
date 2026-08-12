# Plan — produce `design/INVOICE_ITEMS_PLAN.md` (invoice line-item persistence & display)

## Context

`ksef-exporter` imports purchase invoices from KSeF and persists a **flat header record**
(`invoices` table: seller, buyer, dates, `gross_total`, currency) plus the complete
`raw_xml`. SPEC §3.4 explicitly deferred line items ("optional for v1 if header-level
categorization suffices"), so nothing in the app parses, stores, or shows them — even
though **every** imported invoice already carries its full item detail in
`invoices.raw_xml`.

The gap is now visible in real use: the owner can see *that* an invoice from Eurocash was
4 521.36 PLN, but not *what* was on it. Because `raw_xml` is retained, closing the gap
needs **no new KSeF calls and no re-import** — the data is already local, so this is a
pure parse-and-project change against the tightest quota in the system
(`POST /invoices/exports`: 20/h — see SPEC §3.3).

**Deliverable:** one self-contained markdown document, `design/INVOICE_ITEMS_PLAN.md`,
holding (1) the current-state analysis and (2) a step-by-step implementation plan, written
to be handed to AI coding agents as context. It follows the existing standalone-workstream
precedent of `design/IMPORT_OBSERVABILITY_PLAN.md` and is cross-referenced from
`design/IMPLEMENTATION_PLAN.md` **without** renumbering Phase 8 (manual entry).

This plan does **not** implement the change; it produces the document.

---

## Pre-checks (all passed)

| Check                                             | Result                                                                                                             |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `design/IMPLEMENTATION_PLAN.md` readable          | Yes — 300 lines, Phases 0–9                                                                                        |
| Sufficient detail on invoice import & persistence | Yes — Phase 2 (extraction/parsing), Phase 3 (Drizzle schema, migrations, repositories), Phase 4 (sync integration) |
| `data/ksef-exporter.sqlite` readable & queryable  | Yes — 249 invoices, all with `raw_xml`                                                                             |

---

## Findings the document must record

Verified directly against the live database (249 invoices), the FA(3) XSD bundled with
`ksef-client@0.7.1` (`src/documents/fa3/schemas/schemat_FA(3)_v1-0E.xsd`), and the
existing code.

### Current schema (`src/db/schema.ts`, migrations `0000`–`0002`)

`invoices`, `categories`, `categorization_rules`, `sync_state`, `sync_runs`. `invoices`
holds one flat row per document (`gross_total REAL`, `raw_xml TEXT`) with **no child
table**. Repositories are thin typed wrappers in `src/db/*.ts`; migrations are generated
by `pnpm run db:generate` and applied automatically by `createDb()` in
[src/db/client.ts](src/db/client.ts) (`foreign_keys = ON`, so `ON DELETE CASCADE` works).

### `raw_xml` structure — measured, not assumed

- **249/249 are FA(3)** (`WariantFormularza = 3`, namespace `http://crd.gov.pl/wzor/2025/06/25/13775/`). No FA(2) in the current data, though the parser must stay version-tolerant.
- **Three namespace-prefix styles**: unprefixed (139), `tns:` (57), `ns0:` (53); both minified and indented serializations. The existing parser's `removeNSPrefix: true` already absorbs all of this — no per-invoice branching needed.
- **249/249 well-formed** (`xmllint --noout`); 0 parse failures.
- **2 437 line items total**: 1–61 per invoice, avg 9.79. 76 invoices have exactly one item. `FaWiersz` is `minOccurs=0 maxOccurs=10000` in the XSD, so **zero items is legal** (advance/correction invoices) even though it does not occur today.

### The three facts that drive the schema

1. **`NrWierszaFa` is not unique within an invoice.** 19 of 249 invoices repeat it — correction (`RodzajFaktury = KOR`) invoices emit each line twice, once with `StanPrzed = 1` (state before correction) and once without. e.g. invoice `4`: 22 `FaWiersz`, 11 distinct line numbers. → the unique key must be a **document-order ordinal**, never `(invoice_id, NrWierszaFa)`.
2. **`P_12` (VAT rate) must be TEXT.** XSD `TStawkaPodatku` enumerates `23, 22, 8, 7, 5, 4, 3, "0 KR", "0 WDT", "0 EX", "zw", "oo", "np I", "np II"`. Live data already contains `zw` (19 rows) alongside `23`/`8`/`5`.
3. **Net value is optional.** 151 rows carry no `P_11` (net) — they are gross-priced invoices using `P_9B`/`P_11A` instead; all 151 have `P_11A`. Every `FaWiersz` child except `NrWierszaFa` is `minOccurs=0`, so **every mapped column must be nullable**.

### Field coverage (share of invoices containing the tag at least once)

`NrWierszaFa` 100% · `P_7` 100% · `P_8B` 100% · `P_12` 100% · `P_8A` 98.8% ·
`P_11` 89.2% · `P_9A` 88.4% · `Indeks` 52.6% · `GTIN` 43.4% · `UU_ID` 40.2% ·
`PKWiU` 32.1% · `CN` 18.1% · `P_11A` 14.5% · `P_9B` 12.8% · `P_11Vat` 12.4% ·
`P_10` 10.0% · `StanPrzed` 8.0% · `KwotaAkcyzy` 1.6% · `PKOB` 0% · `P_12_XII` 0%.

No `FaWiersz` child declares `maxOccurs > 1`, so a flat one-column-per-field table is
**lossless** for FA(3).

### A real integrity check exists

Per-VAT-rate item net sums reconcile **exactly** with the header: `sum(P_11) where
P_12='23'` → `P_13_1`, `'8'` → `P_13_2`, `'5'` → `P_13_3`, `'zw'` → `P_13_7`.
**202 of 202 eligible invoices matched within 0.01 PLN, 0 mismatches.** Two documented
exclusions: 20 correction invoices (`StanPrzed` rows double-count) and 27 gross-priced
invoices (rows lack `P_11`).

⚠️ The naive check — total item net vs. `P_13_1` — fails on 69 of 249 invoices, because
`P_13_1` is only the **23%-rate** net base, not the invoice net total. The document must
say this so no agent builds the wrong assertion.

### `data/example.invoice.xml` — matches, with a caveat to flag

It matches database samples structurally (root `<ns0:Faktura>`, same namespace, FA(3),
22 `FaWiersz`; invoices `4` and `48` are near-identical). **No discrepancy to report.**
But it is a `KOR` correction invoice whose 22 rows are 11 `StanPrzed` pairs — i.e. the
*atypical* shape. The document must warn agents not to treat it as representative, and
should point at the simpler alternatives found in the DB (invoice `247`: one gross-priced
`zw` row; invoice `100`: `P_6A` + `KwotaAkcyzy`; invoice `203`: full `GTIN`/`PKWiU`/`CN`).

### Out-of-scope observation to note, not fix

`seedCategorizationRules()` ([src/categorization/seed-rules.ts](src/categorization/seed-rules.ts))
is **never called from production code** — only from its own tests. The live database has
0 categories and 0 rules, so all 249 invoices sit at `needs_review` and the UI's category
dropdown renders empty. Unrelated to line items, but it will confuse anyone verifying the
new UI, so the document flags it as a separate bug.

---

## Document structure to write

`design/INVOICE_ITEMS_PLAN.md`, self-contained (an agent reading only this file can
execute it), same voice/conventions as the existing design docs:

1. **Purpose & scope** — what's in, what's out (no item-level categorization, no
   re-import, no money-type refactor), pointer to SPEC §3.4 which deferred this.
2. **Current state** — `invoices` schema, where parsing happens
   ([src/ksef/invoice-parser.ts](src/ksef/invoice-parser.ts)), where persistence happens
   ([src/db/invoices.ts](src/db/invoices.ts), [src/sync.ts](src/sync.ts)), what the UI
   shows ([web/src/components/InvoicesTable.tsx](web/src/components/InvoicesTable.tsx)).
3. **`raw_xml` structure** — the measured findings above, with the FA(3) `FaWiersz`
   field table (element → XSD type → meaning → observed frequency) and 3–4 verbatim
   real `FaWiersz` samples spanning the variants (net-priced, gross-priced `zw`,
   correction `StanPrzed`, utility with `P_6A`/`KwotaAkcyzy`).
4. **The gap** — items are 100% present in stored XML, 0% queryable.
5. **Implementation plan** — steps 1–7 below, each with its own test list.
6. **Malformed / incomplete XML policy** — explicit rules (below).
7. **Verification checklist** and **deferred follow-ups**.

---

## Implementation plan the document will contain

### Step 1 — Schema: `invoice_items`

Add to [src/db/schema.ts](src/db/schema.ts), generate migration `0003` via
`pnpm run db:generate` (applied automatically by `createDb`).

| Column                                    | Type                                               | FA(3) source                                               |
| ----------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------- |
| `id`                                      | integer PK autoincrement                           | —                                                          |
| `invoice_id`                              | integer NOT NULL → `invoices.id` ON DELETE CASCADE | —                                                          |
| `ordinal`                                 | integer NOT NULL                                   | 1-based **document order** of `FaWiersz` within `Fa`       |
| `line_number`                             | integer                                            | `NrWierszaFa` (may repeat — see `correction_state_before`) |
| `uu_id`                                   | text                                               | `UU_ID`                                                    |
| `delivery_date`                           | text                                               | `P_6A`                                                     |
| `name`                                    | text                                               | `P_7`                                                      |
| `index_code`                              | text                                               | `Indeks`                                                   |
| `gtin`                                    | text                                               | `GTIN`                                                     |
| `pkwiu` / `cn` / `pkob`                   | text                                               | `PKWiU` / `CN` / `PKOB`                                    |
| `unit`                                    | text                                               | `P_8A` — stored **verbatim**, never normalized             |
| `quantity`                                | real                                               | `P_8B`                                                     |
| `unit_price_net` / `unit_price_gross`     | real                                               | `P_9A` / `P_9B`                                            |
| `discount`                                | real                                               | `P_10`                                                     |
| `net_value` / `gross_value` / `vat_value` | real                                               | `P_11` / `P_11A` / `P_11Vat`                               |
| `vat_rate`                                | **text**                                           | `P_12` — never numeric (`zw`, `oo`, `np I`, `0 WDT`)       |
| `vat_rate_oss`                            | real                                               | `P_12_XII`                                                 |
| `annex15`                                 | integer (boolean)                                  | `P_12_Zal_15`                                              |
| `excise`                                  | real                                               | `KwotaAkcyzy`                                              |
| `gtu_code` / `procedure_code`             | text                                               | `GTU` / `Procedura`                                        |
| `exchange_rate`                           | real                                               | `KursWaluty`                                               |
| `correction_state_before`                 | integer (boolean)                                  | `StanPrzed`                                                |

`uniqueIndex("invoice_items_invoice_ordinal_unique").on(invoiceId, ordinal)` +
`index("invoice_items_invoice_id_idx").on(invoiceId)`.

Every column except `invoice_id`/`ordinal` is nullable. `real` for amounts matches the
existing `invoices.gross_total` precedent; the document records the float caveat and the
0.01-tolerance rule rather than opening a money-type refactor.

Also add **`invoices.items_extracted_at TEXT` (nullable)** — distinguishes "never
attempted" (NULL) from "extracted, genuinely zero items", which makes the backfill
resumable and idempotent (`WHERE items_extracted_at IS NULL`).

### Step 2 — Parser: extract items

Extend [src/ksef/invoice-parser.ts](src/ksef/invoice-parser.ts): add
`InvoiceItemRecord` and `items: InvoiceItemRecord[]` to `PurchaseInvoiceRecord`, reusing
the existing `asRecord` / `asString` / `parseAmount` helpers and the single shared
`XMLParser`. Two documented gotchas:

- **Single-child collapse** — `fast-xml-parser` returns an object, not an array, when
  there is exactly one `FaWiersz` (76 of 249 invoices). Add an `asArray()` helper
  alongside the existing `asRecord`.
- **Set `parseTagValue: false`** on the shared parser. Today numeric-looking text is
  coerced to a JS number, which would silently corrupt leading-zero `GTIN`/`Indeks`
  codes and turn `P_12` into a mixed number/string type. `asString`/`parseAmount`
  already accept strings, so this is a safe tightening — but the existing
  `invoice-parser.test.ts` and `invoices.test.ts` must be re-run to confirm.

### Step 3 — Repository: `src/db/invoice-items.ts`

`replaceInvoiceItems(db, invoiceId, items)` (delete-then-insert in one transaction —
idempotent re-extraction), `listInvoiceItems(db, invoiceId)`,
`countInvoiceItemsByInvoice(db, invoiceIds)`. Thin and typed, matching the existing
`src/db/*.ts` style with no business logic.

### Step 4 — Sync integration

In [src/sync.ts](src/sync.ts), persist items for each invoice that was newly inserted
**or** still has `items_extracted_at IS NULL`, then stamp `items_extracted_at`. Extend
`SyncDiagnostics` with `itemsInsertedCount` / `itemsFailedCount`, add matching nullable
columns to `sync_runs`, surface them through `POST /sync` and `RunDetails` — reusing the
diagnostics pattern Phase 7 already established.

### Step 5 — Backfill of the 249 existing invoices

`src/invoices/backfill-items.ts` + CLI `src/tools/backfill-invoice-items.ts` wired as
`pnpm run backfill:items` (matching the existing `src/tools/*` + `package.json` script
pattern). Supports `--dry-run` and `--force`; **makes zero KSeF calls** — it reads
`invoices.raw_xml` only. Prints per-invoice results and a summary. Expected outcome:
**249 invoices → 2 437 items**.

### Step 6 — API: `GET /invoices/:id/items`

Add to [src/api/server.ts](src/api/server.ts), JWT-protected via the existing
`fastify.authenticate` decorator, `id` validated with the existing
`invoiceIdParamsSchema`, 404 for an unknown invoice. Items are **not** inlined into
`GET /invoices` (FA allows 10 000 lines/invoice); the list response gains only an
`itemCount` so the UI can label and disable an empty toggle.

### Step 7 — UI: expandable row (user-chosen)

Add `fetchInvoiceItems` to [web/src/api/client.ts](web/src/api/client.ts) via the
existing `request` wrapper. New `web/src/components/InvoiceItemsTable.tsx`; in
[web/src/components/InvoicesTable.tsx](web/src/components/InvoicesTable.tsx) each row
gains a `<details><summary>Items (n)</summary>` toggle that lazy-loads on first expand —
the same `<details>` pattern `RunDetails` already uses in
[web/src/components/RecentImports.tsx](web/src/components/RecentImports.tsx). Columns:
`#`, name, unit, quantity, net (falling back to gross when `net_value` is null), VAT
rate, VAT amount; correction rows (`correction_state_before`) visually marked "before
correction". Keeps the existing two-item nav — no router.

### Malformed / incomplete XML policy (explicit in the document)

- **Item extraction must never fail an invoice import.** The header parse keeps throwing
  `InvoiceParsingError` (a wrong financial header is worse than no invoice); item
  extraction is best-effort — on failure the invoice is stored/kept, `items_extracted_at`
  stays NULL, `itemsFailedCount` increments, and a `sync.items.failed` structured log
  event fires.
- **Per-item degradation:** a `FaWiersz` missing `P_7` or all amount fields is still
  stored with NULLs — the ordinal preserves position and `raw_xml` remains the source of
  truth. No silent row drops.
- **Zero items** is a valid state, not an error (`FaWiersz` is `minOccurs=0`).
- **Unknown/future FA fields** are ignored, not fatal; `raw_xml` retention means nothing
  is unrecoverable, and re-running the backfill with `--force` re-derives items after a
  parser improvement.
- Reconciliation is a **report, not a gate**: use the per-VAT-rate rule above with 0.01
  tolerance, excluding correction and gross-priced invoices.

### Tests the document specifies (per project convention: no feature is done without passing tests)

Parser: multi-item, single-item collapse, all three namespace prefixes, `zw` rate
preserved as text, gross-priced row (no `P_11`), duplicate `NrWierszaFa` with
`StanPrzed`, malformed items block doesn't kill the header. Repository: insert/list
round-trip, `replaceInvoiceItems` idempotency, cascade delete. Sync: items persisted on
first import, not duplicated on re-sync, item failure doesn't fail the invoice. Backfill:
processes only `items_extracted_at IS NULL`, `--dry-run` writes nothing, `--force`
re-derives. API: happy path, 404, 401. UI: collapsed by default, fetch-on-expand,
gross fallback, correction-row marking, error path.

---

## Verification

Because the deliverable is a document, verification is of the *analysis*, not of code:

1. Re-run the two reconciliation queries in this plan against `data/ksef-exporter.sqlite`
   and confirm the numbers in the document (2 437 items, 19 duplicate-line-number
   invoices, 151 rows without `P_11`, 202/202 per-rate reconciliation, 0 malformed XML).
2. Confirm every `FaWiersz` child in `schemat_FA(3)_v1-0E.xsd` (25 elements) appears in
   the `invoice_items` column table — no field silently dropped.
3. Confirm every file path and symbol the document cites exists (`src/db/schema.ts`,
   `src/ksef/invoice-parser.ts`, `src/sync.ts`, `src/api/server.ts`,
   `web/src/components/InvoicesTable.tsx`, `fastify.authenticate`,
   `invoiceIdParamsSchema`, `pnpm run db:generate`).
4. Add the cross-reference line to `design/IMPLEMENTATION_PLAN.md` next to the existing
   `IMPORT_OBSERVABILITY_PLAN.md` mention, leaving Phase 8 numbering untouched.

When the plan is later executed, its own end-to-end check is:
`pnpm run migrate && pnpm run backfill:items` → 2 437 items across 249 invoices →
`pnpm test` (backend + `web`) → `pnpm run typecheck && pnpm run lint` →
`pnpm run dev:api` + web dev server, log in, expand an invoice row and see its items.
