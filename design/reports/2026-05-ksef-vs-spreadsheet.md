# KSeF vs. Historical Spreadsheet — May 2026 Comparison

**Date produced:** 2026-07-09
**Period analyzed:** May 2026 (`2026-05-01` to `2026-06-01`)
**Purpose:** Sanity-check the KSeF Exporter engine against real production data, and compare it with the owner's manually-maintained spreadsheet (`design/ROZLICZENIE PARKOWA 2025.xlsx`, tab `MAJ 26`) to validate the approach and surface any interesting discrepancies before building further.

This is a one-off analysis document, not a generated report from the app itself (the app has no reporting UI yet — see `design/IMPLEMENTATION_PLAN.md`, Phase 8). All underlying data lives in the gitignored `data/` folder (real business data, never committed); this document contains only the aggregated findings.

## Executive summary

- **KSeF PROD access confirmed working end-to-end**: 99 real purchase invoices pulled for May 2026, from 41 distinct sellers, totaling **150,210.56 PLN**. All 99 parsed successfully (this run also caught and fixed a real parser bug — see `design/IMPLEMENTATION_PLAN.md` Phase 2/4 notes on namespace-prefixed invoice XML).
- **Most recurring vendors reconcile cleanly** with the spreadsheet once name typos/abbreviations are accounted for (e.g. `ENEGA OPERATOR` → Energa-Operator S.A., `IMNTERWORKS` → Interworks Mateusz Interewicz, `ADA-CHEMIA` → ADA Fashion Adrianna Stawowy — same amount and invoice count on both sides).
- **KSeF shows ~42,900 PLN more** in invoice-eligible costs (Media/Zakup towarów/Inne) than the spreadsheet recorded for the same categories — dominated by two large one-off invoices with **no corresponding spreadsheet line at all**:
  - **Ewelina Trocka — 25,500.00 PLN** (2 invoices)
  - **Jelitkowo Holding Wawel Development Sp. z o.o. Sp.k. — 20,000.00 PLN** (1 invoice)
- Most of the spreadsheet-only entries are costs that **structurally cannot appear in KSeF** (taxes, payroll, bank/terminal fees, retail receipts) — this is expected and matches `design/SPEC.md` §4's rationale for the manual-entry feature (HU-02).

## Methodology

1. Pulled real purchase invoices (`Subject2`/buyer role) from the **PRD** KSeF environment for the exact calendar window `2026-05-01`–`2026-06-01` (`dateType=PermanentStorage`).
2. Extracted the cost-invoice mini-tables (Media / Zakup towarów / Inne / Koszty bez FV / Inewstycje) from the `MAJ 26` tab of the owner's spreadsheet.
3. Grouped both datasets by normalized seller/vendor name (diacritics stripped, legal suffixes like `Sp. z o.o.`/`S.A.` removed, correction/credit-note rows merged into their base vendor) and matched them up, using exact-name matching first, a small list of human-confirmed aliases for known typos, then fuzzy (bigram similarity) matching for anything left.
4. Cross-checked category totals against the spreadsheet's own subtotal formulas (an independent sanity check — they matched exactly).

**Caveats:**
- This is vendor-level (aggregate) reconciliation, not invoice-line-level — a vendor with the same total and invoice count on both sides is treated as "matched" even though individual invoice numbers weren't cross-checked.
- A couple of small entries (e.g. `FORUM-MARKERY` sheet entry vs. "Przedsiębiorstwo ... FORUM" KSeF seller, both 89.46 PLN) are very likely the same vendor but weren't confidently auto-matched — the fuzzy matcher only has so much to work with when a spreadsheet uses a short nickname for a seller with a long legal name.
- `TRIADA` matched by seller and invoice count (14 on both sides) but the totals differ by -6,616.15 PLN — worth a manual look (possibly a rounding/net-vs-gross recording difference, or a per-invoice amount mismatch), not investigated further here.

## Headline numbers

| Source | Entries | Total gross (PLN) |
| --- | ---: | ---: |
| KSeF (all May 2026 purchase invoices) | 99 | 150,210.56 |
| Spreadsheet — Media | 7 | 8,742.42 |
| Spreadsheet — Zakup towarów | 58 | 69,514.76 |
| Spreadsheet — Inne | 34 | 29,057.33 |
| **Spreadsheet — invoice-eligible subtotal** | **99** | **107,314.51** |
| Spreadsheet — Koszty bez FV (no-invoice costs, e.g. ZUS/VAT-7/bank fees) | 6 | 72,298.00 |
| Spreadsheet — Inewstycje (investments) | 0 | 0.00 |
| **Spreadsheet — grand total (all categories)** | **105** | **179,612.51** |

KSeF's invoice total (150,210.56) is **42,896.05 PLN higher** than the spreadsheet's invoice-eligible subtotal (107,314.51).

## Vendor-level reconciliation

