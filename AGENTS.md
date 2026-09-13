# AGENTS.md

Subagent infrastructure for this repo, so future sessions run faster and cheaper by
delegating work that doesn't belong in the main context. Agents live under
`.claude/agents/` as individual `<name>.md` files with `name`/`description`/`tools`/
`model` frontmatter. None of them run automatically — every one is dispatched on demand
by the primary agent (you), never scheduled or triggered by a hook.

No agent below owns `deploy/` or Docker deployment work; for that context, read
`design/DEPLOYMENT_CONTEXT.md` instead.

## Index

| Agent                      | Model  | Reach for it when                                                                                                                                                                                                                                                                                                                                 |
| -------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runner`                   | haiku  | You need to run one or more of `build`/`lint`/`typecheck`/`test` and only care about pass/fail plus a short error excerpt, not the full log.                                                                                                                                                                                                      |
| `db-inspector`             | haiku  | You have an open-ended, multi-query question about the live tenant SQLite databases (schema shape, an XML field's real distribution, whether some identity holds) and would otherwise iterate several ad-hoc queries inline. Dispatch it twice in parallel, once per tenant, when the same question needs answering for both parkowa and portowa. |
| `lockfile-guard`           | haiku  | You want a quick, mechanical confirmation that `pnpm-lock.yaml` still agrees with both `package.json` files and that no stray `yarn.lock`/`package-lock.json` has appeared.                                                                                                                                                                       |
| `migration-reviewer`       | sonnet | A drizzle-kit-generated migration involves a table rebuild or a column type change, before it's applied to a real tenant database.                                                                                                                                                                                                                |
| `sync-rate-limit-reviewer` | sonnet | A diff touches `src/sync.ts`, KSeF export/client calls, or continuation-point logic, before it merges.                                                                                                                                                                                                                                            |
| `failure-diagnoser`        | sonnet | A `runner` (or any) command failed and you want the root cause diagnosed from the excerpt/source before deciding how to fix it.                                                                                                                                                                                                                   |

## How to use these

- **Delegate mechanical checks to `runner` instead of running them inline.** A raw
  `pnpm test`/`pnpm run typecheck` invocation in the main context pastes its full output
  into your history whether it passes or not; `runner` returns one line on success and a
  handful on failure. Use it for routine validation passes; still run the full suite
  yourself (not through a subagent) at a milestone boundary where you need to be certain
  about the result before reporting completion.
- **Dispatch independent checks together.** If a change could plausibly break the
  backend build, the frontend build, and lint, ask for all three `runner` invocations in
  a single message rather than one at a time — they're independent and run concurrently.
- **Prefer `db-inspector` over manually poking the live databases for open-ended,
  multi-lookup exploration.** Anything that looks like "how many invoices have X, does
  identity Y hold, what values does Z take" is a good fit — it keeps the query iteration
  and any incidentally-touched real data out of the main conversation, returning only a
  compact summary.
- **For a tenant-symmetric question, dispatch `db-inspector` twice in one message, not
  once for both databases.** If the same measurement is needed for parkowa and portowa
  (e.g. "does this arithmetic identity hold" or "what's the distribution of field X"),
  give each invocation a prompt scoped to exactly one tenant's database file. They run
  concurrently and each returns a smaller, focused summary. This is `db-inspector`'s job
  specifically because it has real `Bash`/`node:sqlite` execution access — general-purpose
  read-only exploration agents (e.g. `Explore`) do not, and will only draft a script for
  the user to run instead of actually running it.
- **Never delegate, and never run automatically, anything on this list** — these have
  real side effects (KSeF network calls under a tight rate limit, writes to a live
  database, a running server bound to a port, or history changes) and need the user's
  explicit confirmation every time, run directly by the primary agent:
  - `pnpm run migrate`, `pnpm run db:generate`
  - `pnpm run smoke:ksef`, `pnpm run smoke:invoices`, `pnpm run dump:invoices`
  - `pnpm run backfill:items` (without `--dry-run`)
  - `pnpm run backfill:invoice-kind` (without `--dry-run`)
  - `pnpm run dev:api`, `pnpm run start:api`
  - any `git push`, `git commit --amend`, `git reset --hard`, or destructive migration
    applied directly to `data/*.sqlite`/`data/tenants/*/*.sqlite`

## Maintaining this file

Every agent's `tools` field is least-privilege for its job (e.g. review-only agents get
`Read, Grep, Glob` with no `Bash`/`Edit`; agents with real `Bash` access are told
explicitly in their own body that the access is read-only). Keep new agents to that same
standard, and re-derive this index (one row per agent, tier, and reach-for-it condition)
whenever an agent is added, renamed, or removed.
