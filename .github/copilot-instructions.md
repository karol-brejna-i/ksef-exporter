# KSeF Exporter Agent Context

This is the shared, tool-agnostic agent context for the repository. `CLAUDE.md` imports
it rather than duplicating it, and holds only Claude Code specifics. Add durable rules
here so every assistant picks them up.

## Start here

- Read `design/SPEC.md` for product requirements and KSeF mechanics.
- Read `design/IMPLEMENTATION_PLAN.md` for phase status and the next work. Treat its "Current implementation status" section as authoritative; do not infer completion from scaffolding alone.
- Read `design/IMPORT_OBSERVABILITY_PLAN.md` before changing import logging, diagnostics, or traceability. Its implementation is complete and its boundary still excludes quota-behavior changes unless explicitly requested.
- Read `design/INVOICE_ITEMS_PLAN.md` before touching invoice line items. It is implemented (schema, parser, repository, sync integration, backfill, API, expandable-row UI) and derives items from the already-stored `invoices.raw_xml`, making no new KSeF calls.
- Read `design/SALES_INVOICES_PLAN.md` before touching invoice direction, subject types, or anything that reads or aggregates invoices. Sales invoices (`Subject1`) are in scope as of 2026-08-23; Stage 0 is complete and the remaining stages are not yet implemented.
- Read `design/SCHEMA_TYPES_PLAN.md` before changing a column type, writing a migration, or touching a temporal value. Phases 1–3 are implemented: every instant column is now `INTEGER` epoch milliseconds and civil dates remain `TEXT`. Its §8 records what the plan got wrong, including a cascade-delete hazard that will bite any future migration rebuilding `invoices`.
- Read `.cognitron/contexts/DEPLOYMENT_CONTEXT.md` before touching deployment, Docker, or anything under `deploy/`. It is the self-contained source of truth for how this app is containerised and run; `design/DOCKER_DEPLOYMENT_PLAN.md` holds the original design rationale and `docs/DEPLOYMENT.md` is the operator guide. Both tenant stacks are deployed to `linuc` and seeded with real data; `linuc` is now the authoritative instance.
- Read `README.md` for local setup and runtime commands.
- Phases 0–7 are implemented. Phase 8 (manual entry) is next. Phase 9 is deferred and must not be started without an explicit request.

## Project shape

- pnpm workspace with a backend at the repository root and a React/Vite frontend in `web/`.
- Backend: TypeScript, Fastify, SQLite, Drizzle ORM, Zod, Vitest.
- Frontend: React 19, Vite, Testing Library, Vitest.
- KSeF integration uses the pinned community `ksef-client` SDK; prefer its workflows over reimplementing authentication, export polling, decryption, or package handling.
- `src/api/server.ts` is dependency-injected so API tests use `fastify.inject()` without sockets or KSeF network calls.
- Database repository modules are thin persistence wrappers. Business behavior belongs in domain modules such as `src/sync.ts` and `src/categorization/`.

## Runtime and validation

- Use the Node version in `.nvmrc` (24.16.0; minimum supported version is 24). Node 24 is the
  only version both native addons — `better-sqlite3` and the transitive, optional `libxmljs2` —
  have bindings for here, so do not run the backend under an older Node.
- Backend tests: `pnpm test`.
- Frontend tests: `pnpm --dir web test`.
- Backend typecheck: `pnpm run typecheck`.
- Frontend typecheck: `pnpm --dir web run typecheck`.
- Lint both packages: `pnpm run lint`.
- **Testing is mandatory, not optional.** Every feature, fix, or behavior change must include automated tests. Work is not done and must not be reported as complete until those tests exist and have actually passed.
- Run the focused test immediately after the first substantive edit, then run the relevant package suite and typecheck before claiming completion. Run broader validation when shared behavior or cross-package contracts change.
- Unit tests must never make real KSeF network calls. Inject or mock KSeF interactions.
- Do not fix unrelated failures or refactor unrelated code. Report unrelated problems separately.

## Product invariants

- The application imports purchase invoices (`Subject2`) and sales invoices (`Subject1`), and uses `PermanentStorage` for incremental synchronization. Each sync call covers exactly one direction and keeps its own continuation point.
- Sales invoices are stored for revenue reporting only. They are never categorized: they carry `category_id = NULL` and `categorization_confidence = "not_applicable"`, and must never reach the correction path — on a sales invoice the seller is the tenant itself, so one rule would match every sales invoice ever issued.
- KSeF access is read-only. Never add invoice-issuing permissions or log KSeF tokens, JWTs, or other secrets.
- `syncPurchaseInvoices` intentionally defaults to `maxIterations: 1`. Do not remove this limit casually: the export-init endpoint is capped at 16 requests/minute and 20/hour, and the SDK default of 20 caused a real production rate-limit incident.
- A sync persists its continuation point and records a `sync_runs` audit row. Preserve import traceability on both success and failure.
- Import lifecycle logs use stable `sync.*` events correlated by `syncRunId`; durable history stores timings, continuation movement, counts, and safe error metadata. Never log raw SDK response bodies or invoice XML.
- KSeF invoices are deduplicated by KSeF number. Re-syncing must not overwrite a human-assigned category.
- Categorization checks exact seller NIP before case-insensitive seller-name rules. Human corrections update/create the seller rule for future invoices.
- Manual entries share the invoices table with `source = "manual"`. Phase 8 requires the user to choose a category directly, stores confidence as `matched`, and must not create a seller rule.
- The post-login default screen is invoice browsing; Import is secondary. JWTs remain in React memory only, so browser refresh requires login again.

