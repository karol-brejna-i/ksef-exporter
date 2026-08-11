# KSeF Exporter — Invoice Line Items: Persistence & Display

**Last updated:** 2026-08-11

**Status:** Plan — not yet implemented.

**Companion to** [`SPEC.md`](./SPEC.md) and [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md).
This is a standalone workstream document (same pattern as
[`IMPORT_OBSERVABILITY_PLAN.md`](./IMPORT_OBSERVABILITY_PLAN.md)): it does **not** renumber
or replace Phase 8 (manual entry, HU-02), which remains the next numbered phase.

**Audience:** Developers / AI coding agents. This document is self-contained — everything
needed to execute it is here; the SPEC/plan references are for wider context only.

---

## 1. Purpose

Persist and display the **line items** of each imported purchase invoice.

Today the application stores one flat header row per invoice and the complete invoice XML,
but nothing parses, stores, or shows the individual lines. The owner can see *that* an
Eurocash invoice was −4 521.36 PLN, but not *what was on it*.

SPEC §3.4 deliberately deferred this: *"Line items (optional for v1 if header-level
categorization suffices — categorization in the original spreadsheet was done at the whole
invoice level, not per line item)."* That trade-off was correct for categorization, and
categorization stays header-level. What's changed is that the owner now wants to *inspect*
invoices, and there is no way to do that without reading raw XML out of SQLite by hand.

**The key enabling fact:** because SPEC §3.4 also required retaining `raw_xml`, every line
item of all 249 already-imported invoices is **already stored locally**. Closing this gap
is a pure parse-and-project change:

- **no new KSeF API calls**,
- **no re-import**,
- **no consumption of the `POST /invoices/exports` quota** (20 req/h — the tightest limit
  in the whole API, and the cause of a real production incident; see SPEC §3.3).

### In scope

- A new `invoice_items` table covering the full FA(3) `FaWiersz` structure.
- Item extraction in the existing invoice parser.
- Backfill of existing invoices from stored `raw_xml`.
- Item persistence during new imports.
- A read-only API endpoint and an expandable-row UI to view items.

### Explicitly out of scope

- **Item-level categorization.** Categorization stays header-level (SPEC §3.4/§4). Items
  are for human inspection, not a new Tier-1 input.
- **Re-importing anything from KSeF.** The data is already local.
- **Changing money representation.** Amounts stay `REAL` to match the existing
  `invoices.gross_total`; see §5.1 for the caveat and the tolerance rule that replaces a
  refactor.
- **Item-level filtering/search, pagination, or export.** See §9.
- **Editing items.** Items are derived data; `raw_xml` is the source of truth.

---

## 2. Current state

### 2.1 Database schema

`data/ksef-exporter.sqlite`, defined in [`src/db/schema.ts`](../src/db/schema.ts),
migrations `0000`–`0002` in `drizzle/migrations/`. Five tables:

| Table                  | Purpose                                                             |
| ---------------------- | ------------------------------------------------------------------- |
| `invoices`             | One flat row per document (KSeF or manual), **plus full `raw_xml`** |
| `categories`           | Media / Zakup towarów / Inne (SPEC §2.6)                            |
| `categorization_rules` | Tier-1 rules: `(match_type, match_value) → category_id`             |
| `sync_state`           | HWM continuation point per KSeF subject type                        |
| `sync_runs`            | Import-run history + diagnostics (SPEC §2.2 NFR 5)                  |

`invoices` columns:

```
id, source ('ksef'|'manual'), ksef_number (unique, nullable),
invoice_number, seller_nip, seller_name, buyer_nip, buyer_name,
issue_date, gross_total REAL, currency, raw_xml TEXT,
category_id, categorization_confidence ('matched'|'needs_review'), created_at
```

**There is no child table of any kind.** `invoices` is the only place invoice data lives.

Migrations are generated with `pnpm run db:generate` (drizzle-kit) and applied
automatically on startup by `createDb()` in [`src/db/client.ts`](../src/db/client.ts),
which also sets `foreign_keys = ON` — so `ON DELETE CASCADE` is enforced at runtime.

### 2.2 Live data snapshot (2026-08-11)

| Metric                    | Value                                  |
| ------------------------- | -------------------------------------- |
| Invoices                  | 249 (all `source = 'ksef'`, all `PLN`) |
| Issue-date range          | 2026-06-30 → 2026-08-10                |
| Distinct sellers (by NIP) | 55                                     |
| Invoices with `raw_xml`   | 249 / 249 (0 null, 0 empty)            |
| `raw_xml` size            | 1 572 – 23 259 bytes (avg 5 985)       |
| Sync runs recorded        | 8                                      |

### 2.3 Where the relevant code lives

| Concern                        | File                                                                              | Notes                                                                                                                                      |
| ------------------------------ | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| XML → flat record              | [`src/ksef/invoice-parser.ts`](../src/ksef/invoice-parser.ts)                     | `parsePurchaseInvoiceXml()`; `fast-xml-parser` with `removeNSPrefix: true`; throws `InvoiceParsingError` on missing required header fields |
| KSeF fetch adapter             | [`src/ksef/invoices.ts`](../src/ksef/invoices.ts)                                 | `fetchPurchaseInvoices()` — wraps the SDK's incremental-export workflow, calls the parser per XML file                                     |
| Persistence                    | [`src/db/invoices.ts`](../src/db/invoices.ts)                                     | `insertKsefInvoiceIfNotExists()` (idempotent), `listInvoices()`, `updateInvoiceCategory()`                                                 |
| Orchestration                  | [`src/sync.ts`](../src/sync.ts)                                                   | `syncPurchaseInvoices()` — fetch → persist → categorize, emits `SyncDiagnostics`                                                           |
| API                            | [`src/api/server.ts`](../src/api/server.ts)                                       | Fastify, DI'd; `GET /invoices`, `PATCH /invoices/:id/category`, `POST /sync`, `GET /sync/runs`                                             |
| UI table                       | [`web/src/components/InvoicesTable.tsx`](../web/src/components/InvoicesTable.tsx) | Date / Seller / Amount / Category dropdown / Status                                                                                        |
| UI expandable-detail precedent | [`web/src/components/RecentImports.tsx`](../web/src/components/RecentImports.tsx) | `RunDetails` uses a plain `<details><summary>` — reuse this pattern                                                                        |
| API client                     | [`web/src/api/client.ts`](../web/src/api/client.ts)                               | Typed `request()` wrapper, `ApiError` carries HTTP status                                                                                  |

