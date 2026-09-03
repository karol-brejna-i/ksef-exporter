Take a look at @design/HISTORICAL_BACKFILL_SCRIPT.md.

It describes mechanics behind the historical backfill scripts used for synchronizing purchase invoices -- `src/tools/backfill-sales.ts`.

The script mentions the problem with wrong windowing mechanismr, particularly in relation to the `hasMore` flag and the future `windowTo` parameter. See: "## 5. A real hazard this script exposed: `hasMore` and a future `windowTo`"

Today I made another import of purchase invoices using the backfill script.
It looks like the problem with the wrong windowing mechanism is still present.
This time the window is not in the future.

See the following terminal output for an example of the issue:

```bash
ksef-exporter on  main !? via 🐍 v3.14.7 via  v24.16.0 ➜ BACKFILL_DIRECTION=purchase \
BACKFILL_WINDOW_FROM=2026-08-01 \
BACKFILL_WINDOW_TO=2026-08-31 \
BACKFILL_RESET_CONTINUATION=true \
APP_ENV=parkowa pnpm run backfill:sales
$ tsx src/tools/backfill-sales.ts
Backfilling purchase invoices for NIP 9462136075 (PRD) into ./data/tenants/parkowa/ksef-exporter.sqlite, window 2026-08-01 -> 2026-08-31...
Reset stored Subject2 continuation point to null.

[call 1] sync_runs id=36, continuationBefore=null
[call 1] fetched=160 inserted=0 duplicate=160 hasMore=true

[call 2] sync_runs id=37, continuationBefore=2026-08-30T22:00:00+00:00
[call 2] fetched=0 inserted=0 duplicate=0 hasMore=true

[call 3] sync_runs id=38, continuationBefore=2026-08-30T22:00:00+00:00
[call 3] fetched=0 inserted=0 duplicate=0 hasMore=true

[call 4] sync_runs id=39, continuationBefore=2026-08-30T22:00:00+00:00
[call 4] fetched=0 inserted=0 duplicate=0 hasMore=true

[call 5] sync_runs id=40, continuationBefore=2026-08-30T22:00:00+00:00
[call 5] fetched=0 inserted=0 duplicate=0 hasMore=true

[call 6] sync_runs id=41, continuationBefore=2026-08-30T22:00:00+00:00
[call 6] fetched=0 inserted=0 duplicate=0 hasMore=true

[call 7] sync_runs id=42, continuationBefore=2026-08-30T22:00:00+00:00
[call 7] fetched=0 inserted=0 duplicate=0 hasMore=true
[ELIFECYCLE] Command failed with exit code 130.
ksef-exporter on  main !? via 🐍 v3.14.7 via  v24.16.0 ➜
```

First of all, I want you to diagnose the cause of the repeated `hasMore=true` responses despite no new data being fetched. Also, notice `continuationBefore=2026-08-30T22:00:00+00:00` (it doesn't advance).

Then, we will need to investigate, why the tests didn't catch that. Do we have enough tests in this area to cover the windowing mechanism and the `hasMore` flag behavior?

Don't act yet. First show me the plan you have for addressing the problem.
Remember to use subagents during your analysis (see AGENTS.md and CLAUDE.md). 
Please, confirm you understand my request. Ask clarifying questions if needed. Present your plan as you would approach this problem. When I agree, I will give you a go.