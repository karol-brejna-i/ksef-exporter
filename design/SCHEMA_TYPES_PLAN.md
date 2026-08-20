# Schema Column Types Plan — dates, instants, and other over-broad columns

**Status:** proposed, not started.
**Last updated:** 2026-08-20 13:32
**Scope owner:** this document is the single source of truth for the column-type
workstream. It does not change sync quota behaviour, KSeF request shapes, or the
categorization engine.

---

## 1. Summary of the problem

Every temporal column in this database is declared `TEXT`, and the application
writes them through **two different, mutually incompatible formats**:

| Producer                             | Format written                                                   | Example (live data)                |
| :----------------------------------- | :--------------------------------------------------------------- | :--------------------------------- |
| SQLite `DEFAULT (current_timestamp)` | `YYYY-MM-DD HH:MM:SS`, **UTC**, space separator, no zone marker  | `2026-08-10 15:35:01`              |
| JS `new Date().toISOString()`        | `YYYY-MM-DDTHH:MM:SS.sssZ`, **UTC**, `T` separator, explicit `Z` | `2026-08-12T11:16:15.304Z`         |
| KSeF SDK (pass-through)              | ISO-8601 with **microseconds** and an explicit offset            | `2026-08-10T15:32:59.989017+00:00` |
| FA(3) invoice XML (pass-through)     | calendar date, no time, no zone                                  | `2026-08-01`                       |

All four coexist today, in adjacent columns of the same tables. `sync_runs` alone
holds three of them: `requested_at` is space-separated, `started_at`/`completed_at`
are `T…Z`, and `window_from`/`window_to` are bare dates.

`TEXT` is not merely imprecise here. Because the columns carry no type and no
constraint, the schema cannot distinguish three semantically different things that
happen to look alike:

1. **A civil date** — a calendar day with no time and no timezone (`issue_date`,
   `delivery_date`). It is a legal fact on a document. It has no instant.
2. **An instant** — a specific moment (`created_at`, `started_at`). It has no
   meaningful "date" until you pick a timezone.
3. **An opaque vendor token** — KSeF's `PermanentStorage` continuation point. It
   *looks* like an instant, but its contract is "hand this exact string back to
   KSeF", not "this is a time you may reason about".

Conflating these has produced three concrete defects, two of them live. All three
are proven against the real database in §2.4, not inferred.

### 1.1 Defect A — the Recent Imports timestamp is displayed two hours early (live)

`web/src/components/RecentImports.tsx:153`:

```tsx
<td>{new Date(run.requestedAt).toLocaleString()}</td>
```

`requested_at` is written by SQLite's `current_timestamp`, which is **UTC**, in the
form `2026-08-10 15:35:01`. That string is *not* an ISO-8601 format string under
ECMA-262, so `Date.parse` falls back to implementation-defined parsing; V8 reads it
as **local time**. Measured directly (§2.4):

```
'2026-08-10 15:35:01'  SQL (UTC, correct) → 1786376101000
                       Date.parse (local) → 1786368901000
                       difference          →       7200000 ms  (exactly +02:00)
```

Every one of the 8 `sync_runs` rows renders two hours early in Europe/Warsaw summer
time. The error silently changes size at the DST boundary and disappears entirely
for a user in UTC — which is why it has not been noticed. It is also not portable:
JavaScriptCore has historically returned `Invalid Date` for this exact shape.

### 1.2 Defect B — the continuation-point window guard drops valid resume points

`src/sync.ts` compares an **instant** to **civil-date** bounds using JavaScript
string comparison:

```ts
const appliedContinuationPoint =
  storedContinuationPoint != null &&
  storedContinuationPoint >= options.windowFrom &&
  storedContinuationPoint <= options.windowTo
    ? storedContinuationPoint
    : null;
```

With the live stored value `2026-08-10T15:32:59.989017+00:00` and a window ending
`windowTo = '2026-08-10'`, the two strings share the prefix `2026-08-10` and the
stored one is longer, so it sorts **greater**. The `<=` guard fails, the resume
point is discarded, `sync.continuation.conflict` is logged, and the sync re-fetches
the entire window from `windowFrom`.

This fires whenever `date(continuation_point) == windowTo` — that is, on any repeat
import whose window ends on the day the previous import reached. The default window
from `web/src/components/SyncButton.tsx` ends on the last day of the current month,
so it triggers on month-end, and on *every* attempt for a hand-narrowed "today only"
window. The consequence is a full-window re-download against an endpoint capped at
**16 requests/minute and 20/hour** — the same quota class that caused the production
incident recorded in `.github/copilot-instructions.md`.

### 1.3 Defect C — `hasMore` and the monotonic high-water mark are both unsound

Same file, same root cause:

```ts
const hasMore = newContinuationPoint !== undefined && newContinuationPoint < options.windowTo;
```

An instant on the window's final day always sorts *after* the bare date, so
`2026-08-31T05:00:00+00:00 < '2026-08-31'` is `false`. The UI reports the import as
complete while invoices later that day remain unimported — silent data loss, with no
error and no log line.

And `laterContinuationPoint`, whose comment asserts "string order is chronological":

```ts
/** Both values are KSeF `PermanentStorage` ISO-8601 timestamps, so string order is chronological. */
function laterContinuationPoint(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a >= b ? a : b;
}
```

The premise is false for ISO-8601 in general. Measured:

| String                             | Sorts      | Actual instant (epoch ms)         |
| :--------------------------------- | :--------- | :-------------------------------- |
| `2026-08-10T15:32:59.989017+00:00` | lower      | 1786375979989                     |
| `2026-08-10T15:32:59.989017+02:00` | **higher** | **1786368779989** (2 h *earlier*) |