### 2.4 The gap, stated precisely

Line items are **100 % present** in `invoices.raw_xml` and **0 % queryable**. There is no
table, no parsing, no endpoint, and no UI for them.

---

## 3. Structure of the XML in `invoices.raw_xml`

Everything in this section was **measured against all 249 rows**, and cross-checked
against the authoritative FA(3) schema bundled with the pinned SDK:
`node_modules/ksef-client/src/documents/fa3/schemas/schemat_FA(3)_v1-0E.xsd`
(`ksef-client@0.7.1`).

### 3.1 Document-level shape

```
Faktura
├── Naglowek            KodFormularza (kodSystemowy="FA (3)"), WariantFormularza, DataWytworzeniaFa, SystemInfo
├── Podmiot1            seller     → DaneIdentyfikacyjne/{NIP,Nazwa}, Adres
├── Podmiot2            buyer      → DaneIdentyfikacyjne/{NIP,Nazwa}, Adres
├── Podmiot3            optional third party (payer, recipient, …)
├── Fa
│   ├── KodWaluty, P_1 (issue date), P_2 (invoice number), P_6 (delivery date)
│   ├── P_13_x / P_14_x   per-VAT-rate net / VAT totals
│   ├── P_15              gross total  ← the only total the app stores today
│   ├── Adnotacje         statutory markers
│   ├── RodzajFaktury     VAT | KOR | ZAL | ROZ | UPR | KOR_ZAL | KOR_ROZ
│   ├── DaneFaKorygowanej repeated, only on corrections
│   ├── FaWiersz *        ← THE LINE ITEMS (minOccurs=0, maxOccurs=10000)
│   └── Platnosc, WarunkiTransakcji, …
└── Stopka              Rejestry (PelnaNazwa, REGON, BDO)
```

### 3.2 Schema-version and serialization variation

| Dimension                    | Finding                                                                                                                                |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| FA version                   | **249 / 249 are FA(3)** — `WariantFormularza = 3`, namespace `http://crd.gov.pl/wzor/2025/06/25/13775/`. No FA(2) in the current data. |
| Namespace prefix             | **Three styles**: unprefixed `<Faktura xmlns="…">` (139), `<tns:Faktura>` (57), `<ns0:Faktura>` (53)                                   |
| Extra namespace declarations | Some documents also declare `xsi`, `xsd`, `etd` on the root; harmless                                                                  |
| XML declaration              | `encoding="utf-8"` and `encoding="UTF-8"`, some with `standalone="no"`                                                                 |
| Whitespace                   | Both minified (single line) and pretty-printed/indented                                                                                |
| Well-formedness              | **249 / 249 pass `xmllint --noout`. Zero malformed documents.**                                                                        |

**The existing parser already handles all of this.** `removeNSPrefix: true` in
[`src/ksef/invoice-parser.ts`](../src/ksef/invoice-parser.ts) normalizes all three prefix
styles to bare element names, and `trimValues: true` absorbs the indentation. No
per-invoice branching is needed, and no new parser instance is required.

> Do not "fix" prefix handling by special-casing `tns:`/`ns0:`. It is already solved, and
> hard-coding prefixes would break on the next issuer that picks a fourth one.

### 3.3 `FaWiersz` — the line-item element

`FaWiersz` is `minOccurs="0" maxOccurs="10000"`. **Zero items is legal** (advance
invoices, and corrections under art. 106j ust. 3 pkt 2), even though it does not occur in
the current data. All 25 child elements are `minOccurs="0"` **except `NrWierszaFa`**, and
**none** declares `maxOccurs > 1` — so a flat, one-column-per-field table is lossless for
FA(3).

