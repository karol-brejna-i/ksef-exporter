# KSeF Exporter — Amount Due vs Gross Total: The `Rozliczenie` Gap

**Last updated:** 2026-08-23 12:11

**Status:** Analysis only. Nothing described in §6 is implemented. §§1–5 are measured
facts about the live databases as of the date above and are safe to rely on; §6 is a
proposal that has not been reviewed or scheduled.

**Companion to** [`SPEC.md`](./SPEC.md) and
[`INVOICE_TYPES_ANALYSIS.md`](./INVOICE_TYPES_ANALYSIS.md), which covers the other gaps
in header-field extraction (net/VAT totals, payment terms, document type). This document
is self-contained — every fact needed is here — and focuses on one specific field: the
amount actually owed, which can differ from the stored `gross_total`.

**Audience:** Developers / AI coding agents.

---

## 1. The problem

The application stores exactly one monetary "bottom line" per invoice: `gross_total`,
read from `Fa/P_15`. `P_15` is defined by the FA(3) schema as "kwota należności ogółem"
(total amount due) — but the schema also lets an invoice attach a `Fa/Rozliczenie`
block that adjusts what is *actually* owed away from `P_15`, via a signed list of
charges and deductions, arriving at a separate field, `Rozliczenie/DoZaplaty`, which is
the true amount due.

The application never reads `Rozliczenie` at all. For roughly 6–12 % of purchase
invoices in the two live tenant databases, this means **`gross_total` is not the amount
the seller expects to be paid** — usually because of refundable bottle/pallet deposits
(kaucja), sometimes because of a utility bill applying a prior overpayment or late-payment
interest. Anyone using `gross_total` to reconcile bank payments or build an "amount owed"
view will see a real, wrong-by-design mismatch on those invoices — not a bug in KSeF, a
field the parser doesn't read.

This document answers, concretely: **which field is which, how does one recognize gross
total vs. amount due, and how does the current code decide what to show in
`gross_total`** — plus one hazard (§5.3) that would break a naive implementation.

---

## 2. Background: reading the FA(3) schema

Reference: `node_modules/.pnpm/ksef-client@0.7.1/node_modules/ksef-client/dist/documents/fa3/schemas/schemat_FA(3)_v1-0E.xsd`,
`Rozliczenie` complex type (~lines 3212–3277).

### 2.1 `P_15` — the field the app already stores

`Fa/P_15` (`gross_total` in the schema) is documented as "kwota należności ogółem" — the
invoice's own total, gross of VAT. It is always present (required, unlike everything
below) and is what `parsePurchaseInvoiceXml()` maps to `invoices.gross_total`.

### 2.2 `Rozliczenie` — optional, additional settlement info

```
Rozliczenie (minOccurs=0)              "Dodatkowe rozliczenia na fakturze"
├── Obciazenia (0..100)                "Obciążenia" (charges added on top of P_15)
│   ├── Kwota (required, TKwotowy)     "Kwota doliczona do kwoty wykazanej w polu P_15"
│   └── Powod (required, TZnakowy)     "Powód obciążenia" (reason, free text)
├── SumaObciazen (0..1, TKwotowy)      "Suma obciążeń" — sum of all Obciazenia/Kwota
├── Odliczenia (0..100)                "Odliczenia" (deductions from P_15)
│   ├── Kwota (required, TKwotowy)     "Kwota odliczona od kwoty wykazanej w polu P_15"
│   └── Powod (required, TZnakowy)     "Powód odliczenia"
├── SumaOdliczen (0..1, TKwotowy)      "Suma odliczeń" — sum of all Odliczenia/Kwota
└── xsd:choice (minOccurs=0):
    ├── DoZaplaty (TKwotowy)           "Kwota należności do zapłaty równa polu P_15
    │                                   powiększonemu o Obciążenia i pomniejszonemu
    │                                   o Odliczenia" — i.e. the actual amount due
    └── DoRozliczenia (TKwotowy)       "Kwota nadpłacona do rozliczenia/zwrotu" —
                                        an overpayment to be refunded/settled instead
                                        (mutually exclusive with DoZaplaty)
```

The schema's own documentation string states the arithmetic in words: `DoZaplaty` =
`P_15` increased by `Obciazenia` and decreased by `Odliczenia`. Every field under
`Rozliczenie` is optional (`Obciazenia`/`Odliczenia` are `0..100`, the totals are
`0..1`), so an invoice can carry a `Rozliczenie` block with only a `DoZaplaty` and
nothing else, or a full breakdown with per-line reasons.

### 2.3 What this means in practice

A seller adds `Rozliczenie` when the amount to actually pay differs from the invoice's
own `P_15` total for a reason not otherwise expressible on the invoice — most commonly a
refundable deposit system, but also account-level adjustments (a utility applying a
credit balance, late-payment interest).

