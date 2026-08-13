# CLAUDE.md

This repository keeps its shared agent context in one place and imports it here, so
nothing below repeats it:

@.github/copilot-instructions.md

That file's "Start here", project shape, validation commands, product invariants,
repository hygiene, and commit conventions all apply to Claude Code exactly as written.
**Durable, tool-agnostic rules belong there, not here.** This file holds only what is
specific to running Claude Code in this repo.

## Commit messages

The shared Conventional Commits rules apply in full. In addition:

- End every commit message with a trailer crediting the model that did the work, e.g.
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`. List several when several models contributed, most-substantial first.
- The all-lowercase summary rule includes acronyms and overrides the default habit of
  capitalising them: `fix jwt token expiry`, not `fix JWT token expiry`.
- Commit, amend, or push only when asked. Check `git branch -r --contains HEAD` before
  amending — if it is non-empty the commit is already published and must not be rewritten.

## Local environment quirks

- `.nvmrc` pins **24.16.0**, which is also this machine's default `node`, so an agent shell
  and the user's interactive shell now agree and no `PATH` prefix is needed. The repo was on
  22.23.1 until 2026-08-13; if you find a shell on 22, that is the stale side, not this one.
- `better-sqlite3` ships a **single-ABI** native binding, so it serves exactly one Node
  version at a time. If the first `createDb()` call throws `ERR_DLOPEN_FAILED …
  NODE_MODULE_VERSION`, read the two numbers as ABIs, not versions: Node 24 is **137** and
  Node 22 is **127**, so "requires 137" means the binding was built by a Node 22 shell. Fix
  it with `pnpm rebuild better-sqlite3` under 24. This is an environment problem, never a
  code regression — do not change test or source code in response to it.
- `require("better-sqlite3")` alone does **not** load the addon; it is `dlopen`ed lazily on
  the first `new Database()`. A bare require therefore "passes" against a mismatched
  binding — always instantiate when probing which ABI is installed.
- `libxmljs2` (a transitive, optional `ksef-client` dependency) is a second native addon and
  ships prebuilds for Node 24 only. It is loaded lazily via `await import()` behind
  `validateFa3XmlXsd` — FA(3) issuing-side XSD validation this read-only app never calls —
  so it is inert here, but it is another reason not to drop back to 22.
- Kill any `tsx watch src/api/main.ts` you start. A forgotten one holds port 3000 (the
  next `pnpm run dev:api` dies with `EADDRINUSE`) and keeps the live SQLite file open in
  WAL mode, which also makes `?mode=ro` snapshots unreliable.
- Python: always use the repository `.venv` at the root, invoked explicitly as
  `.venv/bin/python3`. Never fall back to the system `python3`.

## Investigating the live database

`data/ksef-exporter.sqlite` holds real business data and is not committed.

- For analysis, open it **read-only** — `file:data/ksef-exporter.sqlite?mode=ro`,
  `SELECT` only. Never write to it directly.
- Schema changes go through `pnpm run db:generate` into `drizzle/migrations/`, applied by
  `createDb()`. Never hand-edit a generated migration or run ad-hoc DDL against the file.
- Beyond the hygiene rules in the shared file, do not stage `data/` or `lipiec.xlsx`.

## Delegation and verification

- Do the analysis, schema design, migration planning, and document writing directly on
  the strongest available model. Delegate only mechanical work — counting, grepping,
  extraction, boilerplate.
- Subagents may be spawned for implementation work without asking, under the ownership
  discipline in `design/INVOICE_ITEMS_PLAN.md` §10: give each agent exclusive write
  ownership of its files, have agents run only focused tests, and run the full suite,
  typecheck, and lint yourself at each wave boundary. Never let a concurrent agent run
  `pnpm run db:generate` or write to `data/ksef-exporter.sqlite`.
- Still ask before running a Workflow. Workflows can spawn dozens of agents; a handful of
  Agent calls against a known file-ownership map is a different cost class.
- Re-derive any figure that came from a subagent before it ships in a document. In
  `design/INVOICE_ITEMS_PLAN.md` six such numbers survived a first pass and were wrong.

## Tooling

- Prefer Read/Edit/Grep/Glob over shell `cat`/`sed`/`grep`. Reference code as clickable
  `src/sync.ts:42`.
- A formatter re-aligns markdown tables on save, which invalidates a pending `Edit`
  match ("File has been modified since read"). Re-read and re-match instead of retrying.
