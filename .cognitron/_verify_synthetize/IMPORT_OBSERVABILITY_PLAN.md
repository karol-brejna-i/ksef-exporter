# Import Observability Improvement Plan

**Last updated:** 2026-08-10 16:33

**Status:** Implemented and automatically validated. A real KSeF import smoke was deliberately not run to avoid consuming an export-init quota request solely for verification.

**Purpose:** Improve visibility, traceability, and debugging of KSeF imports before investigating or changing quota-handling behavior. This document is both the implementation brief for AI agents and the progress tracker for the owner.

**Related documents:** [`SPEC.md`](./SPEC.md), [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md), and [`.github/copilot-instructions.md`](../.github/copilot-instructions.md).

---

## Boundary

This work instruments the existing import path. It must not alter export-window semantics, continuation logic, retries, pacing, `maxIterations`, or KSeF quota behavior. Findings discovered while adding observability should be recorded under **Follow-up findings**, not fixed as part of this plan unless separately approved.

Existing baseline:

- Fastify/Pino logging is enabled and controlled by `LOG_LEVEL`.
- `POST /sync` records one durable `sync_runs` row with requested window, final status, invoice count, and safe error message.
- `syncPurchaseInvoices` emits coarse fetching, fetched, persisting, and completed messages through an injected logger.
- `syncPurchaseInvoices` intentionally defaults to `maxIterations: 1` after a real production rate-limit incident.
- The `ksef-client` incremental workflow exposes no public per-poll progress/logger hook. Do not claim request-level visibility unless the integration boundary is deliberately changed and tested.

## Success criteria

After this work, one import can be reconstructed using its `syncRunId` from request through completion or failure. Durable history must show what window was requested, how far continuation moved, how much work completed, how long it took, and the safe classification of any failure. Logs and stored diagnostics must never contain credentials, tokens, authorization headers, or raw invoice XML.

Testing is mandatory. Each increment below is complete only when its automated tests exist and pass. No real KSeF network calls are permitted in the test suite.

---

## 1. Correlated structured lifecycle logs

**Status:** [x] Complete

Changes:

- Create the `sync_runs` row before acquiring the KSeF client, as today, and bind its ID to a child logger as `syncRunId`.
- Use stable event names rather than prose-only messages:
  - `sync.started`
  - `sync.client.started` / `sync.client.completed`
  - `sync.fetch.started` / `sync.fetch.completed`
  - `sync.persist.started` / `sync.persist.completed`
  - `sync.completed`
  - `sync.failed`
- Include safe structured fields where applicable: requested window, effective `maxIterations`, duration, invoice counts, `hasMore`, and continuation before/after.
- Keep human-readable messages, but make event names and fields stable enough for tests and log filtering.

Tests:

- [x] Successful imports emit the expected lifecycle events with one shared `syncRunId`.
- [x] Failed imports emit `sync.failed` with the same `syncRunId`.
- [x] Log payloads do not contain configured secrets or raw XML.

Definition of done:

- [x] Focused tests pass.
- [x] Backend test suite and typecheck pass.

## 2. Durable import diagnostics

**Status:** [x] Complete

Extend `sync_runs` through a Drizzle migration and repository changes with:

- `started_at` and `completed_at`
- `duration_ms`
- `continuation_before` and `continuation_after`
- `fetched_count`, `inserted_count`, and `duplicate_count`
- `categorized_count` and `needs_review_count`
- `has_more`
- `max_iterations`
- `error_type`, `error_code`, `http_status`, and `retry_after`

Implementation notes:

- Keep fields nullable when a run fails before that stage.
- Preserve existing rows and API compatibility through the migration.
- Define count semantics once in repository/domain types. `fetched` means returned by the KSeF workflow; `inserted` means newly created locally; `duplicate` means already present locally.
- Use UTC ISO timestamps at the API boundary and integer milliseconds for durations.

Tests:

- [x] Migration applies to a fresh database and a database containing old `sync_runs` rows.
- [x] Successful run diagnostics round-trip through the repository.
- [x] Failures retain all diagnostics available at the API boundary; stage events retain finer progress in logs.
- [x] Count semantics distinguish inserted invoices from existing duplicates.