`'0' < '2'` at the offset-hour position, so the chronologically earlier value wins.
`Z` (0x5A) beats `+` (0x2B) unconditionally for the same reason. This function would
therefore **rewind** the high-water mark — the precise failure it was written to
prevent. It is correct today only because KSeF happens to return `+00:00` for every
observed value. Nothing in the SDK contract pins that.

### 1.4 Secondary issues

- **No CHECK constraints exist anywhere in the database.** Nothing prevents
  `issue_date = '10/08/2026'`, `2026-02-30`, a 9-digit NIP, or `annex15 = 7`.
  Drizzle's `{ enum: [...] }` is a **TypeScript-only** refinement; it emits no SQL.
- **Money is stored as `REAL`.** `gross_total` and the line-item value columns are
  binary floating point. Summing 249 invoices per currency in
  `web/src/components/InvoicesSummary.tsx` accumulates representation error.
- **`listInvoices` filters months with `LIKE 'YYYY-MM%'`**, which is not sargable and
  cannot use an index; there is no index on `issue_date` either.
- **Dual write paths.** `created_at` and `requested_at` are the only two columns
  written by SQL rather than by the application. That split is the root cause of §1.1
  and the reason the two formats diverged in the first place.

---

## 2. Actual system state (measured 2026-08-20)

Environment: Node v24.16.0, SQLite **3.53.0** (via `better-sqlite3` 12.11.1),
`drizzle-orm` 0.45.2, `drizzle-kit` 0.31.10, `zod` 3.24.
Database: `data/ksef-exporter.sqlite`, 2,199,552 bytes, `journal_mode=wal`,
`foreign_keys=1`, `user_version=0`, 4 applied migrations.

### 2.1 Row counts

| Table                  |  Rows |
| :--------------------- | ----: |
| `invoices`             |   249 |
| `invoice_items`        | 2,437 |
| `categories`           |     3 |
| `categorization_rules` |    16 |
| `sync_state`           |     1 |
| `sync_runs`            |     8 |

### 2.2 Every temporal column, as it actually exists

| Column                          | Decl.                                       | Rows / NULL | Observed format                                      | Min → Max                                     |
| :------------------------------ | :------------------------------------------ | :---------- | :--------------------------------------------------- | :-------------------------------------------- |
| `invoices.issue_date`           | TEXT NOT NULL                               | 249 / 0     | `YYYY-MM-DD`, len 10, **100 % uniform**              | `2026-06-30` → `2026-08-10`                   |
| `invoices.created_at`           | TEXT NOT NULL DEFAULT `(current_timestamp)` | 249 / 0     | `YYYY-MM-DD HH:MM:SS`, len 19, space sep., UTC       | `2026-08-10 15:35:01` → `2026-08-10 16:27:16` |
| `invoices.items_extracted_at`   | TEXT                                        | 249 / 0     | `YYYY-MM-DDTHH:MM:SS.sssZ`, len 24                   | `2026-08-12T11:16:15.304Z` → `…455Z`          |
| `invoice_items.delivery_date`   | TEXT                                        | 32 / 2,405  | `YYYY-MM-DD`, len 10                                 | `2026-06-30` → `2026-08-10`                   |
| `sync_state.continuation_point` | TEXT                                        | 1 / 0       | ISO-8601, **microseconds + `+00:00` offset**, len 32 | `2026-08-10T15:32:59.989017+00:00`            |
| `sync_runs.requested_at`        | TEXT NOT NULL DEFAULT `(current_timestamp)` | 8 / 0       | `YYYY-MM-DD HH:MM:SS`, len 19                        | `2026-07-11 15:11:10` → `2026-08-10 16:27:09` |
| `sync_runs.started_at`          | TEXT                                        | 5 / 3       | `YYYY-MM-DDTHH:MM:SS.sssZ`, len 24                   | `2026-08-10T15:09:40.130Z` → `…16:27:09.673Z` |
| `sync_runs.completed_at`        | TEXT                                        | 5 / 3       | `YYYY-MM-DDTHH:MM:SS.sssZ`, len 24                   | `2026-08-10T15:09:50.661Z` → `…16:27:16.909Z` |
| `sync_runs.window_from`         | TEXT NOT NULL                               | 8 / 0       | `YYYY-MM-DD`, len 10                                 | `2026-05-01` → `2026-08-01`                   |
| `sync_runs.window_to`           | TEXT NOT NULL                               | 8 / 0       | `YYYY-MM-DD`, len 10                                 | `2026-07-31` → `2026-08-31`                   |

**Format-marker census** (count of non-NULL values containing each marker):

| Column                                |     `T` |   space | ends `Z` | `.` frac | `+` offset |
| :------------------------------------ | ------: | ------: | -------: | -------: | ---------: |
| `invoices.issue_date`                 |       0 |       0 |        0 |        0 |          0 |
| `invoices.created_at`                 |       0 | **249** |        0 |        0 |          0 |
| `invoices.items_extracted_at`         | **249** |       0 |  **249** |  **249** |          0 |
| `invoice_items.delivery_date`         |       0 |       0 |        0 |        0 |          0 |
| `sync_runs.requested_at`              |       0 |   **8** |        0 |        0 |          0 |
| `sync_runs.started_at`                |   **5** |       0 |    **5** |    **5** |          0 |
| `sync_runs.completed_at`              |   **5** |       0 |    **5** |    **5** |          0 |
| `sync_runs.window_from` / `window_to` |       0 |       0 |        0 |        0 |          0 |

**Good news for the migration:** within each column the format is 100 % uniform, and
`0` rows violate the ISO date pattern in `issue_date` or `delivery_date`. There is no
dirty data to clean — only a representation to convert.