| Element       | XSD type               | Meaning                              | Invoices containing it |
| ------------- | ---------------------- | ------------------------------------ | ---------------------- |
| `NrWierszaFa` | `TNaturalny` (int > 0) | Line number **(required)**           | 249 / 100 %            |
| `UU_ID`       | `TZnakowy50`           | Issuer's unique line id              | 100 / 40.2 %           |
| `P_6A`        | `TDataT`               | Per-line delivery/service date       | 6 / 2.4 %              |
| `P_7`         | `TZnakowy512`          | Name of goods/service                | 249 / 100 %            |
| `Indeks`      | `TZnakowy50`           | Issuer's internal product code       | 131 / 52.6 %           |
| `GTIN`        | `TZnakowy20`           | Global Trade Item Number             | 108 / 43.4 %           |
| `PKWiU`       | `TZnakowy50`           | Polish goods/services classification | 80 / 32.1 %            |
| `CN`          | `TZnakowy50`           | Combined Nomenclature                | 45 / 18.1 %            |
| `PKOB`        | `TZnakowy50`           | Construction-objects classification  | 0 / 0 %                |
| `P_8A`        | `TZnakowy`             | Unit of measure                      | 246 / 98.8 %           |
| `P_8B`        | `TIlosci` (≤6 dp)      | Quantity                             | 249 / 100 %            |
| `P_9A`        | `TKwotowy2` (≤8 dp)    | Unit price **net**                   | 220 / 88.4 %           |
| `P_9B`        | `TKwotowy2` (≤8 dp)    | Unit price **gross**                 | 32 / 12.9 %            |
| `P_10`        | `TKwotowy2`            | Discounts / price reductions         | 25 / 10.0 %            |
| `P_11`        | `TKwotowy` (2 dp)      | Line value **net**                   | 222 / 89.2 %           |
| `P_11A`       | `TKwotowy`             | Line value **gross**                 | 36 / 14.5 %            |
| `P_11Vat`     | `TKwotowy`             | Line VAT amount                      | 31 / 12.4 %            |
| `P_12`        | `TStawkaPodatku`       | **VAT rate — enumerated string**     | 249 / 100 %            |
| `P_12_XII`    | `TProcentowy`          | OSS VAT rate (ch. 6a)                | 0 / 0 %                |
| `P_12_Zal_15` | `TWybor1` (`"1"`)      | Annex-15 goods marker                | 13 / 5.2 %             |
| `KwotaAkcyzy` | `TKwotowy`             | Excise duty included in price        | 4 / 1.6 %              |
| `GTU`         | `TGTU`                 | `GTU_01`…`GTU_13` reporting marker   | 24 / 9.6 %             |
| `Procedura`   | `TOznaczenieProcedury` | `WSTO_EE`, `IED`, `TT_D`, `I_42`, …  | 0 / 0 %                |
| `KursWaluty`  | `TIlosci`              | Per-line FX rate                     | 3 / 1.2 %              |
| `StanPrzed`   | `TWybor1` (`"1"`)      | **"state before correction" marker** | 20 / 8.0 %             |

Only `PKOB`, `P_12_XII`, and `Procedura` are absent from all current data. They are still
mapped: they are legal FA(3), and a single new seller can introduce them at any time.

Observed values of the less common fields, so tests can use realistic data: `GTU` is
`GTU_01` (160 rows), `GTU_02` (5), `GTU_12` (5); `P_12_Zal_15` is always the string `"1"`
(20 rows); `KursWaluty` is `"1.0000"` (3 rows — a PLN invoice stating a trivial rate);
`P_6A` is a plain `YYYY-MM-DD` date (6 invoices with per-line utility service dates).

### 3.4 Item volume

| Metric                                       | Value                                 |
| -------------------------------------------- | ------------------------------------- |
| **Total line items across all 249 invoices** | **2 437**                             |
| Items per invoice                            | min 1, max 61, avg 9.79               |
| Invoices with exactly 1 item                 | 71                                    |
| Invoices with 21+ items                      | 32 (largest: invoice `118`, 61 items) |
| Invoices with 0 items                        | 0 (but legal — see §3.3)              |

### 3.5 Three findings that dictate the schema

#### (a) `NrWierszaFa` is **not** unique within an invoice

**19 of 249 invoices repeat it.** Correction invoices (`RodzajFaktury = KOR`) emit each
line **twice** — once with `StanPrzed = 1` (state before the correction) and once without
(state after). Examples: invoice `4` has 22 `FaWiersz` but only 11 distinct line numbers;
invoice `74` has 34 rows / 17 distinct; invoice `37` has 2 rows / 1 distinct.

➡ **The unique key must be a document-order ordinal. Never `(invoice_id, NrWierszaFa)`.**
A unique constraint on the line number would reject 19 real invoices outright, and a
`ON CONFLICT` upsert on it would silently discard half of every correction invoice.

#### (b) `P_12` (VAT rate) must be stored as **TEXT**

`TStawkaPodatku` is an enumeration of *strings*:
`23`, `22`, `8`, `7`, `5`, `4`, `3`, `"0 KR"`, `"0 WDT"`, `"0 EX"`, `"zw"`, `"oo"`,
`"np I"`, `"np II"`.

Live data already contains non-numeric values — the distribution across all 2 437 items is
`5` (1 177), `23` (1 054), `8` (187), **`zw` (19)**.

➡ A numeric column would corrupt `zw`/`oo`/`np`/`0 WDT` on contact. Store verbatim TEXT.

#### (c) Net value is optional — every mapped column must be nullable

**151 of 2 437 item rows carry no `P_11` (net value).** These come from gross-priced
invoices (art. 106e ust. 7–8), which use `P_9B`/`P_11A` instead. All 151 have `P_11A`, so
no row is valueless — but any UI or aggregation that assumes `net_value` is present will
show blanks or zeros on **27 invoices**.

➡ Every column except `invoice_id` and `ordinal` is nullable, and the UI falls back from
net to gross.

### 3.6 A real integrity check — and the wrong version of it

Item net values reconcile **exactly** with the invoice header, *per VAT rate*:

| Sum of `P_11` for items where `P_12` = | equals header |
| -------------------------------------- | ------------- |
| `23`                                   | `P_13_1`      |
| `8`                                    | `P_13_2`      |
| `5`                                    | `P_13_3`      |
| `zw`                                   | `P_13_7`      |

**Measured: 202 of 202 eligible invoices matched within 0.01 PLN. Zero mismatches.**

Two exclusions, both principled rather than data-quality problems:

- **20 correction invoices** — `StanPrzed` before/after rows double-count by design.
- **27 gross-priced invoices** — some rows have no `P_11` at all (§3.5c).