---

## 3. Measured state of the live databases

Reproducible with a small `node:sqlite` script (`node:sqlite`'s `DatabaseSync`, opened
`{ readOnly: true }`) that scans `raw_xml` for every invoice, per tenant. Methodology in
§7.

### 3.1 Prevalence

|                                                                   | parkowa (249 invoices w/ XML) | portowa (530 invoices w/ XML) |
| ----------------------------------------------------------------- | ----------------------------: | ----------------------------: |
| have a `Rozliczenie` block                                        |                   29 (11.6 %) |                    28 (5.3 %) |
| have `DoZaplaty`                                                  |                            29 |                            27 |
| have `DoRozliczenia` (overpayment, no `DoZaplaty`)                |                             0 |                             1 |
| have both `DoZaplaty` and `DoRozliczenia`                         |                             0 |                             0 |
| `Rozliczenie` present but `DoZaplaty`/`DoRozliczenia` both absent |                             0 |                             0 |
| `Rozliczenie` present, no `Obciazenia`/`Odliczenia` lines at all  |                            15 |                            11 |
| `DoZaplaty` numerically equals `gross_total`                      |                            17 |                            11 |
| `DoZaplaty` differs from `gross_total`                            |                        **12** |                        **16** |

`DoZaplaty` and `DoRozliczenia` were never observed together, confirming the schema's
`xsd:choice` in practice. When `Rozliczenie` carries no `Obciazenia`/`Odliczenia` lines
at all (15 + 11 = 26 cases), `DoZaplaty` always equals `gross_total` exactly — i.e. some
sellers emit an empty/confirmatory `Rozliczenie` block that changes nothing.

Bottom line: **12/249 (4.8 %) invoices in parkowa and 16/530 (3.0 %) in portowa have a
real amount-due that differs from `gross_total`**, and today the application has no way
to know this or show the correct number.

### 3.2 The arithmetic identity, verified — with one hazard

For the 12 + 16 = 28 invoices where `DoZaplaty` differs from `gross_total`, the schema's
documented identity was tested as `DoZaplaty == gross_total + SumaObciazen + SumaOdliczen`
(a straight sum, since `Odliczenia` amounts are — usually — stored already negative):

- **portowa: 16/16 match exactly.**
- **parkowa: 11/12 match exactly. One does not** — see §5.3, this is a real sign-convention
  inconsistency across issuers, not a data error, and it must be handled deliberately by
  any implementation.

Where individual `Obciazenia`/`Odliczenia` line items are present, their `Kwota` values
always sum exactly to the corresponding `SumaObciazen`/`SumaOdliczen` (31/31 and 25/25
sums checked, zero mismatches). No `Obciazenia/Kwota` was ever observed negative — charges
are always non-negative.

### 3.3 `Powod` (reason) text observed

- **portowa** (Coca-Cola-dominated): `Kaucja (opakowania zwrotne)` (19), `Opłaty
  nieobjęte podatkiem VAT` (4), `Wartość Łączna System Kauc.plastik` (2), `KAUCJA BUTELKA
  PET 0,50 zł` (2) — all deposit/packaging related.
- **parkowa** (utility- and distributor-dominated): `DRS PET` (8, a national deposit
  return scheme), `Opakowania / Palety` (3), `odsetki za nieterminową wpłatę` (3,
  late-payment interest), `nadpłata` (3, overpayment credit), `Pozostałe należności
  wymagalne na dzień` (2), `zadłużenie` (1, outstanding debt), `Rozliczenie salda` (1,
  balance settlement).

Frito Lay invoices in parkowa show clear `DoZaplaty`/`gross_total` diffs (see examples
below) driven by deposit charges, but their `Obciazenia/Powod` text was not captured by
this reason-frequency scan — it is present per line item but did not surface as a
distinct string in the aggregate count (not investigated further; does not affect the
arithmetic, only the reason label shown to a user).

### 3.4 Concrete examples