### 2.3 Non-temporal column state

| Column                                           | Decl.         | Observed                                  |
| :----------------------------------------------- | :------------ | :---------------------------------------- |
| `invoices.gross_total`                           | REAL NOT NULL | 249 × `real`                              |
| `invoices.currency`                              | TEXT NOT NULL | 249 × `PLN`                               |
| `invoices.source`                                | TEXT NOT NULL | 249 × `ksef` (no manual rows yet)         |
| `invoices.categorization_confidence`             | TEXT NOT NULL | 249 × `needs_review`                      |
| `invoices.seller_nip` / `buyer_nip`              | TEXT          | 249 each, **all length 10**               |
| `invoice_items.vat_rate`                         | TEXT          | `5`×1177, `23`×1054, `8`×187, **`zw`×19** |
| `invoice_items.annex15`                          | INTEGER       | `1`×20, NULL×2417 (**never `0`**)         |
| `invoice_items.correction_state_before`          | INTEGER       | `1`×138, NULL×2299 (**never `0`**)        |
| `invoice_items.line_number`                      | INTEGER       | 2437 × `integer`                          |
| `invoice_items.vat_rate_oss`                     | REAL          | **2437 × NULL** (entirely unused)         |
| `invoice_items.exchange_rate`                    | REAL          | 3 non-NULL                                |
| `invoice_items.quantity`                         | REAL          | 2437 non-NULL                             |
| `invoice_items.unit_price_net` / `net_value`     | REAL          | 2283 / 2286 non-NULL                      |
| `invoice_items.unit_price_gross` / `gross_value` | REAL          | 158 / 166 non-NULL (gross-priced lines)   |
| `sync_runs.status`                               | TEXT          | `error`×6, `success`×2                    |
| `sync_runs.has_more`                             | INTEGER       | `1`×2, NULL×6 (**never `0`**)             |

`vat_rate` confirms the existing schema comment: it must stay `TEXT`, because `zw`
(VAT-exempt) is a legal `TStawkaPodatku` value alongside the numerics. Do not
"improve" it to a number.

Note also that all 249 invoices are `needs_review` despite 16 categorization rules
existing. That is a separate question, **out of scope here**; flagged only so it is
not mistaken for a side effect of this work.

### 2.4 Verified SQL/JS conversion semantics

Run against a fresh in-memory SQLite 3.53.0 and cross-checked against
`Date.parse` in Node 24. This table is the evidence base for the migration SQL:

| Input                              | `CAST(ROUND((julianday(v) - 2440587.5) * 86400000.0) AS INTEGER)` | `Date.parse(v)` |              Δ |
| :--------------------------------- | ----------------------------------------------------------------: | --------------: | -------------: |
| `2026-08-10 15:35:01`              |                                                     1786376101000 |   1786368901000 | **+7 200 000** |
| `2026-08-12T11:16:15.304Z`         |                                                     1786533375304 |   1786533375304 |              0 |
| `2026-08-10T15:32:59.989017+00:00` |                                                     1786375979989 |   1786375979989 |              0 |
| `2026-08-10T15:32:59.989017+02:00` |                                                     1786368779989 |   1786368779989 |              0 |
| `2026-06-30`                       |                                                     1782777600000 |   1782777600000 |              0 |

Three conclusions, each load-bearing for §4:

1. **The `julianday` expression is exact to the millisecond for all four live
   formats.** It parses `T`, space, `Z`, `±HH:MM`, and sub-second digits, and it
   truncates the microseconds correctly (`.989017` → `989`).
2. **The backfill must run in SQL, not in TypeScript.** For the legacy
   space-separated format SQLite is *right* (it reads it as UTC, matching what
   `current_timestamp` wrote) and JavaScript is *wrong* (it reads it as local time).
   A JS backfill would bake Defect A permanently into the data.
3. `unixepoch(v,'subsec')` also works on 3.53.0 but returns a float in seconds;
   `strftime('%s',v)` silently drops sub-second precision. Prefer the `julianday`
   expression, which needs no version floor beyond what is already installed.

Constraint support, also verified on 3.53.0:

- `CHECK (d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')` — accepts
  `2026-08-10`, rejects `10/08/2026`. ✅
- `CHECK (d IS date(d))` — rejects `2026-02-30` (SQLite normalises it to
  `2026-03-02`, so it no longer equals the input). ✅ Both are needed: `GLOB` pins the
  *shape*, `date()` pins *calendar validity*.
- `STRICT` tables work (`cannot store TEXT value in INTEGER column`). **But
  drizzle-kit 0.31.10 cannot emit `STRICT`**, and it diffs against its own snapshot
  JSON, so a hand-added `STRICT` keyword would be silently dropped by the next
  generated table rebuild. See §6.

### 2.5 Code inventory

Every site that produces, compares, or renders one of these values:

**Write paths (the only places a temporal value is created):**