> ⚠️ **Do not implement the naive check.** Comparing *total* item net against `P_13_1`
> fails on **176 of 249** invoices (91 have no `P_13_1` element at all; of the 158 that do,
> 85 still mismatch) — because `P_13_1` is only the **23 %-rate** net base,
> not the invoice net total. Header totals in FA are split per VAT rate
> (`P_13_1`/`P_14_1` = basic rate, `P_13_2`/`P_14_2` = first reduced, `P_13_3`/`P_14_3` =
> second reduced, `P_13_7` = exempt, …), which is exactly why the per-rate version above
> reconciles perfectly and the aggregate one doesn't.

Header-field presence for reference: `P_1` 100 %, `P_15` 100 %, `KodWaluty` 100 %,
`RodzajFaktury` 100 %, `Adnotacje` 100 %, `P_13_1` 63.5 %, `P_6` 59.4 %, `P_13_3` 47.8 %,
`P_13_2` 24.9 %, `P_13_7` 9.2 %, `TypKorekty` 1.2 %, `Zamowienie` 0 %.

### 3.7 `data/example.invoice.xml` — matches, with an important caveat

**No discrepancy to report.** The file's structure matches database samples: root
`<ns0:Faktura xmlns:ns0="http://crd.gov.pl/wzor/2025/06/25/13775/">`,
`WariantFormularza = 3`, 22 `FaWiersz`. Invoice `4` in the database is near-identical (also
`KOR`, 22 rows forming 11 `StanPrzed` pairs, `P_15 = −4521.36`); invoices `74` and `176`
are the same shape at larger scale, and 50+ others share the `ns0:` prefix style.

**But it is not a representative example**, and agents should not calibrate on it alone:

- It is a **`KOR` correction invoice** with nine `DaneFaKorygowanej` blocks and negative
  totals (`P_15 = −4521.36`).
- Its 22 `FaWiersz` are **11 `StanPrzed` pairs** — i.e. it exhibits exactly the
  duplicate-line-number pattern that only 8 % of real invoices have.
- It uses only one of the three namespace-prefix styles.

Better companions, already in the database:

| Invoice | Why it's useful                                                                  |
| ------- | -------------------------------------------------------------------------------- |
| `247`   | Simplest possible: 1 item, gross-priced (`P_9B`/`P_11A`, no `P_11`), `P_12 = zw` |
| `100`   | Utility invoice with per-line `P_6A` **and** `KwotaAkcyzy`                       |
| `203`   | Fully-coded goods: `UU_ID` + `Indeks` + `GTIN` + `PKWiU` + `CN`, `P_12 = 5`      |
| `84`    | `tns:` prefix, indented, both net **and** gross prices on the same line          |
| `176`   | 58 items, `ns0:` prefix, correction rows with `StanPrzed`                        |

### 3.8 Real `FaWiersz` samples (verbatim)

**Minimal, gross-priced, exempt** — invoice `247`, unprefixed, minified:

```xml
<FaWiersz><NrWierszaFa>1</NrWierszaFa><P_7>Usługa Administracyjna</P_7><P_8A>usł.</P_8A><P_8B>1</P_8B><P_9B>5500</P_9B><P_11A>5500</P_11A><P_12>zw</P_12></FaWiersz>
```

**Fully-coded goods line** — invoice `203`, unprefixed, minified:

```xml
<FaWiersz><NrWierszaFa>1</NrWierszaFa><UU_ID>71611272</UU_ID><P_7>Stripsy z kurczaka 1kg-AJFOOD(6)</P_7><Indeks>FARM-G-0025</Indeks><GTIN>5904978715476</GTIN><PKWiU>10.31.15.0</PKWiU><CN>1602 32 19</CN><P_8A>szt.</P_8A><P_8B>6.00</P_8B><P_9A>41.19</P_9A><P_11>247.14</P_11><P_12>5</P_12></FaWiersz>
```

**Utility line with per-line date and excise** — invoice `100`, unprefixed, indented:

```xml
<FaWiersz>
    <NrWierszaFa>1</NrWierszaFa>
    <P_6A>2026-06-30</P_6A>
    <P_7>590243831008467439 Energia elektryczna czynna szczytowa</P_7>
    <P_8A>kWh</P_8A>
    <P_8B>483</P_8B>
    <P_9A>0.59</P_9A>
    <P_11>284.97</P_11>
    <P_12>23</P_12>
    <KwotaAkcyzy>2.42</KwotaAkcyzy>
</FaWiersz>
```

**Both net and gross prices, `tns:` prefix** — invoice `84`:

```xml
<tns:FaWiersz>
    <tns:NrWierszaFa>1</tns:NrWierszaFa>
    <tns:P_7>SKU: 7832 / GIRLANDA 20M 20x E27</tns:P_7>
    <tns:P_8A>szt.</tns:P_8A>
    <tns:P_8B>5</tns:P_8B>
    <tns:P_9A>41.72</tns:P_9A>
    <tns:P_9B>51.32</tns:P_9B>
    <tns:P_11>208.62</tns:P_11>
    <tns:P_11A>256.6</tns:P_11A>
    <tns:P_12>23</tns:P_12>
</tns:FaWiersz>
```

**Correction pair — same `NrWierszaFa` twice** (from `data/example.invoice.xml`, `ns0:`):

