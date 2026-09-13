You claim we have a fix for hasMore problem. 
I've just ran backfill script with date in the future. 
See the trace from two recent executions:
```
ksef-exporter on  main ! via 🐍 v3.14.7 via  v24.16.0 ➜ BACKFILL_WINDOW_FROM=2026-08-01 BACKFILL_WINDOW_TO=2026-09-07 BACKFILL_RESET_CONTINUATION=true APP_ENV=parkowa pnpm run backfill:invoices
$ tsx src/tools/backfill-invoices.ts
Backfilling purchase + sales invoices for NIP 9462136075 (PRD) into ./data/tenants/parkowa/ksef-exporter.sqlite, window 2026-08-01 -> 2026-09-07...

=== purchase ===
Reset stored Subject2 continuation point to null.

[purchase call 1] sync_runs id=48, continuationBefore=null
[purchase call 1] fetched=184 inserted=24 duplicate=160 hasMore=true

[purchase call 2] sync_runs id=49, continuationBefore=2026-09-06T10:48:47.661007+00:00
[purchase call 2] fetched=0 inserted=0 duplicate=0 hasMore=true

[purchase call 3] sync_runs id=50, continuationBefore=2026-09-06T10:48:53.27589+00:00
[purchase call 3] fetched=0 inserted=0 duplicate=0 hasMore=true

[purchase call 4] sync_runs id=51, continuationBefore=2026-09-06T10:48:58.44412+00:00
[purchase call 4] fetched=0 inserted=0 duplicate=0 hasMore=true
[ELIFECYCLE] Command failed with exit code 130.


ksef-exporter on  main ! via 🐍 v3.14.7 via  v24.16.0 ➜ BACKFILL_WINDOW_FROM=2026-08-01 BACKFILL_WINDOW_TO=2026-09-07 BACKFILL_RESET_CONTINUATION=true APP_ENV=portowa pnpm run backfill:invoices
$ tsx src/tools/backfill-invoices.ts
Backfilling purchase + sales invoices for NIP 9581716689 (PRD) into ./data/tenants/portowa/ksef-exporter.sqlite, window 2026-08-01 -> 2026-09-07...

=== purchase ===
Reset stored Subject2 continuation point to null.

[purchase call 1] sync_runs id=31, continuationBefore=null
[purchase call 1] fetched=178 inserted=42 duplicate=136 hasMore=true

[purchase call 2] sync_runs id=32, continuationBefore=2026-09-06T10:49:27.470583+00:00
[purchase call 2] fetched=0 inserted=0 duplicate=0 hasMore=true

[purchase call 3] sync_runs id=33, continuationBefore=2026-09-06T10:49:33.059617+00:00
[purchase call 3] fetched=0 inserted=0 duplicate=0 hasMore=true

[purchase call 4] sync_runs id=34, continuationBefore=2026-09-06T10:49:38.232939+00:00
[purchase call 4] fetched=0 inserted=0 duplicate=0 hasMore=true

[purchase call 5] sync_runs id=35, continuationBefore=2026-09-06T10:49:43.51703+00:00
[purchase call 5] fetched=0 inserted=0 duplicate=0 hasMore=true
[ELIFECYCLE] Command failed with exit code 130.
ksef-exporter on  main ! via 🐍 v3.14.7 via  v24.16.0 ➜
```

(I stopped each execution manually to avoid limitless loops.)

As you see, hasMore is `true` when fetched and inserted are 0. 
We have problem with burining export cycles from ksef quota again.

First, analyze this session history, hour thoughts, design/HISTORICAL_BACKFILL_SCRIPT.md, the sources you had and synthetize a dedicated document that will be a context for future AI agents work on my new goal (and similar goals). Make the document as self sufficient as possible, so the agents don't need to reach for external resources that much. Suggest division of work (for tasks as my now goal) to subagents with the goal of delivering the solution faster (parallel execution) and token usage optimization.

With this context in mind, I want you to diagnose the cause of the repeated `hasMore=true` responses despite no new data being fetched.
Among others, consider the following aspects:
1. Did I diagnose the problem correctly? Or did I break the loop too early?
2. what is the cause of current issue
3. propose additional debug code for us to be able to track similar cases in the future 
4. propose new testes that cover such situations and similar code changes impact
5. show me how to select invoices imported in given session 
6. propose a fix

 Also, notice `continuationBefore=2026-08-30T22:00:00+00:00` (it doesn't advance).

Then, we will need to investigate, why the tests didn't catch that. Do we have enough tests in this area to cover the windowing mechanism and the `hasMore` flag behavior?

Don't act yet. First show me the plan you have for addressing the problem.
Remember to use subagents during your analysis (see AGENTS.md and CLAUDE.md). 
Please, confirm you understand my request. 
Ask clarifying questions if needed. Present your plan as you would approach this problem. When I agree, 
I will give you a go.