| Site                               | Column                                | Expression                                     | Format produced           |
| :--------------------------------- | :------------------------------------ | :--------------------------------------------- | :------------------------ |
| `src/db/schema.ts` (SQL default)   | `invoices.created_at`                 | `sql\`(current_timestamp)\``                   | `YYYY-MM-DD HH:MM:SS` UTC |
| `src/db/schema.ts` (SQL default)   | `sync_runs.requested_at`              | `sql\`(current_timestamp)\``                   | `YYYY-MM-DD HH:MM:SS` UTC |
| `src/db/invoice-items.ts:106`      | `invoices.items_extracted_at`         | `new Date().toISOString()`                     | `…T…Z`                    |
| `src/api/server.ts:144`            | `sync_runs.started_at`                | `new Date(startedAtMs).toISOString()`          | `…T…Z`                    |
| `src/api/server.ts:168,197`        | `sync_runs.completed_at`              | `new Date(completedAtMs).toISOString()`        | `…T…Z`                    |
| `src/ksef/invoice-parser.ts:337`   | `invoices.issue_date`                 | `asString(fa.P_1)` verbatim                    | `YYYY-MM-DD`              |
| `src/ksef/invoice-parser.ts:232`   | `invoice_items.delivery_date`         | `asString(row.P_6A) ?? null` verbatim          | `YYYY-MM-DD`              |
| `src/db/sync-state.ts`             | `sync_state.continuation_point`       | SDK value verbatim                             | ISO + µs + offset         |
| `src/api/server.ts` (request body) | `sync_runs.window_from` / `window_to` | user input, validated only `z.string().min(1)` | unconstrained             |

**Comparison / ordering sites (all lexicographic, all suspect):**

| Site                                                        | Expression                                                                                    |
| :---------------------------------------------------------- | :-------------------------------------------------------------------------------------------- |
| `src/sync.ts` `laterContinuationPoint`                      | `a >= b ? a : b` — instant vs instant → Defect C                                              |
| `src/sync.ts` window guard                                  | `stored >= windowFrom && stored <= windowTo` — instant vs date → Defect B                     |
| `src/sync.ts` `hasMore`                                     | `newContinuationPoint < options.windowTo` — instant vs date → Defect C                        |
| `src/sync.ts` log field                                     | `effectiveFrom > options.windowFrom` (`windowStartSkipped`)                                   |
| `src/db/invoices.ts` `listInvoices`                         | `like(invoices.issueDate, \`${filter.month}%\`)` — date vs date, **correct but non-sargable** |
| `scripts/export-invoices.py:71-80`                          | `i.issue_date >= ?` / `<= ?`, `ORDER BY i.issue_date DESC` — date vs date, **correct**        |
| `scratch/experiment-continuation.ts:59`, `src/sync.test.ts` | mirror the sync comparisons in fixtures                                                       |

**Display / wire sites:**

| Site                                         | Behaviour                                                            |
| :------------------------------------------- | :------------------------------------------------------------------- |
| `web/src/components/RecentImports.tsx:153`   | `new Date(run.requestedAt).toLocaleString()` → **Defect A**          |
| `web/src/components/RecentImports.tsx:38,40` | `run.startedAt ?? "Not started"` — raw ISO string dumped to the user |
| `web/src/components/RecentImports.tsx:155`   | `{run.windowFrom} – {run.windowTo}` — raw, fine                      |
| `web/src/components/InvoicesTable.tsx:124`   | `{invoice.issueDate}` raw — fine, it is a civil date                 |
| `web/src/components/InvoicesTable.tsx:150`   | `itemsExtractedAt === null` NULL check only                          |
| `web/src/api/client.ts:27,32,34,70-75`       | all typed `string` on the wire                                       |
| `scripts/export-invoices.py:32,41`           | exports `issue_date` and `created_at` to Excel                       |

**Validation sites:** only two exist. `src/api/server.ts:57-58`
(`windowFrom`/`windowTo` as `z.string().min(1)` — no format check at all) and
`src/api/server.ts:64` (`month` as `/^\d{4}-\d{2}$/`).

**Migrations:** `0000` created `invoices` (`issue_date`, `created_at`, `gross_total`);
`0001` created `sync_runs` (`requested_at`, `window_from`, `window_to`) and
`sync_state` (`continuation_point`); `0002` added `sync_runs.started_at`,
`completed_at`, `duration_ms`, `has_more` and the diagnostics columns; `0003` added
`invoices.items_extracted_at` and the whole `invoice_items` table. The next migration
is **`0004`**.

---

## 3. Target design

### 3.1 The rule

> Classify every column by what it *means*, then pick the type that makes the
> meaning unrepresentable-when-wrong.

| Kind                    | Storage                          | Drizzle                             | TS type                     | Rationale                                                                                                                                                                                                               |
| :---------------------- | :------------------------------- | :---------------------------------- | :-------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Civil date**          | `TEXT` `YYYY-MM-DD` + CHECK      | `text()`                            | branded `IsoDate`           | A calendar day has no instant. Converting it to epoch invents a timezone and introduces an off-by-one at every DST/offset boundary. ISO-8601 dates already sort correctly as text and are human-readable in ad-hoc SQL. |
| **Instant**             | `INTEGER` epoch **milliseconds** | `integer({ mode: "timestamp_ms" })` | `Date`                      | One canonical representation, no timezone ambiguity, correct numeric ordering, cheap arithmetic, and drizzle maps it to a real `Date` object so the type system stops us conflating it with a date string.              |
| **Opaque vendor token** | `TEXT`, verbatim                 | `text()`                            | branded `ContinuationPoint` | Must round-trip to KSeF byte-identically, including microseconds and offset. Never compare it as a string; parse to epoch ms first.                                                                                     |

Milliseconds, not seconds: `items_extracted_at` already carries millisecond
precision and `duration_ms` is already in ms, so ms keeps everything commensurable.

### 3.2 Column-by-column target

