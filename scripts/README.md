# Scripts

Miscellaneous helper scripts for the KSeF Exporter project.

## export-invoices

Exports invoices — and their line items — from the SQLite database to an
`.xlsx` file with two sheets: "Faktury" (invoices) and "Pozycje" (line
items). Implemented in Node/TypeScript at `src/tools/export-invoices.ts`
(no separate Python environment needed).

### Usage

```bash
pnpm run export:invoices                                                     # all invoices → data/invoices-export.xlsx
pnpm run export:invoices -- --db path/to/custom.sqlite
pnpm run export:invoices -- --from 2026-05-01                                # from May 1st onward
pnpm run export:invoices -- --to 2026-06-30                                  # up to June 30th
pnpm run export:invoices -- --from 2026-05-01 --to 2026-06-30 ~/Desktop/maj-czerwiec.xlsx
```

Note the `--` before any flags — required so `pnpm` forwards them to the
underlying script, same as every other `tsx`-backed script in this repo.

Every run prints the resolved parameters (db path, date range, output path)
before exporting. The script also validates that `--db` points at a real
SQLite file with an `invoices` table before querying it, rather than letting
a raw error surface — or, worse, silently creating a fresh empty database at
a typo'd path.

The "Faktury" sheet includes every invoice column except `raw_xml` (not
spreadsheet-friendly); the "Pozycje" sheet includes every `invoice_items`
column, one row per line item, linked back to its invoice via `ksef_number`
and `invoice_number`.

Last updated: 2026-09-03