```xml
<ns0:FaWiersz>
    <ns0:NrWierszaFa>1</ns0:NrWierszaFa>
    <ns0:P_7>_KEG 50 l TYCHY+LECH NOWA KAUCJA</ns0:P_7>
    <ns0:Indeks>371184</ns0:Indeks>
    <ns0:GTIN>20807474</ns0:GTIN>
    <ns0:P_8A>SZT</ns0:P_8A>
    <ns0:P_8B>3.000</ns0:P_8B>
    <ns0:P_9A>243.90</ns0:P_9A>
    <ns0:P_11>731.70</ns0:P_11>
    <ns0:P_12>23</ns0:P_12>
    <ns0:StanPrzed>1</ns0:StanPrzed>     <!-- state BEFORE the correction -->
</ns0:FaWiersz>
<ns0:FaWiersz>
    <ns0:NrWierszaFa>1</ns0:NrWierszaFa>  <!-- SAME line number -->
    <ns0:P_7>_KEG 50 l TYCHY+LECH NOWA KAUCJA</ns0:P_7>
    <ns0:Indeks>371184</ns0:Indeks>
    <ns0:GTIN>20807474</ns0:GTIN>
    <ns0:P_8A>SZT</ns0:P_8A>
    <ns0:P_8B>0.000</ns0:P_8B>
    <ns0:P_9A>0.00</ns0:P_9A>
    <ns0:P_11>0.00</ns0:P_11>
    <ns0:P_12>23</ns0:P_12>              <!-- no StanPrzed = state AFTER -->
</ns0:FaWiersz>
```

### 3.9 Other inconsistencies worth knowing

- **Units of measure are free text and wildly inconsistent** across issuers:
  `szt.` (804), `SZT` (596), `kg.` (195), `kg` (167), `CS` (153), `opk.` (100),
  `Sztuki` (70), `KG` (59), `szt` (43), `op.` (43), `kar.` (40), `Kilogram` (35),
  `Opakowanie` (16), `kWh` (15), `KG.` (13), … Store **verbatim**; do not normalize. Any
  future per-unit aggregation needs a deliberate mapping layer, not a guess here.
- **Decimal formatting varies**: `1`, `1.0000`, `6.00`, `2450.000000`, `0.0`. `TKwotowy2`
  allows up to 8 decimal places and `TIlosci` up to 6, so unit prices are not always
  2-decimal.
- **Code fields are not reliably numeric**: `Indeks` ranges from `371184` to
  `FARM-G-0025` to `GROW CREMA 800'`; `UU_ID` from `71611272` to
  `5a9d9266-1fca-4bbe-a347-0d4af9a5da12` to `nA1sB1Duau`; `CN` contains spaces
  (`1602 32 19`); `PKWiU` is dotted (`10.31.15.0`). All must be TEXT (see §5.2).
- **3 invoices have no `P_8A`** (unit) on any line.
- `PKOB`, `P_12_XII`, `Procedura` are absent from all current data but are valid FA(3)
  and are mapped anyway. `P_12_Zal_15`, `GTU`, `KursWaluty` appear in a small share.

---

## 4. Unrelated bug found while investigating (flagged, not fixed here)

`seedCategorizationRules()`
([`src/categorization/seed-rules.ts`](../src/categorization/seed-rules.ts)) is **never
called from production code** — only from its own tests. `grep -rn seedCategorizationRules
src/` matches the definition and the test file, nothing else;
[`src/api/main.ts`](../src/api/main.ts) does not call it.

Consequence in the live database: **0 categories, 0 rules, and all 249 invoices sitting at
`categorization_confidence = 'needs_review'` with `category_id = NULL`** — so the UI's
category dropdown renders empty and Phase 4/6's categorization is effectively inert in
practice.

This is out of scope here, but it **will** confuse anyone verifying the new items UI (the
Category column will look broken). Fix separately by calling `seedCategorizationRules(db)`
during startup in `src/api/main.ts` — Phase 4 already documents it as idempotent and safe
to call on every boot.

---

## 5. Implementation plan

Engineering conventions from [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) apply in
full: **TypeScript strict, Vitest tests are mandatory and must actually pass, no real
network calls in unit tests, Biome clean, `pnpm run typecheck` clean.** A step is not done
until its tests exist and pass.

### Step 1 — Schema: the `invoice_items` table

Add to [`src/db/schema.ts`](../src/db/schema.ts), then generate the migration with
`pnpm run db:generate` (produces `drizzle/migrations/0003_*.sql`; `createDb()` applies it
automatically on next startup).

```ts
export const invoiceItems = sqliteTable(
  "invoice_items",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    invoiceId: integer("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    /**
     * 1-based position of this FaWiersz in document order. This -- NOT
     * NrWierszaFa -- is the stable identity of a line: correction invoices
     * (RodzajFaktury = KOR) repeat NrWierszaFa for the before/after pair
     * (19 of 249 real invoices do), so a unique key on the line number
     * would reject or silently halve them.
     */
    ordinal: integer("ordinal").notNull(),

    lineNumber: integer("line_number"),            // NrWierszaFa
    uuId: text("uu_id"),                           // UU_ID
    deliveryDate: text("delivery_date"),           // P_6A
    name: text("name"),                            // P_7
    indexCode: text("index_code"),                 // Indeks
    gtin: text("gtin"),                            // GTIN
    pkwiu: text("pkwiu"),                          // PKWiU
    cn: text("cn"),                                // CN
    pkob: text("pkob"),                            // PKOB
    /** P_8A, stored verbatim -- issuers write szt./SZT/Sztuki/kg./KG interchangeably. */
    unit: text("unit"),
    quantity: real("quantity"),                    // P_8B
    unitPriceNet: real("unit_price_net"),          // P_9A
    unitPriceGross: real("unit_price_gross"),      // P_9B
    discount: real("discount"),                    // P_10
    netValue: real("net_value"),                   // P_11  (absent on gross-priced lines)
    grossValue: real("gross_value"),               // P_11A
    vatValue: real("vat_value"),                   // P_11Vat
    /**
     * P_12. TEXT, never numeric: TStawkaPodatku enumerates "zw", "oo",
     * "np I", "np II", "0 KR", "0 WDT", "0 EX" alongside 23/22/8/7/5/4/3.
     * Live data already contains "zw".
     */
    vatRate: text("vat_rate"),
    vatRateOss: real("vat_rate_oss"),              // P_12_XII
    annex15: integer("annex15", { mode: "boolean" }),        // P_12_Zal_15
    excise: real("excise"),                        // KwotaAkcyzy
    gtuCode: text("gtu_code"),                     // GTU
    procedureCode: text("procedure_code"),         // Procedura
    exchangeRate: real("exchange_rate"),           // KursWaluty
    /** StanPrzed: this row is the pre-correction state of its line number. */
    correctionStateBefore: integer("correction_state_before", { mode: "boolean" }),
  },
  (table) => [
    uniqueIndex("invoice_items_invoice_ordinal_unique").on(table.invoiceId, table.ordinal),
    index("invoice_items_invoice_id_idx").on(table.invoiceId),
  ],
);
```