| Column                                     | Today                              | Target                                                       |
| :----------------------------------------- | :--------------------------------- | :----------------------------------------------------------- |
| `invoices.issue_date`                      | TEXT                               | **TEXT** + `CHECK (GLOB … AND IS date(…))`, new index        |
| `invoices.created_at`                      | TEXT DEFAULT `(current_timestamp)` | **INTEGER** ms, NOT NULL, **SQL default removed**            |
| `invoices.items_extracted_at`              | TEXT                               | **INTEGER** ms, nullable                                     |
| `invoice_items.delivery_date`              | TEXT                               | **TEXT** + CHECK (NULL-permitting)                           |
| `sync_state.continuation_point`            | TEXT                               | **TEXT unchanged** — comparisons move out of SQL/string-land |
| `sync_runs.requested_at`                   | TEXT DEFAULT `(current_timestamp)` | **INTEGER** ms, NOT NULL, **SQL default removed**            |
| `sync_runs.started_at`                     | TEXT                               | **INTEGER** ms, nullable                                     |
| `sync_runs.completed_at`                   | TEXT                               | **INTEGER** ms, nullable                                     |
| `sync_runs.window_from` / `window_to`      | TEXT                               | **TEXT** + CHECK (civil dates)                               |
| `sync_runs.continuation_before` / `_after` | TEXT                               | **TEXT unchanged** (audit copies of the opaque token)        |

**Removing the two SQL defaults is deliberate and is the structural fix.** Once
every instant is written by exactly one producer — the application — the two formats
cannot diverge again. Drizzle's `$defaultFn(() => new Date())` supplies the value
client-side and emits no SQL default, so the column stays `NOT NULL` without a
second write path.

### 3.3 CHECK constraints to add

`drizzle-orm/sqlite-core` exports `check`, so these are declared in `schema.ts` and
emitted by `drizzle-kit generate` — no hand-written DDL. There are currently zero
constraints in the database; these are all new.

```
invoices:
  CHECK (issue_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
         AND issue_date IS date(issue_date))
  CHECK (source IN ('ksef','manual'))
  CHECK (categorization_confidence IN ('matched','needs_review'))
  CHECK (currency GLOB '[A-Z][A-Z][A-Z]')
  CHECK (seller_nip IS NULL OR seller_nip GLOB '[0-9]...[0-9]')   -- 10 digits
  CHECK (buyer_nip  IS NULL OR buyer_nip  GLOB '[0-9]...[0-9]')
  CHECK (created_at BETWEEN 946684800000 AND 4102444800000)        -- 2000..2100
  CHECK (items_extracted_at IS NULL
         OR items_extracted_at BETWEEN 946684800000 AND 4102444800000)

invoice_items:
  CHECK (ordinal >= 1)
  CHECK (delivery_date IS NULL
         OR (delivery_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
             AND delivery_date IS date(delivery_date)))
  CHECK (annex15 IS NULL OR annex15 IN (0,1))
  CHECK (correction_state_before IS NULL OR correction_state_before IN (0,1))

categorization_rules:
  CHECK (match_type IN ('seller_nip','seller_name_contains'))

sync_runs:
  CHECK (status IN ('running','success','error'))
  CHECK (has_more IS NULL OR has_more IN (0,1))
  CHECK (window_from GLOB '…' AND window_from IS date(window_from))
  CHECK (window_to   GLOB '…' AND window_to   IS date(window_to))
  CHECK (window_from <= window_to)
  CHECK (requested_at BETWEEN 946684800000 AND 4102444800000)
  CHECK (started_at   IS NULL OR started_at   BETWEEN … AND …)
  CHECK (completed_at IS NULL OR completed_at BETWEEN … AND …)
```

The epoch range check is not decoration: it is what catches a value accidentally
written in **seconds** (`1786376101` ≪ 946684800000) or left as text, which is the
single most likely regression after this migration.

CHECK passes on NULL in SQLite, so the `IS NULL OR …` prefixes are belt-and-braces
for readability; keep them.

### 3.4 New module: `src/time.ts`

One place that owns temporal semantics, so no caller improvises again.

```ts
export type IsoDate = string & { readonly __brand: "IsoDate" };

export function isIsoDate(v: string): v is IsoDate;         // shape + real calendar day
export function assertIsoDate(v: string): IsoDate;

/** Parse a KSeF continuation point (µs precision, explicit offset) to epoch ms. */
export function continuationPointToEpochMs(p: string): number;

/** Inclusive start-of-day UTC instant of a civil date. */
export function dateStartMs(d: IsoDate): number;
/** EXCLUSIVE end instant: start-of-day of the following day. Fixes Defect B/C. */
export function dateEndExclusiveMs(d: IsoDate): number;
```

`dateEndExclusiveMs` is the whole point. `windowTo` is an **inclusive civil date**;
comparing an instant against it requires the *exclusive* instant one day later.
That single change removes both the dropped-resume-point bug and the truncated
`hasMore`.

Rewritten comparisons in `src/sync.ts`:

```ts
const storedMs = stored == null ? null : continuationPointToEpochMs(stored);
const fromMs   = dateStartMs(options.windowFrom);
const toMsExcl = dateEndExclusiveMs(options.windowTo);

const applied = storedMs !== null && storedMs >= fromMs && storedMs < toMsExcl ? stored : null;

// monotonic HWM, by instant — never by string
const persisted =
  storedMs === null ? fetched
  : fetched === null ? stored
  : continuationPointToEpochMs(fetched) >= storedMs ? fetched : stored;

const hasMore = fetched !== undefined && continuationPointToEpochMs(fetched) < toMsExcl;
```

Note the guard becomes `< toMsExcl`, not `<= `. The persisted value remains the
**original verbatim string**; only the *decision* is made numerically.

### 3.5 API wire format

Drizzle returns `Date` objects; Fastify serialises them with `Date.prototype.toJSON`,
i.e. `YYYY-MM-DDTHH:MM:SS.sssZ`. So:

- `createdAt`, `itemsExtractedAt`, `requestedAt`, `startedAt`, `completedAt` become
  **uniformly `…T…Z`** on the wire. `requestedAt` and `createdAt` change shape —
  this is an observable, intentional API change, and it is what fixes Defect A.
- Frontend types in `web/src/api/client.ts` stay `string`. `new Date(x)` now parses
  correctly and portably.
- `issueDate`, `deliveryDate`, `windowFrom`, `windowTo` are unchanged.

### 3.6 Explicitly out of scope

Sync quota behaviour, `maxIterations`, KSeF request shapes, the categorization
engine, Phase 8 manual entry, and the 249-rows-all-`needs_review` observation.

---

## 4. Implementation plan

Five phases. **Phases 1–3 are the core work and should ship together.** Phase 4 is a
recommended but separable follow-up. Phase 5 is a documented decision, not code.

### Phase 0 — Prerequisites (do not skip)

1. Stop any running dev server. A stray `tsx watch src/api/main.ts` holds the SQLite
   file open in WAL mode and makes the backup unreliable.
2. Back up the live database. It holds real business data and is not committed:
   ```sh
   cp data/ksef-exporter.sqlite "data/ksef-exporter.backup-$(date +%Y%m%d-%H%M%S).sqlite"
   ```
   Ensure the backup path is covered by `.gitignore`.
3. Record the pre-migration invariants that Phase 2 must reproduce exactly:
   ```sql
   SELECT COUNT(*), MIN(created_at), MAX(created_at) FROM invoices;
   SELECT COUNT(*), MIN(requested_at), MAX(requested_at) FROM sync_runs;
   SELECT COUNT(*) FROM invoices WHERE items_extracted_at IS NULL;   -- expect 0
   SELECT COUNT(*) FROM sync_runs WHERE started_at IS NULL;          -- expect 3
   SELECT ROUND(SUM(gross_total), 2) FROM invoices;
   ```
4. Confirm the working tree is clean apart from the known in-flight edits to
   `src/sync.ts`, `src/sync.test.ts`, and `design/SYNC_CONTINUATION_POINT_ANALYSIS.md`.
   **This workstream overlaps `src/sync.ts` — land or rebase that work first.**

### Phase 1 — `src/time.ts` and the comparison fixes (no schema change yet)

Deliberately first, and independently shippable: it fixes Defects B and C without
touching a single column, so the riskiest behaviour change is isolated from the
riskiest data change.

1. Create `src/time.ts` per §3.4.
2. Create `src/time.test.ts`. Required cases:
   - `isIsoDate` accepts `2026-08-10`; rejects `10/08/2026`, `2026-8-10`,
     `2026-02-30`, `2026-08-10T00:00:00Z`, `''`.
   - `continuationPointToEpochMs` on all four live-format samples from §2.4,
     asserting the exact millisecond values in that table.
   - **Regression for Defect C:** `+02:00` vs `+00:00` at the same wall time — assert
     the `+02:00` value is the *earlier* instant, i.e. the opposite of string order.
   - `dateEndExclusiveMs('2026-08-31')` equals `dateStartMs('2026-09-01')`.
3. Rewrite the three comparison sites in `src/sync.ts` per §3.4. Keep
   `laterContinuationPoint`'s name; replace its body and **delete its false comment**.
4. Add `src/sync.test.ts` cases:
   - **Regression for Defect B:** stored point `2026-08-10T15:32:59.989017+00:00`,
     window `2026-08-01`…`2026-08-10` → the point **is applied**, and
     `sync.continuation.conflict` is **not** logged. This test fails before the fix.
   - **Regression for Defect C:** fetched point `2026-08-31T05:00:00+00:00`,
     `windowTo = '2026-08-31'` → `hasMore === true`. Fails before the fix.
   - HWM never rewinds when the fetched point is chronologically earlier but
     lexicographically greater.
5. Tighten `syncBodySchema` in `src/api/server.ts:56-58` from `z.string().min(1)` to
   an ISO-date schema, plus a `.refine(windowFrom <= windowTo)`. Add API tests for
   400 on `2026-13-01`, `10/08/2026`, and a reversed window.
6. Run `pnpm test` and `pnpm run typecheck`. **Commit here.**

### Phase 2 — Schema type migration: expand → migrate → contract

The critical constraint: **drizzle-kit's generated SQLite table rebuild copies
columns verbatim** (`INSERT INTO __new_t SELECT … FROM t`). A direct `text` →
`integer({mode:"timestamp_ms"})` change in `schema.ts` would emit exactly that, and
because these tables are not `STRICT`, `'2026-08-10 15:35:01'` would be *retained as
TEXT* in a column that now claims INTEGER affinity. Silent, type-invisible
corruption. Do **not** change the column type in one step.

Three migrations instead, each leaving the database in a valid, resumable state.

**Migration 0004 — expand (generated).** In `schema.ts`, *add* the new columns
alongside the old, all nullable:

```ts
createdAtMs:        integer("created_at_ms",        { mode: "timestamp_ms" }),
itemsExtractedAtMs: integer("items_extracted_at_ms",{ mode: "timestamp_ms" }),
requestedAtMs:      integer("requested_at_ms",      { mode: "timestamp_ms" }),
startedAtMs:        integer("started_at_ms",        { mode: "timestamp_ms" }),
completedAtMs:      integer("completed_at_ms",      { mode: "timestamp_ms" }),
```

`pnpm run db:generate` → pure `ALTER TABLE … ADD COLUMN`. No rebuild, no data
touched, trivially reversible.

**Migration 0005 — backfill (custom).** Author it with
`pnpm exec drizzle-kit generate --custom --name backfill_instant_columns`. This
creates an empty migration for you to write; it is *authoring* a custom migration,
not hand-editing a generated one, and is the sanctioned path for data migrations.