### Matched vendors (26 groups)

Vendor, sheet total/entry-count, KSeF total/invoice-count. Two flagged with a delta worth a manual look.

| Vendor | Sheet (PLN / #) | KSeF (PLN / #) | Note |
| --- | ---: | ---: | --- |
| Eurocash (incl. corrections) | 25,374.58 / 16 | 25,374.58 / 16 | exact |
| Triada Augusto Pomorze | 20,216.14 / 14 | 26,832.29 / 14 | **delta -6,616.15** |
| Piwowar | 5,958.37 / 4 | 5,958.37 / 4 | exact |
| Ada Fashion (sheet: "ADA-CHEMIA") | 5,235.60 / 5 | 5,235.60 / 5 | exact, name alias |
| Frito Lay | 4,854.78 / 2 | 4,854.78 / 2 | exact |
| Golden Fruits | 3,773.15 / 8 | 3,773.15 / 8 | exact |
| Koryb | 3,447.95 / 1 | 3,447.95 / 1 | exact |
| Energa-Operator (sheet: "ENEGA OPERATOR") | 3,210.56 / 1 | 3,210.56 / 1 | exact, typo |
| Mother Nature (sheet: "MOTHER NATURE-KAWA") | 2,955.11 / 2 | 2,955.11 / 2 | exact |
| Karpiński Prawdziwe Lody | 2,692.67 / 2 | 2,692.67 / 2 | exact |
| Enea S.A. | 2,641.55 / 1 | 2,641.55 / 2 | same total, split across 2 invoices in KSeF |
| Gdańskie Wodociągi | 2,026.98 / 1 | 2,026.98 / 1 | exact |
| Taktum | 1,414.50 / 1 | 1,414.50 / 1 | exact |
| Interworks (sheet: "IMNTERWORKS") | 731.23 / 1 | 731.23 / 1 | exact, typo |
| Biuro Rachunkowości (sheet: "KSIĘGOWA") | 700.00 / 1 | 700.00 / 1 | exact, generic label |
| El-Informar Marcin Malec | 492.00 / 1 | 492.00 / 1 | exact |
| Pan Kluczyk | 320.00 / 1 | 320.00 / 1 | exact |
| Smart Serwis (sheet: "SMART SEREIS") | 147.60 / 1 | 147.60 / 1 | exact, typo |
| T-Mobile | 129.15 / 1 | 129.15 / 1 | exact |
| Alpha Dan Janusz Chilewski | 70.90 / 1 | 70.90 / 1 | exact |
| eprofer.pl | 69.14 / 1 | 69.14 / 1 | exact |
| Security Sp.k. | 61.50 / 1 | 61.50 / 1 | exact |
| Hurtownia Fasolka | 60.70 / 1 | 62.70 / 1 | delta -2.00 |
| Inform Marek Leżoń | 47.00 / 1 | 47.00 / 1 | exact |
| Poczta Polska | 30.26 / 1 | 30.26 / 2 | same total, split across 2 invoices in KSeF |
| FHU "Marmax" | 18.76 / 7 | 18.76 / 7 | exact |

### Sheet-only entries (16 groups, 20,634.33 PLN) — mostly expected, non-invoice costs

| Sheet label | Category | Gross (PLN) | # | Likely explanation |
| --- | --- | ---: | ---: | --- |
| VAT-7 | Inne | 6,378.00 | 1 | tax filing, not an invoice |
| KONCESJA | Inne | 3,989.01 | 1 | alcohol licence fee, not an invoice |
| ZUS | Inne | 2,884.49 | 1 | social security contribution, not an invoice |
| INWENTARYZACJA | Inne | 2,214.00 | 2 | stocktaking service — possibly a real invoice, but no obvious KSeF match this month |
| PODATEK EWELINA | Inne | 1,982.00 | 1 | payroll-adjacent tax (out of scope per SPEC §5) |
| CASTORAMA | Inne | 631.21 | 4 | a seed categorization rule (SPEC §2.6), but no KSeF invoice this month — likely paid by card/receipt |
| PIT-4R | Inne | 551.00 | 1 | tax filing, not an invoice |
| PALIWO | Inne | 511.36 | 2 | fuel — likely a small receipt, not a KSeF invoice |
| PGNIG | Media | 424.81 | 1 | gas utility — surprisingly no matching KSeF invoice this month |
| PROWIZJE TERMINAL | Inne | 338.62 | 1 | card terminal fee, not an invoice |
| BIEDRONKA | Zakup towarów | 223.25 | 2 | retail receipts |
| ODPADY KOMUNALNE | Media | 219.37 | 1 | municipal waste fee |
| TELEFON | Media | 90.00 | 1 | generic phone line item |
| FORUM-MARKERY | Inne | 89.46 | 1 | likely = KSeF's "Przedsiębiorstwo ... FORUM" (89.46 PLN, exact amount match, not auto-linked) |
| EMPIK-MARKERY | Inne | 57.95 | 1 | office supplies, small receipt |
| PROWIZJE BANK | Inne | 49.80 | 1 | bank fee, not an invoice |

### KSeF-only sellers (14 groups, 56,912.23 PLN) — the interesting new information

| KSeF seller | Gross (PLN) | # invoices |
| --- | ---: | ---: |
| **Ewelina Trocka** | **25,500.00** | 2 |
| **Jelitkowo Holding Wawel Development Sp. z o.o. Sp.k.** | **20,000.00** | 1 |
| PKO Masterlease S.A. | 3,289.94 | 2 |
| HIPODROM SOPOT Sp. z o.o. | 2,996.94 | 1 |
| HORECA OPTIMA Sp. z o.o. | 2,214.00 | 2 |
| P4 sp. z o.o. (2 legal-name variants merged) | 621.70 | 2 |
| Shell Polska sp. z o.o. | 599.11 | 2 |
| Polskie ePłatności Sp. z o.o. | 360.92 | 2 |
| myORLEN sp. z o.o. | 304.39 | 1 |
| Iwona Cichosz "Pasaż" | 293.01 | 1 |
| UpGo Joanna Ziętek | 229.77 | 1 |
| ORLEN S.A. | 224.01 | 1 |
| ZOOLOGIC Paweł Mróz | 188.98 | 1 |
| Przedsiębiorstwo ... "FORUM" - Rajmund Osiński | 89.46 | 1 |

## Recommendations / open questions for the owner

1. **Worth asking about directly**: the "Ewelina Trocka" (25,500 PLN) and "Jelitkowo Holding Wawel Development" (20,000 PLN) invoices — both large, one-off, and completely absent from the monthly cost tracking. Note "Ewelina" also appears in the spreadsheet as a payroll-tax line (`PODATEK EWELINA`), which may or may not be related.
2. **PGNIG and CASTORAMA** (both existing seed categorization rules per SPEC §2.6) had zero matching KSeF invoices this month despite appearing in the spreadsheet — confirms these are sometimes paid via receipt/card rather than a KSeF invoice, which the engine will need to handle via the manual-entry feature (HU-02, Phase 6).
3. The `TRIADA` total delta (-6,616.15 PLN across the same invoice count) is the one true numerical anomaly worth a manual look — not explained by naming/typos.

## Tools used (reusable — rerun for any future month)

All scripts are real, checked-in project tooling (not throwaway), documented in `design/IMPLEMENTATION_PLAN.md`'s engineering conventions as manual/ad-hoc utilities outside the automated test suite. None of them write to the application database.

| Script | Command | What it does |
| --- | --- | --- |
| [`src/ksef/smoke-invoices.ts`](../../src/ksef/smoke-invoices.ts) | `pnpm run smoke:invoices` | Quick end-to-end check that KSeF auth + invoice extraction works against a real environment; prints a summary only. |
| [`src/ksef/dump-invoices.ts`](../../src/ksef/dump-invoices.ts) | `DOTENV_CONFIG_PATH=.secrets/tokens.env DUMP_WINDOW_FROM=2026-05-01 DUMP_WINDOW_TO=2026-06-01 pnpm run dump:invoices` | Fetches real KSeF invoices for an explicit calendar window and writes raw XML + parsed JSON to `data/invoices/` (gitignored). |
| [`src/tools/extract-xlsx.ts`](../../src/tools/extract-xlsx.ts) | `pnpm run extract:xlsx -- "MAJ 26"` | Extracts the cost-invoice mini-tables from a monthly tab of `design/ROZLICZENIE PARKOWA 2025.xlsx` into `data/comparison/<slug>.json` (gitignored). |
| [`src/tools/reconcile.ts`](../../src/tools/reconcile.ts) | `pnpm run reconcile -- data/invoices/parsed.json data/comparison/maj-26.json` | Groups both datasets by normalized vendor name and prints matched / sheet-only / KSeF-only breakdowns with totals — the basis for the tables above. |

**To reproduce this exact report for a different month:**

```sh
# 1. Fetch KSeF invoices for the target month (adjust dates)
DOTENV_CONFIG_PATH=.secrets/tokens.env \
  DUMP_WINDOW_FROM=2026-06-01 DUMP_WINDOW_TO=2026-07-01 \
  pnpm run dump:invoices

# 2. Extract the matching spreadsheet tab
pnpm run extract:xlsx -- "CZERWIEC 26"

# 3. Reconcile the two
pnpm run reconcile -- data/invoices/parsed.json data/comparison/czerwiec-26.json
```

Note: each `dump:invoices` run starts a new KSeF export, which is subject to KSeF's own server-side rate limit (see `src/ksef/rate-limit.ts` and `design/IMPLEMENTATION_PLAN.md`) — don't run it back-to-back with other export-starting scripts in a short window.
