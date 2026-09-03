

There is a dedicated pnpm task for backfilling the invoices.

It is described here: design/HISTORICAL_BACKFILL_SCRIPT.md.

In this version you can import either `sales` or `purchase` (not both at once).

Here is typical call:

```
BACKFILL_DIRECTION=purchase \
BACKFILL_WINDOW_FROM=2026-08-01 \
BACKFILL_WINDOW_TO=2026-08-31 \
BACKFILL_RESET_CONTINUATION=true \
APP_ENV=parkowa pnpm run backfill:sales
```



## Import and export everything


```bash
BACKFILL_WINDOW_FROM=2026-08-01 BACKFILL_WINDOW_TO=2026-08-31 BACKFILL_RESET_CONTINUATION=true APP_ENV=parkowa pnpm run backfill:invoices
BACKFILL_WINDOW_FROM=2026-08-01 BACKFILL_WINDOW_TO=2026-08-31 BACKFILL_RESET_CONTINUATION=true APP_ENV=parkowa pnpm run backfill:invoices
BACKFILL_WINDOW_FROM=2026-08-01 BACKFILL_WINDOW_TO=2026-08-31 BACKFILL_RESET_CONTINUATION=true APP_ENV=portowa pnpm run backfill:invoices
BACKFILL_WINDOW_FROM=2026-08-01 BACKFILL_WINDOW_TO=2026-08-31 BACKFILL_RESET_CONTINUATION=true APP_ENV=portowa pnpm run backfill:invoices  
```
    > Remember to change the dates.


```
python scripts/export-invoices.py --db data/tenants/parkowa/ksef-exporter.sqlite parkowa.xlsx
python scripts/export-invoices.py --db data/tenants/portowa/ksef-exporter.sqlite portowa.xlsx


---
backup



## Start the components


API:
```
APP_ENV=parkowa pnpm run dev:api 2>&1 | tee api.log
```

Web:
```
APP_ENV=parkowa pnpm run dev:web
```