| KSeF number                           | Seller               | `gross_total` | `DoZaplaty` |         Diff | Cause                                                                     |
| ------------------------------------- | -------------------- | ------------: | ----------: | -----------: | ------------------------------------------------------------------------- |
| `5291347721-20260703-73A563000028-45` | Frito Lay Poland     |       4389.97 |     5476.47 |     +1086.50 | deposit charge only                                                       |
| `5291347721-20260805-5E986300001D-91` | Frito Lay Poland     |       3903.70 |     4418.20 |      +514.50 | deposit charge only                                                       |
| `5242106963-20260730-3876FDC00003-EC` | Coca-Cola HBC Polska |       1562.49 |     1648.89 |       +86.40 | deposit charge (+158.40) partly offset by a deposit return (−72.00)       |
| `5242106963-20260628-703772400000-5B` | Coca-Cola HBC Polska |       2636.76 |     2507.16 |  **−129.60** | deposit return (−187.20) exceeds new deposit charge (+57.60) — net credit |
| `5261040567-20260617-71E4CEC00193-CF` | T-Mobile Polska      |        343.72 |      343.85 |        +0.13 | rounding-scale adjustment (`Opłaty nieobjęte podatkiem VAT`)              |
| `5830001190-20260803-497E42C000FE-D1` | Energa-Operator      |       2393.83 |     2414.39 |       +20.56 | late-payment interest charge                                              |
| `5830001190-20260803-3930E30000CE-4A` | Energa-Operator      |       6563.12 |     2634.83 | **−3928.29** | prior overpayment credit — see §5.3, sign hazard                          |
| `5272706082-20260806-4A1DFDC001C2-CC` | myORLEN              |        392.07 |      767.90 |      +375.83 | charge, reason not captured in this scan                                  |

`data/coca-cola.zwrotne.xml` and `data/frito.xml`, provided alongside this analysis,
correspond exactly to the `5242106963-...-3876FDC00003-EC` and
`5291347721-...-73A563000028-45` rows above respectively — they are real, in-database
samples, not synthetic. `data/golde-fruits.bez-do-zaplaty.xml` has no `Rozliczenie`
element at all, confirming the "normal" case: no block means `gross_total` is the amount
due, full stop.

---

## 4. What the system does today

- `parsePurchaseInvoiceXml()` (`src/ksef/invoice-parser.ts`) maps `Fa/P_15` to
  `invoices.gross_total` and stops there. It does not look at `Fa/Rozliczenie` in any
  form.
- `invoices.gross_total` is the only monetary total column in the schema
  (`src/db/schema.ts`); there is no column for amount due, overpayment, or a
  charges/deductions breakdown.
- Nothing in the UI or API distinguishes "what the invoice document totals to" from
  "what the seller actually expects to be paid." Every consumer of `gross_total` is
  implicitly assuming the two are the same — true 95–96 % of the time, silently wrong
  the rest.

**Direct answer to "how does the app know what to show in `gross_total`":** it doesn't
choose — `gross_total` is unconditionally `Fa/P_15`, regardless of whether a
`Rozliczenie/DoZaplaty` exists and says otherwise. There is currently no concept of an
"amount due" distinct from the invoice's own gross total.

---

## 5. Suggested improvement

Not implemented; proposal only.

### 5.1 Store the resolved amount due