Every column except `invoice_id` and `ordinal` is nullable — all 24 mapped `FaWiersz`
children are `minOccurs="0"` in the XSD, and even `NrWierszaFa` is kept nullable so a
degenerate line can still be stored rather than dropped (§6).

Also add one column to `invoices`:

```ts
/**
 * When line items were last derived from raw_xml. NULL = never attempted,
 * which is what makes the backfill resumable and idempotent, and what lets
 * the UI distinguish "not extracted yet" from "genuinely has zero items"
 * (FaWiersz is minOccurs=0, so zero items is legal).
 */
itemsExtractedAt: text("items_extracted_at"),
```

**Design notes to preserve:**

- **`real` for amounts** matches the existing `invoices.gross_total` precedent. It is a
  known wart (binary floats for money), but changing the money representation is a
  separate, larger refactor and is explicitly out of scope. The mitigation is the
  0.01-tolerance rule in §6, plus the fact that `raw_xml` remains the source of truth for
  exact values. `real` (IEEE double, ~15–16 significant digits) comfortably represents
  `TKwotowy2`'s 22 total / 8 fractional digits for realistic invoice amounts.
- **No `ON CONFLICT` upsert path.** Items are replaced wholesale per invoice (Step 3), so
  the only conflict target is `(invoice_id, ordinal)` inside a transaction that just
  deleted them.
- **`ON DELETE CASCADE`** is real here because `createDb()` sets `foreign_keys = ON`.

### Step 2 — Parser: extract items

Extend [`src/ksef/invoice-parser.ts`](../src/ksef/invoice-parser.ts). Reuse the existing
`asRecord` / `asString` / `parseAmount` helpers and the single shared `XMLParser`
instance — do not add a second parser.

```ts
export interface InvoiceItemRecord {
  ordinal: number;                       // 1-based document order
  lineNumber: number | null;             // NrWierszaFa
  // …one field per §5 Step 1 column…
  vatRate: string | null;                // P_12, verbatim text
  correctionStateBefore: boolean | null; // StanPrzed
}

export interface PurchaseInvoiceRecord {
  // …existing header fields…
  items: InvoiceItemRecord[];
}
```

Two non-obvious gotchas that must be handled:

1. **Single-child collapse.** `fast-xml-parser` returns a plain object, not an array, when
   there is exactly one `FaWiersz` — which is the case for **71 of 249** invoices. Add an
   `asArray()` helper next to the existing `asRecord()`:

   ```ts
   function asArray(value: unknown): unknown[] {
     if (Array.isArray(value)) return value;
     return value === undefined || value === null ? [] : [value];
   }
   ```

2. **Set `parseTagValue: false` on the shared `XMLParser`.** Today the parser coerces
   numeric-looking text to JS numbers, which is actively harmful for items:
   - a `GTIN`/`Indeks`/`PKWiU` with leading zeros would be silently mangled
     (`"0012345678905"` → `12345678905`);
   - `P_12` would become a *mixed* `number | string` type (`23` vs `"zw"`), inviting bugs;
   - trailing-zero precision in `P_8B`/`P_9B` (`"2450.000000"`) is lost before we ever see
     it.

   `asString()` and `parseAmount()` already accept strings, so this is a safe tightening
   rather than a rewrite — but the existing `src/ksef/invoice-parser.test.ts` and
   `src/ksef/invoices.test.ts` **must be re-run** to confirm no header regression. Note
   `asString()`'s `typeof value === "number"` branch becomes dead but harmless; leave it as
   defensive code.

**Header parsing behaviour is unchanged** — it still throws `InvoiceParsingError` when a
required header field is missing. Item extraction is best-effort and never throws out of
the item loop; see §6.

### Step 3 — Repository: `src/db/invoice-items.ts`

A thin, typed wrapper matching the style of the other `src/db/*.ts` modules — no business
logic.

```ts
/** Delete-then-insert in a single transaction: idempotent re-extraction. */
export async function replaceInvoiceItems(db, invoiceId: number, items: NewInvoiceItem[]): Promise<void>
export async function listInvoiceItems(db, invoiceId: number): Promise<InvoiceItemRow[]>   // ORDER BY ordinal
export async function countInvoiceItemsByInvoice(db, invoiceIds: number[]): Promise<Map<number, number>>
```

`replaceInvoiceItems` also stamps `invoices.items_extracted_at` inside the same
transaction, so "items written" and "extraction recorded" can never disagree.

### Step 4 — Sync integration

In [`src/sync.ts`](../src/sync.ts)'s `syncPurchaseInvoices()`, after
`insertKsefInvoiceIfNotExists()`, write items when the invoice was **newly inserted** or
still has `items_extracted_at IS NULL`. Skip invoices already extracted, so re-running a
window stays cheap and idempotent (matching the existing "never clobber prior work"
principle used for categories).