```sql
UPDATE invoices SET
  created_at_ms         = CAST(ROUND((julianday(created_at)         - 2440587.5) * 86400000.0) AS INTEGER),
  items_extracted_at_ms = CAST(ROUND((julianday(items_extracted_at) - 2440587.5) * 86400000.0) AS INTEGER);
--> statement-breakpoint
UPDATE sync_runs SET
  requested_at_ms = CAST(ROUND((julianday(requested_at) - 2440587.5) * 86400000.0) AS INTEGER),
  started_at_ms   = CAST(ROUND((julianday(started_at)   - 2440587.5) * 86400000.0) AS INTEGER),
  completed_at_ms = CAST(ROUND((julianday(completed_at) - 2440587.5) * 86400000.0) AS INTEGER);
```

`julianday(NULL)` is `NULL`, so the 3 `sync_runs` rows with NULL timings stay NULL
correctly — no `CASE` needed. Verified exact to the millisecond for every live format
in §2.4.

Then verify, before proceeding:

```sql
-- must all be 0
SELECT COUNT(*) FROM invoices  WHERE created_at_ms IS NULL;
SELECT COUNT(*) FROM invoices  WHERE items_extracted_at IS NOT NULL AND items_extracted_at_ms IS NULL;
SELECT COUNT(*) FROM sync_runs WHERE requested_at_ms IS NULL;
-- must be 3 / 3, matching the pre-migration NULL counts
SELECT COUNT(*) FROM sync_runs WHERE started_at_ms IS NULL;
SELECT COUNT(*) FROM sync_runs WHERE completed_at_ms IS NULL;
-- round-trip: must return 0 rows
SELECT id, created_at, datetime(created_at_ms/1000,'unixepoch') FROM invoices
  WHERE datetime(created_at_ms/1000,'unixepoch') <> created_at;
SELECT id, items_extracted_at FROM invoices
  WHERE items_extracted_at IS NOT NULL
    AND strftime('%Y-%m-%dT%H:%M:%fZ', items_extracted_at_ms/1000.0, 'unixepoch') <> items_extracted_at;
-- ordering must be unchanged
SELECT COUNT(*) FROM (
  SELECT id, ROW_NUMBER() OVER (ORDER BY requested_at) a,
             ROW_NUMBER() OVER (ORDER BY requested_at_ms) b FROM sync_runs
) WHERE a <> b;
```

**Migration 0006 — contract (generated).** In `schema.ts`: delete the five old TEXT
columns, rename the `*Ms` properties to their final names mapped to the original
column names (`created_at`, `items_extracted_at`, `requested_at`, `started_at`,
`completed_at`), mark `created_at` and `requested_at` `NOT NULL`, drop both
`sql\`(current_timestamp)\`` defaults, and add `$defaultFn(() => new Date())` to
both. Add the §3.3 CHECK constraints and the `issue_date` index in the same step.

`pnpm run db:generate` will prompt for column-rename detection. **Answer "rename",
not "drop + create"** — the latter would discard the data backfilled in 0005. Read
the generated SQL before applying it; if it contains a bare `DROP COLUMN` of a `_ms`
column, regenerate.

Keeping the original SQL column names means `scripts/export-invoices.py` and ad-hoc
SQL keep resolving the same names, though their *values* change type — see Phase 3.

Then verify: re-run the Phase 0 invariant queries and confirm
`PRAGMA table_info(invoices)` reports `created_at INTEGER NOT NULL` with
`dflt_value NULL`, and that `SELECT typeof(created_at) …` returns `integer` for all
249 rows.

### Phase 3 — Application code

Backend:

- `src/db/invoices.ts` — `InvoiceRow.createdAt: Date`, `itemsExtractedAt: Date | null`.
  Also replace the month filter with a sargable range:
  `gte(issueDate, \`${month}-01\`)` and `lt(issueDate, nextMonthStart)`.
- `src/db/invoice-items.ts:106` — `.set({ itemsExtractedAt: new Date() })`.
- `src/db/sync-runs.ts` — `requestedAt: Date`, `startedAt`/`completedAt: Date | null`.
- `src/api/server.ts:144,168,197` — drop the three `.toISOString()` calls; pass
  `new Date(ms)` directly.
- `src/invoices/backfill-items.ts:138` and `src/sync.ts` — the `isNull` /
  `=== null` checks are unaffected by the type change; confirm with tests, do not
  rewrite.
- `src/tools/*.ts` and `scratch/experiment-continuation.ts` — update fixtures.

Frontend (`web/`):

- `web/src/api/client.ts` — types stay `string`; add a comment recording that the
  five instant fields are now uniformly ISO-8601 UTC.
- `web/src/components/RecentImports.tsx` — `:153` is now correct as written, but
  route it plus `:38` and `:40` through one shared `formatInstant(iso: string)`
  helper so all three render identically instead of two showing raw ISO strings.
- Update `RecentImports.test.tsx`, `App.test.tsx`, `InvoicesTable.test.tsx`,
  `InvoicesSummary.test.tsx` fixtures. They already use `…T…Z` values, so they
  should need little change — which is itself a signal that the tests never covered
  the space-separated format the database actually held. **Add a test that pins the
  rendered `requestedAt` output for a known UTC instant under a fixed `TZ`**, so
  Defect A cannot silently return.

`scripts/export-invoices.py`:

- `created_at` is now an integer. Convert on read
  (`datetime.fromtimestamp(ms / 1000, tz=timezone.utc)`) and apply an Excel datetime
  number format, or select
  `strftime('%Y-%m-%d %H:%M:%S', created_at/1000, 'unixepoch') AS created_at`.