## Current Phase 8 boundary

- Already present: invoice schema support for `source = "manual"` and `insertManualInvoice` in `src/db/invoices.ts`.
- Still required: manual-entry domain service, strict input validation, `POST /invoices/manual`, API tests, API client method, form and third navigation item, component/App integration tests, and a running-app smoke check.
- Reuse existing persistence and category APIs. Do not introduce a router or browser E2E dependency solely for this phase.

## Repository hygiene

- Do not commit `.env`, real invoice exports, SQLite runtime files, KSeF tokens, or JWT secrets.
- Never stage or commit `design/chat.json`. It is a large chat export and may contain secrets.
- Preserve unrelated working-tree changes. Do not modify archived files under `.cognitron/` unless explicitly requested.
- When a phase is completed and fully validated, update its status in `design/IMPLEMENTATION_PLAN.md` with the implementation summary and actual test results. Keep `design/SPEC.md` focused on durable requirements rather than code-level progress.

## Conventions

### Git commit messages
Use [Conventional Commits](https://www.conventionalcommits.org/) for all commit messages:

```
<type>(<optional scope>): <short summary>

<optional body>

<optional footer(s)>
```

- `type` must be one of: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.
- If a commit genuinely spans multiple types, prefer the most impactful type (e.g. `fix` over `test`) and describe both changes in the body. Ideally, split such work into separate commits.
- Use the imperative mood in the summary (e.g. "add", not "added"/"adds").
- Keep the summary line concise (~72 chars max) and all lowercase, including proper nouns and acronyms (e.g. `fix jwt token expiry`, not `fix JWT token expiry`); no trailing period.
- Add a `!` after the type/scope (e.g. `feat!:`) or a `BREAKING CHANGE:` footer for breaking changes.
- Reference issues/PRs in the footer when relevant (e.g. `Refs #12`).

### Dates and times

Three distinct kinds. Never conflate them — the schema cannot currently tell them apart, which is why this rule exists.

- **Civil date** — a calendar day, no time, no zone (`issue_date`, `delivery_date`, `window_from`, `window_to`). Store as `TEXT` `YYYY-MM-DD`. Never convert one to an instant: that invents a timezone and yields an off-by-one day at every offset boundary.
- **Instant** — a specific moment (`created_at`, `items_extracted_at`, `requested_at`, `started_at`, `completed_at`). Stored as `INTEGER` epoch **milliseconds** via Drizzle `integer({ mode: "timestamp_ms" })`, written by the application (`$defaultFn(() => new Date())`), never by a SQL default.
- **Opaque KSeF token** — `continuation_point` and its `sync_runs` audit copies. It looks like a timestamp, but its contract is byte-identical round-trip to KSeF, including microseconds and explicit offset. Persist it verbatim.

Rules that follow from this:

- Never compare temporal values lexicographically. ISO-8601 string order is not chronological once offsets differ (`+02:00` sorts above `+00:00` yet is two hours earlier), and an instant always sorts above a bare date sharing its prefix. Parse to epoch ms and compare numerically.
- `windowFrom`/`windowTo` are **inclusive civil dates**. Compare an instant against the exclusive start of the day after `windowTo`, never against `windowTo` itself.
- Do not let one column be written by both a SQL `current_timestamp` default (UTC, `YYYY-MM-DD HH:MM:SS`) and `new Date().toISOString()` (`...T...Z`). Prefer a single application-side write path: JavaScript parses the space-separated form as **local** time, a silent offset bug.
- Convert or backfill legacy timestamps in SQL, never in TypeScript. SQLite reads the space-separated form as UTC (correct); JavaScript reads it as local (wrong).
- Disable foreign keys around migrations, outside the transaction. SQLite emulates `ALTER TABLE` by dropping and recreating, and a `DROP TABLE` with enforcement on fires `ON DELETE CASCADE` — rebuilding `invoices` silently empties `invoice_items`. `createDb` handles this; do not remove it. The `PRAGMA foreign_keys=OFF` drizzle-kit writes into the migration file is a no-op inside the migrator's transaction.
- Trial any destructive migration on a `cp` of the database first, and compare row counts and sums before touching the real file.
- There is more than one live database. `.env` is a symlink to a per-tenant env file and `DATABASE_PATH` differs between them; back up every tenant database, not just the default.
- Validate temporal request fields for actual format and calendar validity, not just `z.string().min(1)`.

<!--
Add future conventions below as their own subsections, e.g.:
### Branch naming
### PR titles
-->
