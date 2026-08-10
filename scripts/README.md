# Scripts

Miscellaneous helper scripts for the KSeF Exporter project.

## export-invoices.py

Exports all invoices from the SQLite database to an `.xlsx` file.

### Setup

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r scripts/requirements.txt
```

### Usage

```bash
python scripts/export-invoices.py                          # all invoices → data/invoices-export.xlsx
python scripts/export-invoices.py --from 2026-05-01        # from May 1st onward
python scripts/export-invoices.py --to 2026-06-30          # up to June 30th
python scripts/export-invoices.py --from 2026-05-01 --to 2026-06-30 ~/Desktop/maj-czerwiec.xlsx
```

Last updated: 2026-08-10 12:00