- Its `issue_date` range filters and `ORDER BY` are unaffected — `issue_date` remains
  TEXT — but re-run the script and diff one exported month against a pre-migration
  export to confirm.

Validation gate: `pnpm test`, `pnpm --dir web test`, `pnpm run typecheck`,
`pnpm --dir web run typecheck`, `pnpm run lint`. Then a running-app smoke check:
start `pnpm run dev:api`, log in, confirm the invoice list renders, trigger one
import, and confirm Recent Imports shows the correct local time. **Kill the dev
server afterwards** — a forgotten one holds port 3000 and the SQLite WAL.

### Phase 4 — Money as integer minor units (recommended, separable)

Floating-point `REAL` is the wrong type for money. Convert *monetary totals* to
`INTEGER` minor units (grosze):

- `invoices.gross_total` (FA(3) `P_15`)
- `invoice_items.net_value`, `gross_value`, `vat_value`, `discount`, `excise`

**Do not convert** `quantity`, `unit_price_net`, `unit_price_gross`,
`exchange_rate`, or `vat_rate_oss`. FA(3) permits more than two decimal places on
quantities, unit prices, and exchange rates, so a 2-decimal integer would lose data.
This asymmetry is the reason Phase 4 is separate: it needs its own judgement call per
column, not a blanket rule.

**Prerequisite check** — run before committing to this phase, to confirm the
2-decimal assumption on the columns being converted:

```sql
SELECT 'gross_total', COUNT(*) FROM invoices     WHERE gross_total <> ROUND(gross_total, 2)
UNION ALL SELECT 'net_value',  COUNT(*) FROM invoice_items WHERE net_value  <> ROUND(net_value, 2)
UNION ALL SELECT 'gross_value',COUNT(*) FROM invoice_items WHERE gross_value<> ROUND(gross_value,2)
UNION ALL SELECT 'vat_value',  COUNT(*) FROM invoice_items WHERE vat_value  <> ROUND(vat_value, 2)
UNION ALL SELECT 'discount',   COUNT(*) FROM invoice_items WHERE discount   <> ROUND(discount, 2)
UNION ALL SELECT 'excise',     COUNT(*) FROM invoice_items WHERE excise     <> ROUND(excise, 2);
```

Any non-zero count means that column is not 2-decimal money and must be excluded.

Same expand/migrate/contract shape as Phase 2, with
`CAST(ROUND(col * 100) AS INTEGER)` as the conversion and
`SUM(col_minor) = CAST(ROUND(SUM(col) * 100) AS INTEGER)` as the verification.
`src/ksef/invoice-parser.ts`'s `parseAmount` gains a minor-units variant.
Frontend `.toFixed(2)` becomes `(v / 100).toFixed(2)`; `InvoicesSummary` sums exact
integers, which removes the accumulated float error outright.

### Phase 5 — Decision: do **not** adopt `STRICT` tables (record only)

`STRICT` is available (SQLite 3.53.0, verified) and would enforce the new integer
columns at the storage layer. But drizzle-kit 0.31.10 cannot emit `STRICT`, and it
regenerates full `CREATE TABLE` statements from its own snapshot JSON during every
table rebuild — so a hand-added `STRICT` keyword would be silently dropped the next
time any column changes, leaving a false sense of enforcement. The CHECK constraints
in §3.3, which drizzle-kit *does* manage, cover the same ground durably. Revisit if
drizzle-kit gains `STRICT` support.

---

## 5. Risk register

| Risk                                                                             | Likelihood | Mitigation                                                                                               |
| :------------------------------------------------------------------------------- | :--------- | :------------------------------------------------------------------------------------------------------- |
| Drizzle-kit "drop + create" instead of "rename" in 0006, discarding the backfill | Medium     | Read the generated SQL before applying; verification queries after 0005 *and* after 0006; Phase 0 backup |
| A JS-side backfill is used by mistake, baking in the +2 h local-time error       | Medium     | §2.4 conclusion 2 is explicit; the backfill lives in a SQL migration, not a script                       |
| An instant is written in **seconds** instead of ms after the change              | Medium     | The `BETWEEN 946684800000 AND 4102444800000` CHECK rejects it at insert time                             |
| Conflict with the in-flight `src/sync.ts` working-tree changes                   | High       | Phase 0 step 4: land or rebase that work first                                                           |
| KSeF changes its continuation-point format mid-migration                         | Low        | The token stays verbatim TEXT; only parsing is centralised, in one tested function                       |
| Excel export breaks silently on the new integer `created_at`                     | Medium     | Phase 3 requires diffing one exported month against a pre-migration export                               |
| Adding CHECKs forces table rebuilds that fail on existing data                   | Low        | §2.2/§2.3 confirm zero violating rows today for every proposed constraint                                |

## 6. Definition of done

- [ ] `src/time.ts` exists with tests pinning the exact epoch-ms values from §2.4.
- [ ] Regression tests for Defects A, B, and C exist and **fail on the pre-fix code**.
- [ ] Migrations 0004, 0005, 0006 applied; all §4 verification queries return the
      expected values.
- [ ] `PRAGMA table_info` reports INTEGER for all five instant columns, with no SQL
      default on `created_at` / `requested_at`.
- [ ] `pnpm test`, `pnpm --dir web test`, both typechecks, and `pnpm run lint` pass.
- [ ] Running-app smoke check done and the dev server killed.
- [ ] `scripts/export-invoices.py` output diffed against a pre-migration export.
- [ ] `design/IMPLEMENTATION_PLAN.md` updated with the outcome and actual test counts.