Extend `SyncDiagnostics` with `itemsInsertedCount` and `itemsFailedCount`, add matching
nullable columns to `sync_runs`, and surface them through `POST /sync` →
`markSyncRunSuccess` → `GET /sync/runs` → `RunDetails`. This reuses the diagnostics
pipeline Phase 7 / `IMPORT_OBSERVABILITY_PLAN.md` already built; do not invent a parallel
mechanism. Emit `sync.items.started` / `sync.items.completed` / `sync.items.failed`
structured log events following the existing `sync.<stage>.<phase>` naming convention
(`stageOfEvent()` in [`src/api/server.ts`](../src/api/server.ts) parses three-part names).

### Step 5 — Backfill the 249 existing invoices

`src/invoices/backfill-items.ts` (`backfillInvoiceItems(db, options)`) plus a CLI wrapper
`src/tools/backfill-invoice-items.ts`, wired as `"backfill:items": "tsx
src/tools/backfill-invoice-items.ts"` — the same shape as the existing
`src/tools/reconcile.ts` / `extract:xlsx` scripts.

- Selects `WHERE raw_xml IS NOT NULL AND (items_extracted_at IS NULL OR :force)`.
- **Makes zero KSeF calls.** It only reads `invoices.raw_xml`. This is the whole point:
  no quota consumed, no re-import, no rate-limit exposure.
- Flags: `--dry-run` (parse and report, write nothing), `--force` (re-derive everything —
  use after a parser improvement), `--limit N`.
- Prints per-invoice results and a summary, plus the §3.6 per-VAT-rate reconciliation
  report as a **non-blocking** diagnostic.

**Expected result on the current database: 249 invoices → 2 437 items, 0 failures.**
Treat any deviation as a parser regression and investigate before proceeding.

### Step 6 — API: `GET /invoices/:id/items`

Add to [`src/api/server.ts`](../src/api/server.ts):

- Protected with the existing `fastify.authenticate` decorator (like every other route).
- Validate the route param with the **existing** `invoiceIdParamsSchema` — do not add a
  duplicate zod schema.
- 404 when the invoice doesn't exist; `{ items: InvoiceItemRow[] }` ordered by `ordinal`
  otherwise. An invoice with no items returns `{ items: [] }`, not a 404.

Add `itemCount` to each row of the `GET /invoices` response (via
`countInvoiceItemsByInvoice`) so the UI can label the toggle and disable it when zero.

**Do not inline items into `GET /invoices`.** FA permits 10 000 lines per invoice, and the
current 249 invoices alone would add 2 437 nested rows to every list load. Lazy per-invoice
fetch keeps the landing view fast (Phase 7 made browsing the default screen).

### Step 7 — UI: expandable row

- [`web/src/api/client.ts`](../web/src/api/client.ts): add an `InvoiceItem` interface, an
  `itemCount: number` field on `Invoice`, and
  `fetchInvoiceItems(token, invoiceId): Promise<{ items: InvoiceItem[] }>` using the
  existing `request()` wrapper.
- New `web/src/components/InvoiceItemsTable.tsx`: presentational, receives `items`.
  Columns: `#` (line number), name, unit, quantity, **value** (`net_value`, falling back to
  `gross_value` when net is null — 27 invoices need this), VAT rate, VAT amount. Rows with
  `correctionStateBefore` are visually marked *"before correction"*, since they otherwise
  look like inexplicable duplicates.
- [`web/src/components/InvoicesTable.tsx`](../web/src/components/InvoicesTable.tsx): each
  row gains `<details><summary>Items ({itemCount})</summary>` which lazy-loads on first
  expand, caches per invoice id, shows a loading state and an `ApiError` message on
  failure. **Reuse the exact `<details>` pattern of `RunDetails` in
  [`RecentImports.tsx`](../web/src/components/RecentImports.tsx)** — no new UI dependency,
  no router, and the existing two-item nav is unchanged.

---

## 6. Handling malformed or incomplete XML

The current data is unusually clean (249/249 well-formed, 0 parse failures), so these rules
exist for future imports from new issuers — not for today's known problems. They are
deliberately more forgiving than the header rules.

1. **Item extraction must never fail an invoice import.** The header parse keeps throwing
   `InvoiceParsingError` — a wrong seller NIP or gross total is worse than no invoice at
   all. Items are different: they are *supplementary detail*, so on any item-level failure
   the invoice is still stored, `items_extracted_at` stays `NULL`,
   `itemsFailedCount` increments, and a `sync.items.failed` event is logged with the KSeF
   number. The backfill can retry it later without touching KSeF.
2. **Degrade per item, never drop rows.** A `FaWiersz` missing `P_7`, or with no amount
   fields at all, is still inserted with `NULL`s. `ordinal` preserves its position, and
   `raw_xml` stays available for inspection. A silently missing line is far worse than a
   visibly incomplete one.
3. **Zero items is a valid state, not an error.** `FaWiersz` is `minOccurs="0"`. Record
   `items_extracted_at` with an empty item set; the UI shows "No items recorded" and
   distinguishes that from `items_extracted_at IS NULL` ("not extracted yet").
4. **Unknown / future FA fields are ignored, not fatal.** FA(4) or a vendor extension must
   not break the import. Because `raw_xml` is retained, nothing is unrecoverable:
   `pnpm run backfill:items --force` re-derives every item after a parser improvement.
5. **Malformed XML** (not well-formed) already fails at the header stage with
   `InvoiceParsingError` before items are reached — no additional handling needed. Do not
   add an item-level XML-repair path.