Definition of done:

- [x] Focused repository/domain tests pass.
- [x] Backend test suite and typecheck pass.

## 3. Safe error classification

**Status:** [x] Complete

Changes:

- Add one error-classification function returning structured safe diagnostics separately from the user-facing error message.
- Capture SDK error class, HTTP status, KSeF error code when exposed, and parsed `Retry-After`/retry deadline.
- Preserve a sanitized cause chain in server logs only; persist only bounded, safe diagnostic fields.
- Use the same classifier for the API response mapping, durable run update, and structured log event so they cannot disagree.
- Add explicit redaction for common secret-bearing keys such as `authorization`, `token`, `accessToken`, `refreshToken`, `KSEF_TOKEN`, and `JWT_SECRET`.

Tests:

- [x] Rate-limit errors retain status and retry information.
- [x] Unexpected errors remain generic in API responses but identifiable in server logs.
- [x] Nested secret-bearing error metadata is excluded, and secret-like message content is redacted.
- [x] Persisted messages are bounded; structured fields come from bounded SDK properties.

Definition of done:

- [x] Focused error tests pass.
- [x] Backend test suite and typecheck pass.

## 4. Import diagnostics UI

**Status:** [x] Complete

Changes:

- Extend `GET /sync/runs` and frontend types with the new safe diagnostic fields.
- Make each Recent Imports entry expandable or link it to an inline detail region.
- Show run ID, requested window, status, timestamps, duration, continuation movement, counts, `hasMore`, and safe error/retry information.
- Keep the default list compact; diagnostics should aid investigation without displacing the primary Import action.

Tests:

- [x] API response includes safe diagnostic fields and still requires authentication.
- [x] Success, running, and failure details render correctly.
- [x] Missing fields from early failures render without misleading zero values.
- [x] Retry information is visible when present.

Definition of done:

- [x] Focused frontend tests pass.
- [x] Frontend suite, typecheck, and production build pass.

## 5. Startup context and operator guidance

**Status:** [x] Complete

Changes:

- Emit one sanitized startup event containing application version, `ksef-client` version, KSeF environment, database path, and effective log level.
- Document how to filter logs by `syncRunId` and where durable import diagnostics appear in the UI.
- Document the deployment requirement that stdout logs need an external retention mechanism; durable `sync_runs` diagnostics remain available without retained console logs.
- Add a manual smoke checklist for one successful import and one safely simulated failure in TEST/DEMO where practical.

Tests:

- [x] Startup context excludes NIP and secrets.
- [x] Configuration produces the expected safe fields and resolves versions from both source and compiled layouts.

Definition of done:

- [x] Documentation and automated checks pass.
- [x] Manual smoke decision is recorded below.

---

## Final validation checklist

- [x] All 125 backend tests pass.
- [x] All 30 frontend tests pass.
- [x] Backend and frontend typechecks pass.
- [x] Biome passes for tracked source files.
- [x] Backend and frontend production builds pass.
- [x] No real KSeF call occurs in automated tests.
- [x] Existing `maxIterations: 1`, continuation, retry, and quota behavior is unchanged.
- [x] Logs and persisted diagnostics contain no secrets or raw XML.
- [x] `design/IMPLEMENTATION_PLAN.md` and `.github/copilot-instructions.md` reflect the durable status and invariants.

## Manual smoke record

2026-08-10 16:33: automated Fastify injection covered complete successful and failed lifecycles, including shared `syncRunId`, durable rows, safe 429 diagnostics, and API responses. Fresh and legacy-database migrations were verified; the legacy test preserves an existing `sync_runs` row through migration. No real KSeF import was triggered because doing so would consume the quota whose behavior is intentionally outside this workstream. The next owner-triggered TEST/DEMO or PRD import should be inspected in Recent Imports and, where stdout is retained, filtered by its returned `syncRunId`.

## Follow-up findings

Record suspected quota, continuation, SDK, or import correctness problems here without fixing them under this observability scope.

- None recorded yet.