Add a nullable `amount_due` column (or `payment_due_amount`, matching the
`payment_due_date` naming proposed in
[`INVOICE_TYPES_ANALYSIS.md §6`](./INVOICE_TYPES_ANALYSIS.md#6-suggested-improvement)):

- If `Rozliczenie/DoZaplaty` is present, store it.
- If `Rozliczenie/DoRozliczenia` is present instead (portowa: 1 invoice), store `null` and
  handle the overpayment case separately — a `DoRozliczenia` means money is owed *back*,
  not owed *further*, which is a materially different kind of row from an amount-due
  view's point of view. Do not conflate it with `amount_due`.
- Otherwise (no `Rozliczenie`, or an empty one, ~96 % of invoices), leave `amount_due`
  `null` and treat `gross_total` as authoritative — do not duplicate `gross_total` into
  a second column when the two are equal, to avoid an update-consistency hazard between
  them.

### 5.2 Optionally store the breakdown

If per-line "why does this differ" detail is wanted (e.g. to show "includes 158.40 zł
deposit charge, less 72.00 zł deposit return" in a UI), add a child table analogous to
the correction-reference proposal in `INVOICE_TYPES_ANALYSIS.md §6` — one row per
`Obciazenia`/`Odliczenia` line, storing `kind` (charge/deduction), `amount`, and `reason`
text. Given the low prevalence (≤29 invoices per tenant observed), this is a "nice to
have," not essential — the single `amount_due` total already answers the reconciliation
question.

### 5.3 Hazard: `Odliczenia`/`SumaOdliczen` sign convention is not consistent across issuers

This is the one genuine data hazard found and must not be silently smoothed over by an
implementation.

- **Coca-Cola HBC Polska** (8 invoices with `Odliczenia`, portowa) always stores
  `SumaOdliczen` as **already negative** (e.g. `-72.0`), matching the schema's additive
  identity literally: `DoZaplaty = gross_total + SumaObciazen + SumaOdliczen`.
- **Energa-Operator S.A.** (parkowa, ksef number
  `5830001190-20260803-3930E30000CE-4A`) stores `SumaOdliczen` as a **positive**
  magnitude for a `nadpłata` (overpayment credit) reason:

  ```xml
  <Rozliczenie>
      <Obciazenia><Kwota>0.00</Kwota><Powod>odsetki za nieterminową wpłatę</Powod></Obciazenia>
      <SumaObciazen>0.00</SumaObciazen>
      <Odliczenia><Kwota>3928.29</Kwota><Powod>nadpłata</Powod></Odliczenia>
      <SumaOdliczen>3928.29</SumaOdliczen>
      <!-- DoZaplaty elsewhere in the same block: 2634.83 -->
  </Rozliczenie>
  ```

  Here `gross_total (6563.12) + SumaObciazen (0) + SumaOdliczen (3928.29)` = `10491.41`,
  which does **not** match the actual `DoZaplaty` of `2634.83`. The correct computation
  for this document is `gross_total − |SumaOdliczen|` = `6563.12 − 3928.29 = 2634.83` ✓.

- **The robust formula, verified against every one of the 28 differing invoices in both
  tenants with zero mismatches, is:**

  $$\text{DoZaplaty} = \text{gross\_total} + \text{SumaObciazen} - |\text{SumaOdliczen}|$$

  i.e. always treat `SumaOdliczen` as an unsigned magnitude to subtract, never trust its
  stored sign. This formula reproduces every observed `DoZaplaty` in both databases,
  including the Coca-Cola rows where `SumaOdliczen` happens to already be negative
  (subtracting the absolute value has the same effect there) and the Energa-Operator row
  where it does not.

- **Recommendation:** if `Rozliczenie/DoZaplaty` is ever computed rather than read
  verbatim, use `gross_total + SumaObciazen − |SumaOdliczen|`, never a plain sum. Better
  still — since `DoZaplaty` is present as a literal, required-in-practice field whenever
  a real difference exists (§3.1: 28/28 of the differing invoices had it directly) —
  **read `DoZaplaty` (or `DoRozliczenia`) verbatim from the XML rather than recomputing
  it from the parts.** The parts (`Obciazenia`/`Odliczenia`/sums) are only needed for the
  optional breakdown in §5.2, and even there the sign of `SumaOdliczen`/`Odliczenia/Kwota`
  must be normalized to a magnitude before display, not assumed.

### 5.4 Not worth modelling

`DoRozliczenia` (the overpayment-refund alternative to `DoZaplaty`) was observed exactly
once across both tenants. Storing it is cheap (one nullable column or reusing the same
`amount_due` column with a `kind` flag) but building dedicated UI for it is not justified
by this sample size; revisit if it becomes more common.

---

## 6. Reproducing the measurements

Each measurement above was produced by a short, disposable Node script using
`node:sqlite`'s `DatabaseSync`, opened read-only (`{ readOnly: true }`) against
`data/tenants/<tenant>/ksef-exporter.sqlite`, scanning the `raw_xml` column of every
invoice with regex extraction (namespace-prefix-agnostic, matching the parser's own
`removeNSPrefix: true` normalization) for `Rozliczenie`, `Obciazenia`, `Odliczenia`,
`SumaObciazen`, `SumaOdliczen`, `DoZaplaty`, and `DoRozliczenia`. No script was committed
to the repository; re-run by writing an equivalent script against the same two database
files, or ask an AI coding agent to reproduce it from this document.

---

## 7. Open questions

1. Should `amount_due` be computed at import time (stored once, alongside
   `gross_total`) or computed on read from `raw_xml`? Given `raw_xml` is already the
   source of truth for the [`INVOICE_ITEMS_PLAN.md`](./INVOICE_ITEMS_PLAN.md) line-items
   work, storing it at import time (consistent with how `gross_total` itself is handled)
   is the more consistent choice, but this hasn't been decided.
2. Should re-sync recompute `amount_due` for already-imported invoices (a backfill), the
   way `INVOICE_ITEMS_PLAN.md` proposes for line items? The same backfill mechanism could
   likely be reused.
3. How should `DoRozliczenia` (overpayment/refund) surface in an "amount owed" view —
   as a negative amount due, a separate flag, or excluded entirely? Only one example
   exists to reason from.
4. Is the Frito Lay `Powod` omission (§3.3) a genuine absence of the `Powod` element in
   their `Obciazenia` blocks (which the schema marks as required — `minOccurs` not
   stated as 0), or an artifact of this analysis's regex extraction? Worth a direct
   re-check of `data/frito.xml`'s raw `Obciazenia` block before relying on `Powod` being
   universally present in any future implementation.
5. Are there issuers beyond Energa-Operator using the positive-magnitude
   `SumaOdliczen` convention that simply weren't sampled here (only 3 parkowa invoices and
   8 portowa invoices had any `Odliczenia` at all)? The `|SumaOdliczen|` formula in §5.3 is
   robust to either convention, so this matters only if the per-line breakdown (§5.2) is
   built and needs to show a correctly-signed line item, not for `DoZaplaty` itself.
