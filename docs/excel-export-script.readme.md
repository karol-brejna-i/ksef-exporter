# Scripts

Miscellaneous helper scripts for the KSeF Exporter project.

## export-invoices

Exports invoices — and their line items — from the SQLite database to an
`.xlsx` file with two sheets: "Faktury" (invoices) and "Pozycje" (line
items). Implemented in Node/TypeScript at `src/tools/export-invoices.ts`.

### Usage

```bash
pnpm run export:invoices                                                     # all invoices → data/invoices-export.xlsx
APP_ENV=parkowa pnpm run export:invoices                                     # resolves DATABASE_PATH from .env.parkowa
pnpm run export:invoices -- path/to/custom.sqlite
pnpm run export:invoices -- --from 2026-05-01                                # from May 1st onward
pnpm run export:invoices -- --to 2026-06-30                                  # up to June 30th
pnpm run export:invoices -- --from 2026-05-01 --to 2026-06-30 --out ~/Desktop/maj-czerwiec.xlsx
```

Notes:
- The `--` after the task name is required so pnpm forwards the flags through.
- The database is the first positional argument, else `$DATABASE_PATH` (itself
  resolved from `.env`/`.env.<APP_ENV>`, same as `dev:api`/`dev:web`), else
  `./data/ksef-exporter.sqlite` — the same convention every other
  `src/tools/*.ts` script follows. The output path is the `--out` flag,
  defaulting to `data/invoices-export.xlsx`.
- `--from`/`--to` are optional and inclusive; omit both to export everything.

Every run prints the resolved parameters (db path, date range, output path)
before exporting. The script also validates that the database path points at
a real SQLite file with an `invoices` table before querying it, rather than
letting a raw error surface — or, worse, silently creating a fresh empty
database at a typo'd path.

The "Faktury" sheet includes every invoice column except `raw_xml` (not
spreadsheet-friendly); the "Pozycje" sheet includes every `invoice_items`
column, one row per line item, linked back to its invoice via `ksef_number`
and `invoice_number`.

Last updated: 2026-09-06