6. **Reconciliation is a report, not a gate.** Use the §3.6 per-VAT-rate rule with a
   0.01 PLN tolerance, excluding invoices that have any `StanPrzed` row or any row without
   `P_11`. Log mismatches; never reject an invoice or refuse to store items because of one.
   The header `P_15` from KSeF remains authoritative for all money the app reports.
7. **Never present item sums as the invoice total.** `invoices.gross_total` (`P_15`) is the
   only authoritative total. Item values are for inspection.

---

## 7. Tests

Per the project convention, no step is complete until its tests exist **and pass**
(verified by running them).

**Parser** (`src/ksef/invoice-parser.test.ts`):
- multi-item invoice → correct count, order, and field mapping;
- **single-item invoice** → array of one, not a crash (the `asArray` collapse case);
- all three namespace-prefix styles (unprefixed / `tns:` / `ns0:`) parse identically;
- `P_12 = "zw"` survives as the string `"zw"`;
- gross-priced line (`P_9B`/`P_11A`, no `P_11`) → `netValue === null`, `grossValue` set;
- **correction invoice: two rows share `NrWierszaFa`, distinguished by `ordinal` and
  `correctionStateBefore`**;
- leading-zero `GTIN`/`Indeks` preserved as text (the `parseTagValue: false` guarantee);
- a malformed/empty `FaWiersz` block does not prevent the header from parsing;
- zero `FaWiersz` → `items: []`, no error.

**Repository** (`src/db/invoice-items.test.ts`): insert/list round-trip ordered by
`ordinal`; `replaceInvoiceItems` is idempotent (twice → same row count, no duplicates);
deleting an invoice cascades its items; `countInvoiceItemsByInvoice` over a mixed set.

**Sync** (`src/sync.test.ts`): items persisted on first import; **not** duplicated on
re-sync of the same window; an item-extraction failure leaves the invoice stored and
increments `itemsFailedCount`; diagnostics reach the `sync_runs` row.

**Backfill** (`src/invoices/backfill-items.test.ts`): processes only
`items_extracted_at IS NULL`; `--dry-run` writes nothing; `--force` re-derives already
extracted invoices; an invoice with `raw_xml IS NULL` is skipped, not failed.

**API** (`src/api/server.test.ts`): `GET /invoices/:id/items` happy path; empty-items
invoice returns `{ items: [] }`; unknown id → 404; no token → 401; non-numeric id → 400;
`GET /invoices` includes `itemCount`.

**UI** (`web/src/components/InvoiceItemsTable.test.tsx`,
`InvoicesTable.test.tsx`): collapsed by default with the count in the summary; items
fetched on first expand and **not** refetched on re-expand; net→gross fallback renders the
gross value; correction rows marked; API error surfaces a message without breaking the
table; `itemCount === 0` disables the toggle.

---

## 8. Verification

Definition of done — all of these, actually executed:

```bash
pnpm run migrate                 # 0003 applies cleanly to the real database
pnpm run backfill:items --dry-run # reports 249 invoices / 2437 items / 0 failures
pnpm run backfill:items          # writes them
sqlite3 data/ksef-exporter.sqlite \
  "select count(*) from invoice_items;"                     # → 2437
sqlite3 data/ksef-exporter.sqlite \
  "select count(*) from invoices where items_extracted_at is null;"  # → 0
pnpm test                        # backend suite (was 132 passing before this work)
pnpm --filter ./web test         # frontend suite (was 30 passing)
pnpm run typecheck && pnpm run lint
pnpm --filter ./web run build
```

Then, manually, against a running stack (`pnpm run dev:api` + the web dev server): log in,
land on the Invoices screen, expand a row and see its items; expand invoice `247` (single
gross-priced `zw` line) and a correction invoice such as `4` (paired rows, one marked
*before correction*).

Data-integrity spot checks that should hold after the backfill:

```sql
-- No invoice lost items
select count(*) from invoices i
  where not exists (select 1 from invoice_items t where t.invoice_id = i.id);   -- → 0

-- 19 invoices legitimately repeat NrWierszaFa (corrections)
select count(*) from (
  select invoice_id from invoice_items
  group by invoice_id having count(*) <> count(distinct line_number));          -- → 19

-- VAT rates stored verbatim, including non-numeric
select vat_rate, count(*) from invoice_items group by 1;   -- 5:1177 23:1054 8:187 zw:19

-- Gross-priced lines keep a value despite null net
select count(*) from invoice_items where net_value is null;                     -- → 151
select count(*) from invoice_items where net_value is null and gross_value is null; -- → 0
```

Finally, add a one-line cross-reference to this document in
[`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) next to the existing
`IMPORT_OBSERVABILITY_PLAN.md` mention, leaving Phase 8's numbering untouched.

---

## 9. Deferred follow-ups

Not blocking; revisit only with a concrete reason.

- **Dedicated invoice-detail view** — a drill-down screen (header fields + full item table
  + raw XML). Worth it if the owner regularly inspects invoices with dozens of lines
  (32 invoices already have 21+, one has 61), at which point a router probably earns its
  cost too.
- **Item-level search / filtering** — "which invoices contained keg deposits?". Needs an
  index on `name` or FTS5; do not build speculatively.
- **Unit-of-measure normalization** — a deliberate mapping layer (`SZT`/`szt.`/`Sztuki` →
  one unit). Only worth it if per-unit aggregation is actually wanted; §3.9 shows how
  inconsistent the raw values are.
- **Money as integer minor units or decimal strings** — the correct fix for the `real`
  caveat, but it must cover `invoices.gross_total` too, so it belongs in its own workstream.
- **Item-level categorization (per-line categories)** — a genuine product change, not a
  refactor; contradicts SPEC §3.4's whole-invoice model and would need the owner's input.
- **Surfacing the reconciliation report in the UI** — currently a CLI/log-only diagnostic.
