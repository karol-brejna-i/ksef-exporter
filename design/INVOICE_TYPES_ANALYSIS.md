# KSeF Exporter — Invoice Header Coverage: Direction, Document Type & Unextracted Fields

**Last updated:** 2026-08-23 13:27 CEST

**Status:** Analysis only. Nothing described in §6 is implemented. §§1–5 are measured
facts about the live databases as of 2026-08-20; §9 is measured as of 2026-08-23. Both are
safe to rely on; §6 is a proposal that has not been reviewed or scheduled.

**Companion to** [`SPEC.md`](./SPEC.md), [`INVOICE_ITEMS_PLAN.md`](./INVOICE_ITEMS_PLAN.md),
and [`SCHEMA_TYPES_PLAN.md`](./SCHEMA_TYPES_PLAN.md). It does not renumber or displace
Phase 8 (manual entry), which remains the next numbered phase in
[`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md).

**Audience:** Developers / AI coding agents. Self-contained — every fact needed is here.

---

## 1. The problem

The parser reads seven header fields out of a document that carries dozens. As a result
the application cannot tell a correction invoice from an ordinary one, cannot state *why*
everything it holds is a purchase invoice, and does not store the VAT amount.

Concretely:

- The parser ([`src/ksef/invoice-parser.ts`](../src/ksef/invoice-parser.ts)) maps seven
  header fields — KSeF number, `P_2`, seller NIP/name, buyer NIP/name, `P_1`, `P_15`,
  `KodWaluty` — plus line items. **`RodzajFaktury` is not among them**, even though it is
  present on 100 % of documents and is the field that names the document type.
- **Only the gross total is stored.** Net and VAT are absent, so the application cannot
  answer "how much VAT can I reclaim this month" — the central question for a deductible
  business expense. Both values are derivable exactly from data already held (§5.1).
- **Payment terms are absent.** The due date is present on 90.8 % / 79.2 % of invoices and
  is not read, so an "amount owed / overdue" view cannot be built (§5.2).
- Nothing links a correction to the invoice it corrects, although ~90 % of the stored
  `NrKSeFFaKorygowanej` references point at invoices **already in the same database**
  (§3.4).
- A correction and the original it cancels both appear in the invoice list as independent
  rows with no relationship, so any month total silently mixes originals with their
  corrections. That is arithmetically correct but not explainable to a human.
- Correction invoices emit each line **twice** (`StanPrzed` before/after pairs), so any
  future item-level aggregate double-counts them. Today the backfill excludes them by
  ad-hoc XML sniffing rather than by a stored flag
  ([`src/invoices/backfill-items.ts`](../src/invoices/backfill-items.ts)).

Sections 2–4 deal with the first item, which needs the most background; §5 covers the
rest, which are simply unread fields.

Two distinct questions get conflated when people reason about invoice classification, and
the document keeps them apart:

| Question                          | Answered by                                                   |
| --------------------------------- | ------------------------------------------------------------- |
| Sales or purchase?                | **Not the XML.** The `subjectType` used at fetch time (§2.1). |
| Ordinary, correction, advance, …? | `Faktura/Fa/RodzajFaktury` in the XML (§2.2).                 |

---

## 2. Background: the two independent axes

### 2.1 Direction (sales vs purchase) is *not* in the invoice XML

An FA(3) document is symmetric. `Podmiot1` is the seller, `Podmiot2` the buyer, and the
**same bytes** are a sales invoice to one party and a purchase invoice to the other. There
is no element that says "this is a purchase". Direction is a property of *who is asking*,
selected at export time:

| `subjectType` | Your role in the document                     | You receive                        |
| ------------- | --------------------------------------------- | ---------------------------------- |
| `Subject1`    | seller (`Podmiot1`)                           | **sales** invoices                 |
| `Subject2`    | buyer (`Podmiot2`)                            | **purchase** invoices              |
| `Subject3`    | third party (`Podmiot3`: payer, recipient, …) | copies where you are neither party |

This application hardcodes `Subject2`
([`src/ksef/invoices.ts`](../src/ksef/invoices.ts#L8), mirrored by `SUBJECT_TYPE` in
[`src/sync.ts`](../src/sync.ts#L23)), and `sync_state` keys the continuation point by the
same subject type. **Everything in the database is a purchase invoice by construction, not
by parsing.** This is a product invariant (SPEC §3), not an incidental default.

**Superseded 2026-08-23.** Sales ingestion is now in scope (§9, §8 Q3), so this invariant
is being retired: `invoices` gains a stored `direction` column and the subject type becomes
a parameter. Until [`SALES_INVOICES_PLAN.md`](./SALES_INVOICES_PLAN.md) Stage 3 ships, the
sentence above still describes the live data accurately.

The post-hoc rule, should sales invoices ever be ingested, is
`Podmiot1/DaneIdentyfikacyjne/NIP == ownNip` → sales, else purchase. Two traps:

- **Self-billing** (`Fa/Adnotacje/P_17 = 1`, *samofakturowanie*): the buyer issued the
  document. It is still a purchase invoice for the buyer. Currently **0 occurrences**
  across both tenants, so this is untested territory.
- **`Podmiot3` copies**: you appear in neither `Podmiot1` nor `Podmiot2`, and the rule
  above returns "purchase" for a document that is neither.

Storing the tenant's own NIP would be required to apply that rule; the app does not
currently persist it anywhere (it is implicit in the KSeF auth context).

### 2.2 Document type is `Faktura/Fa/RodzajFaktury`

Type `TRodzajFaktury`, `minOccurs=1`, exactly seven legal values. Verbatim from the
bundled XSD
(`node_modules/.pnpm/ksef-client@0.7.1/node_modules/ksef-client/dist/documents/fa3/schemas/schemat_FA(3)_v1-0E.xsd`,
line 1800):

| Value     | XSD documentation                                                  | Plain meaning                           |
| --------- | ------------------------------------------------------------------ | --------------------------------------- |
| `VAT`     | Faktura podstawowa                                                 | ordinary invoice                        |
| `KOR`     | Faktura korygująca                                                 | correction of a `VAT` invoice           |
| `ZAL`     | …otrzymanie zapłaty… przed dokonaniem czynności (art. 106f ust. 4) | advance / prepayment invoice            |
| `ROZ`     | Faktura wystawiona w związku z art. 106f ust. 3                    | final settlement invoice after advances |
| `UPR`     | Faktura, o której mowa w art. 106e ust. 5 pkt 3                    | simplified invoice                      |
| `KOR_ZAL` | Faktura korygująca fakturę zaliczkową                              | correction of a `ZAL`                   |
| `KOR_ROZ` | Faktura korygująca fakturę wystawioną w zw. z art. 106f ust. 3     | correction of a `ROZ`                   |

Corrections are therefore **the three values starting with `KOR`**, not just `KOR`.

`ZAL` matters for a second reason: `FaWiersz` is `minOccurs="0"`, and an advance invoice
is the canonical zero-item document. Zero items is a legal state, not a parse failure
(already handled — `INVOICE_ITEMS_PLAN.md` §3.3).

### 2.3 Correction sub-structure

Available on `Fa`, all beneath or beside `RodzajFaktury`:

| Element                                                        | Cardinality         | Meaning                                                                          |
| -------------------------------------------------------------- | ------------------- | -------------------------------------------------------------------------------- |
| `DaneFaKorygowanej`                                            | `maxOccurs="50000"` | **repeated block** identifying each corrected invoice                            |
| ├ `DataWystFaKorygowanej`                                      | required            | issue date of the corrected invoice                                              |
| ├ `NrFaKorygowanej`                                            | required            | seller's number of the corrected invoice                                         |
| └ *choice*: `NrKSeF` + `NrKSeFFaKorygowanej`, **or** `NrKSeFN` | required            | corrected invoice's KSeF number, **or** a marker that it was issued outside KSeF |
| `PrzyczynaKorekty`                                             | optional            | free-text reason                                                                 |
| `TypKorekty`                                                   | optional            | which VAT period the correction lands in (§2.4)                                  |
| `OkresFaKorygowanej`                                           | optional            | period covered by a bulk rebate correction (art. 106j ust. 3)                    |
| `NrFaKorygowany`                                               | optional            | the *correct* number, when the correction fixes a wrong invoice number           |
| `Podmiot1K` / `Podmiot2K`                                      | optional            | corrected seller / buyer identity                                                |
| `FaWiersz/StanPrzed = "1"`                                     | per line            | this line is the **before** state                                                |

The `NrKSeF` / `NrKSeFN` choice is the part most likely to be got wrong: `NrKSeF` is a
`TWybor1` **flag** (the string `"1"`), not the number itself. The number lives in the
sibling `NrKSeFFaKorygowanej`. `NrKSeFN = "1"` is the mutually exclusive alternative,
meaning the corrected invoice never entered KSeF, in which case there is no KSeF number to
link to at all.

### 2.4 `TypKorekty` values

`TTypKorekty`, `xsd:integer`, three values (XSD line 1842):

| Value | Meaning                                                             |
| ----- | ------------------------------------------------------------------- |
| `1`   | correction takes effect in the period of the **original** invoice   |
| `2`   | correction takes effect in the period the **correction** was issued |
| `3`   | another date, incl. differing dates per correction line             |

### 2.5 Things that look like type markers but are not

- **`Naglowek/KodFormularza` + `WariantFormularza`** — the *schema* version (`FA`, `3`).
  Not the document type. 100 % of stored invoices are variant `3`.
- **`Fa/Adnotacje/*`** — statutory flags, orthogonal to `RodzajFaktury`: `P_16` cash
  method, `P_17` self-billing, `P_18` reverse charge, `P_18A` split payment, `Zwolnienie`
  exemption, `PMarzy` margin scheme. Note the `2`-means-no convention (`<P_16>2</P_16>`),
  which is easy to misread as a value.
- **`Podmiot3/Rola`** — third-party role (payer, recipient, …). Not direction.
- **Sign of `P_15`** — a heuristic that demonstrably fails; see §3.3.

---

## 3. Measured state of the live databases

Both tenants, read-only, as of 2026-08-20. `.env` is a symlink to a per-tenant env file,
so there is more than one live database — figures below are per tenant and must not be
summed into "the" dataset.

|                          | parkowa                                     | portowa                                     |
| ------------------------ | ------------------------------------------- | ------------------------------------------- |
| Path                     | `data/tenants/parkowa/ksef-exporter.sqlite` | `data/tenants/portowa/ksef-exporter.sqlite` |
| Invoices                 | 249                                         | 530                                         |
| `source = "manual"`      | 0                                           | 0                                           |
| Rows with NULL `raw_xml` | 0                                           | 0                                           |
| Distinct `buyer_nip`     | **1** (`9462136075`)                        | **1** (`9581716689`)                        |
| Distinct `seller_nip`    | 55                                          | 70                                          |
| `buyer_nip = seller_nip` | 0                                           | 0                                           |
| `issue_date` range       | 2026-06-30 … 2026-08-10                     | 2026-03-31 … 2026-08-20                     |
| `WariantFormularza`      | `3` × 249                                   | `3` × 530                                   |
| Line items               | 2 437                                       | 5 735                                       |

The single distinct `buyer_nip` per tenant, with zero self-invoices, is the empirical
confirmation of §2.1: the `Subject2` constraint holds in the data, not just in the code.

### 3.1 `RodzajFaktury` distribution

| Value                                 | parkowa | portowa |
| ------------------------------------- | ------- | ------- |
| `VAT`                                 | 228     | 504     |
| `KOR`                                 | 20      | 26      |
| `ROZ`                                 | **1**   | 0       |
| `ZAL` / `UPR` / `KOR_ZAL` / `KOR_ROZ` | 0       | 0       |
| missing                               | 0       | 0       |

**The single `ROZ` in parkowa is the load-bearing fact here.** It proves the live data is
already not a `VAT`/`KOR` binary, so any implementation must handle the full seven-value
enumeration rather than a boolean `is_correction`.

### 3.2 Correction markers

| Marker                                        | parkowa (20 `KOR`) | portowa (26 `KOR`)   |
| --------------------------------------------- | ------------------ | -------------------- |
| `DaneFaKorygowanej` present                   | 20 / 20            | 26 / 26              |
| ≥1 `NrKSeFFaKorygowanej`                      | 20                 | 23                   |
| ≥1 `NrKSeFN` (corrected invoice outside KSeF) | 0                  | 4                    |
| `PrzyczynaKorekty`                            | 3                  | 11                   |
| `TypKorekty`                                  | 3 (all `2`)        | 5 (`1` × 4, `2` × 1) |
| `OkresFaKorygowanej`                          | 0                  | 0                    |
| `NrFaKorygowany`                              | 0                  | 0                    |
| `Podmiot1K` / `Podmiot2K`                     | 0                  | 0                    |
| Documents containing `StanPrzed`              | 20                 | 18                   |
| Item rows with `StanPrzed`                    | 138                | 75                   |

`DaneFaKorygowanej` is present on exactly the `KOR` documents and on nothing else, in both
tenants. It is a reliable corroborating signal, but `RodzajFaktury` remains the primary
one: it is required, single-valued, and covers `KOR_ZAL`/`KOR_ROZ` too.

Two consequences worth flagging:

- **8 of portowa's 26 corrections carry no `StanPrzed` at all.** "Correction" and
  "before/after line pairs" are not the same predicate. Excluding double-counting by
  sniffing for `StanPrzed` (as the item backfill does) is correct; excluding it by
  `RodzajFaktury = KOR` would over-exclude 8 documents.
- In portowa, splitting the 26 corrections by reference form: **22** use only in-KSeF
  references, **3** use only `NrKSeFN`, and **1 document mixes both**. A parser that
  assumes a document is uniformly one or the other will drop references.

### 3.3 Sign of `P_15` is not a classifier

|                                  | parkowa     | portowa              |
| -------------------------------- | ----------- | -------------------- |
| `KOR` with `gross_total < 0`     | 20          | 22                   |
| `KOR` with `gross_total > 0`     | 0           | **1** (max `+91.27`) |
| `KOR` with `gross_total = 0`     | 0           | **3**                |
| Non-`KOR` with `gross_total < 0` | 0           | 0                    |
| Most negative `KOR`              | `−5 193.54` | `−1 335.51`          |

Negative gross implies correction in this data, but **the converse is false**: 4 of
portowa's 26 corrections are non-negative — one upward correction and three that net to
zero (corrections of non-financial fields). Classifying by sign would misfile them.

### 3.4 Correction references mostly resolve locally

Counting individual `NrKSeFFaKorygowanej` values inside `KOR` documents:

|                                                                | parkowa       | portowa       |
| -------------------------------------------------------------- | ------------- | ------------- |
| Total references                                               | 85            | 50            |
| References resolving to a `ksef_number` already in the same DB | **74 (87 %)** | **45 (90 %)** |
| Max references in one document                                 | 10            | 9             |
| Correction documents with references but **zero** resolvable   | 1             | 3             |

Unresolvable references are expected and benign: they point at invoices issued before the
sync window opened. **A foreign key would be wrong**; the link must tolerate dangling
references.

The one-to-many shape is also load-bearing: a single correction can restate up to 50 000
invoices per the XSD, and one real document here corrects **ten**. A scalar
`corrected_ksef_number` column would silently keep the first and discard nine.

---

## 4. What the system models today

`invoices` ([`src/db/schema.ts`](../src/db/schema.ts)) stores: `id`, `source`,
`ksef_number`, `invoice_number`, `seller_nip`, `seller_name`, `buyer_nip`, `buyer_name`,
`issue_date`, `gross_total`, `currency`, `raw_xml`, `items_extracted_at`, `category_id`,
`categorization_confidence`, `created_at`.

| Concept                                         | Modeled?                                                                                  |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Direction (sales/purchase)                      | Implicit in `SUBJECT_TYPE = "Subject2"`. No column. Not needed while the invariant holds. |
| Tenant's own NIP                                | Not persisted.                                                                            |
| `RodzajFaktury`                                 | **No.** Not parsed, not stored, not surfaced.                                             |
| Corrected-invoice references                    | **No.** Only inside `raw_xml`.                                                            |
| `TypKorekty` / `PrzyczynaKorekty`               | **No.**                                                                                   |
| `StanPrzed` per line                            | **Yes** — `invoice_items.correction_state_before`.                                        |
| **Net total / VAT total**                       | **No.** Only `gross_total` (`P_15`). See §5.1.                                            |
| **Payment due date, payment method, paid flag** | **No.** See §5.2.                                                                         |
| **Sale/delivery date (`P_6`)**                  | **No.** Only `issue_date` (`P_1`). See §5.3.                                              |
| **Delivery venue (`Podmiot3`, `Rola = 2`)**     | **No.** See §5.4.                                                                         |

**The enabling fact is the same one that made line items cheap:** `raw_xml` is retained on
100 % of rows in both tenants, so every field above is already local. Adding them requires
**no KSeF API calls**, no re-import, and no consumption of the 20 req/h
`POST /invoices/exports` quota.

---

## 5. Beyond document type — other unextracted header fields

Measured the same way and on the same data as §3. Percentages are *of all invoices in that
tenant*, not of some subset. Ranked by value, not by document order.

### 5.1 Tier 1 — the net and VAT amounts are not stored at all

`invoices` stores `gross_total` and nothing else. For a purchase-invoice tracker where VAT
is deductible, this is the largest single gap in the schema: **the application cannot
answer "how much VAT can I reclaim this month".**

FA(3) has **no single net-total or VAT-total element.** The values must be summed from the
per-rate buckets, which are split by VAT rate by design (the same fact that
`INVOICE_ITEMS_PLAN.md` §3.6 records for items):

- net = `P_13_1` + `P_13_2` + `P_13_3` + `P_13_4` + `P_13_5` + `P_13_6_1` + `P_13_6_2` +
  `P_13_6_3` + `P_13_7` + `P_13_8` + `P_13_9` + `P_13_10` + `P_13_11`
- VAT = `P_14_1` + `P_14_2` + `P_14_3` + `P_14_4` + `P_14_5`

Measured reconciliation against the already-stored gross:

|                                       | parkowa       | portowa                                                                                |
| ------------------------------------- | ------------- | -------------------------------------------------------------------------------------- |
| `Σ P_13_* + Σ P_14_* == P_15` (±0.01) | **249 / 249** | **529 / 529**                                                                          |
| Mismatches                            | **0**         | **0**                                                                                  |
| Excluded                              | 0             | 1 — invoice `1/05/2026`, a `KOR` with `gross_total = 0` and no `P_13_*` element at all |

Presence of the individual buckets: `P_13_1` 63.5 % / 58.5 %, `P_13_3` 47.8 % / 57.5 %,
`P_13_2` 24.9 % / 34.0 %, `P_13_7` 9.2 % / 4.9 %, `P_13_8` 1.2 % / 2.5 %, `P_13_9` 0 % /
2.3 %, `P_13_11` 0 % / 0.8 %. The `P_14_*` buckets track their `P_13_*` counterparts
exactly.

> ⚠️ **Exclude the `W`-suffixed variants** (`P_14_1W`, `P_14_2W`, `P_14_3W`, `P_14_4W`).
> They are the *PLN equivalent* of the VAT amount for foreign-currency invoices, and
> **17.7 % of parkowa invoices emit `P_14_1W` even though all 779 invoices in both tenants
> are `PLN`.** Including them double-counts VAT. The perfect reconciliation above is
> conditional on excluding them.

A per-rate child table (`invoice_vat_totals`: rate, net, vat) is worth considering over two
scalars — that is the shape a VAT register needs, and it keeps the reconciliation check
expressible in SQL.

### 5.2 Tier 2 — payment terms

| Field                  | XML path (under `Fa/Platnosc`)        | parkowa         | portowa         |
| ---------------------- | ------------------------------------- | --------------- | --------------- |
| Payment due date       | `TerminPlatnosci/Termin`              | **90.8 %**      | **79.2 %**      |
| Payment method         | `FormaPlatnosci`                      | 54.2 %          | 73.6 %          |
| Paid marker / date     | `Zaplacono` / `DataZaplaty`           | 11.2 %          | 13.2 %          |
| Bank account / bank    | `RachunekBankowy/NrRB` / `NazwaBanku` | 92.4 % / 82.7 % | 77.7 % / 67.5 % |
| Free-text payment note | `PlatnoscInna` + `OpisPlatnosci`      | 18.5 %          | 13.4 %          |
| Partial payment        | `ZaplataCzesciowa`                    | 0 %             | 0.9 %           |

The due date is the highest-value field in this whole document after the VAT amount: it
enables an "unpaid / overdue" view, which is currently impossible to build.

`FormaPlatnosci` is `TFormaPlatnosci`, an integer enum: `1` Gotówka, `2` Karta, `3` Bon,
`4` Czek, `5` Kredyt, `6` Przelew, `7` Mobilna. Observed — parkowa `6`×119, `1`×8, `2`×8;
portowa `6`×335, `1`×33, `2`×21, `7`×1. Combined with the sparse `Zaplacono` marker, this
is enough to keep cash/card purchases (already settled at the till) out of an amounts-owed
list. `Zaplacono` on its own is too sparse to be a source of truth.

`Skonto` / `WarunkiSkonta` / `WysokoscSkonta` (early-payment discount) are **absent from
both tenants**. Do not model them.

### 5.3 Tier 2 — the sale date is not the issue date

`Fa/P_6` (date of supply / completion of service) is present on **59.4 % / 59.6 %** of
invoices. It is the VAT point, and therefore the field that determines which accounting
period an invoice belongs to. The application currently groups exclusively by
`issue_date` (`P_1`), which is the wrong boundary whenever the two straddle a month end.

When `P_6` is absent the fallback is the per-line `P_6A` (2.4 % of invoices, already
stored as `invoice_items.delivery_date`) and then `P_1`. Related: `Fa/OkresFa` — a billing
period for continuous supply — appears on 5.6 % / 4.3 %, and is what explains a July
invoice covering June utilities. `OkresFaOd` / `OkresFaDo` are absent from both tenants.

`P_6` is a **civil date**: `TEXT YYYY-MM-DD`, never an instant.

### 5.4 Tier 3 — `Podmiot3` carries the delivery venue

`Podmiot3` with `Rola = 2` ("Odbiorca" — an internal unit or branch of the buyer that is
not itself the buyer in the statutory sense) is present on **26.9 % / 43.4 %** of invoices.
It is the only structured carrier of *which physical location* an invoice belongs to.

portowa demonstrably has two venues:

| Normalised name           | Invoices | Raw casing variants observed                                                                                     |
| ------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------- |
| Restauracja Portowa       | ~175     | `Restauracja PORTOWA Dobras sp.z o.o.` (78), `Restauracja Portowa` (66), `RESTAURACJA PORTOWA` (31)              |
| Portowa Breakfast & Lunch | ~32      | `PORTOWA BREAKFAST & LUNCH  FOL 28` (20), `Portowa Breakfast and lunch` (8), `Portowa Breakfast and Lunch 1` (4) |

parkowa's issuers mostly do **not** use `Podmiot3` for this. Instead **35 invoices cram the
delivery site into the buyer *name***, e.g.
`PARKOWA BISTRO&DANCE Aneta Kułakowska(Dostawa: Jelitkowo "Parkowa" ul. Pomorska 57a)` —
see [`data/triada.id1.xml`](../data/triada.id1.xml). So the venue is present in the data
but split across two incompatible representations.

Full `Rola` enum (`TRolaPodmiotu3`): `1` Faktor, `2` Odbiorca, `3` Podmiot pierwotny,
`4` Dodatkowy nabywca, `5` Wystawca faktury, `6` Dokonujący płatności, `7`/`8` JST
wystawca/odbiorca, `9`/`10` członek grupy VAT wystawca/odbiorca, `11` Pracownik. Observed
beyond `2`: parkowa `5`×2 / `7`×2, portowa `5`×9 / `10`×1 / `11`×1 — so a naive "Podmiot3
means venue" assumption is wrong ~5 % of the time.

This is the highest-ceiling item here (per-venue cost reporting) and also the messiest —
free text, inconsistent casing, two representations. It would need the same
normalise-and-map treatment that seller rules already get. **Do not build it until the
owner asks for per-venue reporting.**

### 5.5 Tier 4 — cheap, display-only

| Field                                     | parkowa              | portowa              | Use                                           |
| ----------------------------------------- | -------------------- | -------------------- | --------------------------------------------- |
| `WZ` (delivery-note ref)                  | 41.0 %               | 60.0 %               | reconciling against paper delivery notes      |
| `DodatkowyOpis` (key/value extras)        | 20.1 %               | 55.1 %               | issuer-specific detail; unstructured          |
| `Podmiot1/DaneKontaktowe/Email`           | 47.8 %               | 54.3 %               | "who do I call about this invoice"            |
| `Podmiot1/DaneKontaktowe/Telefon`         | 43.4 %               | 41.5 %               | as above                                      |
| `Podmiot2/NrKlienta` (our account no.)    | 43.0 %               | 34.0 %               | quoting on queries                            |
| `Naglowek/SystemInfo` (issuer's software) | 87.6 %               | 96.4 %               | diagnosing per-issuer XML quirks              |
| `Stopka/Rejestry` (KRS / REGON / BDO)     | 31.7 / 62.7 / 41.8 % | 27.7 / 67.5 / 78.1 % | low value — NIP already identifies the seller |

### 5.6 Measured to be **not** worth modelling

- **`Adnotacje` statutory flags.** All of `P_16`, `P_17`, `P_18`, `P_18A`, `P_23` are
  present on 100 % of invoices — and almost always carry `2`, the "no" value. `P_17`
  (self-billing), `P_18` (reverse charge) and `P_18A` (split payment / MPP) are `2` on
  **all 779 invoices**. Only `P_16` (cash method) ever fires: **2 parkowa, 4 portowa** —
  and it genuinely affects VAT deduction timing, so it is the one flag worth a boolean.
- **Multi-currency / FX.** All 779 invoices are `PLN`. `Fa/KursWaluty` appears on 1.2 % /
  2.8 % (issuers stating a trivial `1.0000`). Do not build FX handling.
- **Absent from both tenants entirely:** `Zamowienie`, `Skonto` / `WarunkiSkonta` /
  `WysokoscSkonta`, `TP`, `WarunkiDostawy`, `Transport`, `P_15Z` / `P_15ZK`, `OkresFaOd` /
  `OkresFaDo`, `Rachunki`. `Zalacznik` appears twice in parkowa and never in portowa.

---

## 6. Suggested improvement (proposal — not implemented)

Ordered by value-to-cost. Each step is independently shippable; stop after any of them.

> **Rebuild `invoices` exactly once.** Every column below lands in a *single* migration.
> SQLite emulates `ALTER TABLE` by drop-and-recreate, so each additional rebuild is another
> chance to trip the cascade hazard described at the end of this section. If `Subject1`
> ingestion is ever plausible (§8 Q3), add its `direction` column in the same migration.

### Step 1 — One migration: document type, and the amounts and dates that are missing

Add to `invoices`, all nullable (manual entries have no XML):

| Column             | Source                               | Type      | Note                                          |
| ------------------ | ------------------------------------ | --------- | --------------------------------------------- |
| `invoice_kind`     | `Fa/RodzajFaktury`                   | `TEXT`    | CHECK over the seven XSD values               |
| `net_total`        | `Σ Fa/P_13_*`                        | `REAL`    | matches existing `gross_total` representation |
| `vat_total`        | `Σ Fa/P_14_*` **excluding `*W`**     | `REAL`    | see §5.1                                      |
| `sale_date`        | `Fa/P_6`                             | `TEXT`    | **civil date** `YYYY-MM-DD`                   |
| `payment_due_date` | `Fa/Platnosc/TerminPlatnosci/Termin` | `TEXT`    | **civil date**                                |
| `payment_method`   | `Fa/Platnosc/FormaPlatnosci`         | `INTEGER` | enum 1–7, §5.2                                |

```
CHECK (invoice_kind IS NULL OR invoice_kind IN
  ('VAT','KOR','ZAL','ROZ','UPR','KOR_ZAL','KOR_ROZ'))
CHECK (payment_method IS NULL OR payment_method BETWEEN 1 AND 7)
```

Parse all six in `parsePurchaseInvoiceXml` as **optional** — an unrecognised or missing
value must yield NULL, never a thrown `InvoiceParsingError`. The seven currently-required
header fields earn their hard failure because a financial record is wrong without them;
none of these six does.

Backfill from `raw_xml` using the existing `parseInvoiceFaElement` path, exactly as the
item backfill does. Acceptance checks, all already measured:

- `invoice_kind`: parkowa 228 `VAT` / 20 `KOR` / 1 `ROZ`, portowa 504 `VAT` / 26 `KOR`,
  zero NULLs.
- `net_total + vat_total = gross_total` within 0.01 on 249/249 and 529/529 rows, the sole
  exclusion being portowa's zero-value `KOR` `1/05/2026`.
- `payment_due_date` non-NULL on 226/249 and 420/530 rows.

### Step 2 — Surface it in the list UI

A VAT column, an "amount owed / overdue" view keyed on `payment_due_date` (excluding rows
whose `payment_method` is cash or card), a badge on correction rows
(`invoice_kind LIKE 'KOR%'`) and a filter. This alone answers
"why is this row negative?", which is the actual user-facing complaint.

### Step 3 — Store the corrected-invoice references

A child table, **one row per `DaneFaKorygowanej` block** — not a column:

```
invoice_corrections(
  id, invoice_id → invoices.id ON DELETE CASCADE,
  ordinal,                      -- document order; the identity, per §3.4
  corrected_issue_date TEXT,    -- DataWystFaKorygowanej, civil date
  corrected_invoice_number TEXT,-- NrFaKorygowanej
  corrected_ksef_number TEXT,   -- NrKSeFFaKorygowanej, NULL when NrKSeFN
  issued_outside_ksef INTEGER   -- NrKSeFN = "1"
)
```

Deliberately **no** foreign key from `corrected_ksef_number` to
`invoices.ksef_number`: 13 % (parkowa) / 10 % (portowa) of references point outside the
sync window and would be rejected. Resolve by `LEFT JOIN` at read time.

`ordinal` follows the same reasoning as `invoice_items.ordinal`, and for the same reason:
nothing in the block is guaranteed unique within a document.

Optionally alongside: `correction_type INTEGER` (`TypKorekty`) and
`correction_reason TEXT` (`PrzyczynaKorekty`) on `invoices` — both sparse (§3.2), so their
value is display-only.

### Step 4 — Show the correction chain

On an invoice row, list the invoices it corrects (resolved rows linked, unresolved shown
as bare number + date). On an original, show corrections pointing at it.

### Migration hazards that apply to every step

These are not hypothetical; both have already caused damage in this repo.

- **FK cascade.** SQLite emulates `ALTER TABLE` by drop-and-recreate, and `DROP TABLE`
  with `foreign_keys` ON fires `ON DELETE CASCADE`. Rebuilding `invoices` once deleted all
  2 437 `invoice_items` on a trial copy. `createDb` disables the pragma outside the
  transaction; do not remove that. The `PRAGMA foreign_keys=OFF` drizzle-kit writes into
  the migration file is a **no-op** because the migrator runs inside a transaction.
- **Trial on a copy first.** `cp` each tenant database, migrate the copy, compare row
  counts and sums before touching the real files. There are **two** live databases, not
  one.
- Civil dates (`corrected_issue_date`) stay `TEXT YYYY-MM-DD`. Do not convert to an
  instant — see `SCHEMA_TYPES_PLAN.md`.

### Explicitly out of scope

- **Netting corrections into originals**, or any change to how totals are computed.
  Display the relationship; do not silently rewrite arithmetic.
- **Category rules keyed on invoice kind.** Categorization stays seller-based (SPEC §4).
- **Item-level correction resolution** (applying `StanPrzed` deltas to produce a corrected
  item set). Large, and nothing needs it yet.
- **Per-venue reporting** (§5.4), **FX handling**, and everything in §5.6.

---

## 7. Reproducing the measurements

Read-only, safe to re-run. Kill any `tsx watch src/api/main.ts` first — a live WAL-mode
writer makes `?mode=ro` snapshots unreliable.

Distribution of document kinds and negative totals, per tenant:

```sh
for t in parkowa portowa; do
  echo "== $t"
  sqlite3 "file:data/tenants/$t/ksef-exporter.sqlite?mode=ro" \
    "SELECT rtrim(substr(x, 1, instr(x,'<')-1)) AS rodzaj,
            count(*), sum(gross_total < 0) AS negative
     FROM (SELECT substr(raw_xml, instr(raw_xml,'RodzajFaktury>') + 14) AS x,
                  gross_total FROM invoices WHERE raw_xml IS NOT NULL)
     GROUP BY 1 ORDER BY 2 DESC;"
done
```

`instr(…, 'RodzajFaktury>')` intentionally omits the leading `<`, so it matches
`<RodzajFaktury>`, `<ns0:RodzajFaktury>`, and `<tns:RodzajFaktury>` alike — all three
prefix styles occur in the data.

Reference-resolution rates (§3.4), field-presence percentages (§5), and the net/VAT
reconciliation (§5.1) need real XML parsing; the numbers above came from ad-hoc
`node:sqlite` read-only scripts that regex-extract the relevant elements — tolerating all
three namespace-prefix styles via `<(?:\w+:)?Name>` — and aggregate in JavaScript.
**Re-derive rather than trust a stale figure; nothing here is pinned by a test yet.**

The net/VAT check specifically: sum the thirteen `P_13_*` and the five `P_14_*` elements
per invoice, **excluding any name ending in `W`**, and compare against the stored
`gross_total` with a 0.01 tolerance. Treat an invoice with no `P_13_*` element at all as
excluded rather than as a mismatch (one such row exists — see §5.1).

### Reference documents in the repo

- [`data/example.invoice.xml`](../data/example.invoice.xml) — a `KOR` (Eurocash) with
  **nine** `DaneFaKorygowanej` blocks, `P_15 = −4 521.36`, 22 `FaWiersz` forming 11
  `StanPrzed` pairs, `ns0:` prefix style. Good correction sample; **not** a representative
  invoice.
- [`data/triada.id1.xml`](../data/triada.id1.xml) — a plain `VAT`, unprefixed namespace,
  24 lines, no correction structure. Good ordinary sample.

Neither contains a `ZAL`, `ROZ`, `UPR`, `KOR_ZAL`, or `KOR_ROZ`; only one `ROZ` exists in
the live data (parkowa) and the other four values have never been observed. Tests for them
must use synthetic fixtures.

---

## 8. Open questions

1. Should the tenant's own NIP be persisted, so direction becomes assertable rather than
   assumed? Cheap, and it would let an integrity check catch a mis-scoped export.
   **Partially answered 2026-08-23 (§9):** the identity holds in real data — seller NIP
   equalled the tenant NIP on 39/39 sampled sales invoices — so an integrity check is
   viable. Whether to persist the NIP and enforce it is still open.
2. Do month/category totals need to visibly separate originals from corrections, or is the
   arithmetic sum sufficient with corrections merely badged?
3. Is there any appetite for `Subject1` (sales) ingestion later? If yes, `invoices` should gain a `direction` column in the same migration as `invoice_kind` rather than a second
   rebuild of the table.
   **Answered 2026-08-23: yes.** Sales ingestion is in scope for revenue reporting; see
   [`SALES_INVOICES_PLAN.md`](./SALES_INVOICES_PLAN.md). Both columns land in one
   migration, exactly as this question anticipated.
4. Should VAT be stored as two scalars (`net_total`, `vat_total`) or as a per-rate child
   table? The scalars are enough for "reclaimable VAT this month"; the child table is what
   a VAT register or JPK export would need. Which one depends on whether this application
   is ever meant to feed the accountant directly.
5. Should reporting periods switch from `issue_date` to `sale_date` with an `issue_date`
   fallback (§5.3)? This changes existing month totals, so it needs the owner's sign-off
   rather than being treated as a bug fix.
6. Does the owner want per-venue cost reporting (§5.4)? If yes it is a real workstream —
   two representations to normalise — and should get its own plan document rather than a
   column.

---

## 9. Sales invoices (`Subject1`) — measured 2026-08-23

§8 Q3 asked whether sales ingestion was ever wanted. It is (revenue reporting), so this
section records what a real `Subject1` export actually contains, before any schema is
committed. Everything below is measured, not assumed.

### 9.1 How it was obtained

[`src/ksef/dump-invoices.ts`](../src/ksef/dump-invoices.ts) gained a `DUMP_SUBJECT_TYPE`
environment variable; `Subject1` output is written to `data/invoices-sales/` so it cannot
overwrite the purchase sample. One 90-day `PRD` export per tenant:

```sh
DUMP_SUBJECT_TYPE=Subject1 DUMP_WINDOW_DAYS=90 pnpm run dump:invoices
```

The export-init rate limit is documented per subject type, so a `Subject1` run draws on its
own budget and does not consume the purchase one.

### 9.2 The permission question, settled

**The existing `InvoiceRead` KSeF token authorises `Subject1`.** Both tenants returned
sales invoices with no permission error and no token change. This was the gate for the
whole workstream; it is now closed.

### 9.3 Measurements

| | parkowa | portowa |
| --- | --- | --- |
| Sales invoices, 90 days | 5 | 34 |
| Purchase invoices currently stored | 249 | 530 |
| Issue-date span | 2026-06-30 → 2026-07-28 | 2026-05-24 → 2026-08-07 |
| `RodzajFaktury` | 5 `VAT` | 32 `VAT`, 2 `KOR` |
| Currency | 5 PLN | 34 PLN |
| Negative `P_15` | 0 | 0 |
| Missing `P_15` | 0 | 0 |
| Namespace prefix | none | none |
| Buyer NIP present | 5/5 | 34/34 |
| Buyer name present | 5/5 | 34/34 |
| Parse failures | 0/5 | 0/34 |

### 9.4 Five findings that shape the design

1. **Direction is assertable from the data.** Seller NIP equalled the tenant's own NIP on
   **39/39** invoices. §2.1 says direction is not *in* the XML — true — but combined with
   the tenant NIP it is checkable after the fact, which makes a mis-scoped export
   detectable rather than silent.
2. **Volume is low.** 39 sales across 90 days against 779 stored purchases. The historical
   backfill is cheap and unlikely to strain the export quota.
3. **The existing parser needs no changes.** All 39 parsed with zero errors using
   `parsePurchaseInvoiceXml` unmodified. The parser was already direction-agnostic; only
   its name is misleading.
4. **Sales corrections are not negative here.** Both portowa `KOR` documents carry positive
   `P_15` and a `NrKSeFFaKorygowanej` reference, unlike the negative purchase corrections
   in §3. With n=2 this generalises to nothing — but do **not** assume sales corrections
   reduce a revenue total the way purchase corrections reduce a cost total. Verify before
   any netting logic is written.
5. **No KSeF-number collisions.** None of the 39 sampled numbers already existed in the
   respective tenant's `invoices` table (0/5, 0/34). The `invoices_ksef_number_unique`
   index therefore poses no practical risk of one direction silently swallowing the other.

### 9.5 Reproducing

The two dumps live at `data/invoices-sales-parkowa/` and `data/invoices-sales-portowa/`
(gitignored). The aggregation regex-extracts `RodzajFaktury`, `P_15`, `P_1`, `KodWaluty`,
and the `Podmiot1`/`Podmiot2` blocks, tolerating all three namespace-prefix styles via
`<(?:\w+:)?Name>` — the same technique as §7. Re-derive rather than trust these figures;
nothing here is pinned by a test.
