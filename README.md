# KSeF Exporter

**Last updated:** 2026-08-10 16:33

Self-hosted app that pulls purchase invoices from KSeF, categorizes them, and supports manual
correction. See [`design/SPEC.md`](./design/SPEC.md) for the business context and
[`design/IMPLEMENTATION_PLAN.md`](./design/IMPLEMENTATION_PLAN.md) for the build plan/status.

This is a two-part app:

- **API** (repo root, `src/`) — Node.js/TypeScript/Fastify. Talks to KSeF, persists data in
  SQLite, and exposes the engine over HTTP.
- **Web UI** (`web/`) — Vite + React + TypeScript. Talks only to the API.

## Prerequisites

- Node.js ≥ 22.13 (use the version in `.nvmrc`)
- pnpm (pinned via `packageManager` in `package.json`; run `corepack enable` if `pnpm` isn't
  already installed)

## 1. Install dependencies

From the repo root (this installs both the API and the `web/` package, which are a single pnpm
workspace):

```sh
pnpm install
```

## 2. Configure the API

Copy the example env file and fill in real values:

```sh
cp .env.example .env
```

| Variable           | Required                                   | Notes                                                                                                                                     |
| ------------------ | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `KSEF_TOKEN`       | yes                                        | KSeF Token scoped to `InvoiceRead` only. Generate via the official KSeF Taxpayer App / e-Urząd Skarbowy. Secret — never commit or log it. |
| `KSEF_NIP`         | yes                                        | NIP of the company/context to authenticate as.                                                                                            |
| `KSEF_ENVIRONMENT` | no (default `TEST`)                        | One of `TEST`, `DEMO`, `PRD`. Use `TEST` while developing.                                                                                |
| `DATABASE_PATH`    | no (default `./data/ksef-exporter.sqlite`) | SQLite file path; created automatically.                                                                                                  |
| `AUTH_USERNAME`    | yes                                        | Single-owner login username (no user-management system). Secret.                                                                          |
| `AUTH_PASSWORD`    | yes                                        | Single-owner login password, min 8 characters. Secret.                                                                                    |
| `JWT_SECRET`       | yes                                        | Random string, 32+ chars, used to sign session JWTs. Generate with `openssl rand -base64 32`. Secret.                                     |
| `PORT`             | no (default `3000`)                        | Port the API listens on.                                                                                                                  |
| `WEB_ORIGIN`       | no (default `http://localhost:5173`)       | Origin the frontend is served from; allow-listed for CORS.                                                                                |

## 3. Run the API

```sh
pnpm run dev:api      # watches for changes (tsx watch)
# or
pnpm run start:api    # runs once, no watch
```

The API listens on `http://localhost:$PORT` (default `3000`). It reads `.env` automatically.

Useful checks once it's running:

```sh
curl -X POST http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"<AUTH_USERNAME>","password":"<AUTH_PASSWORD>"}'
```

## 4. Run the web UI

In a separate terminal:

```sh
cd web
pnpm run dev
```

Open the printed URL (default `http://localhost:5173`). The dev server proxies `/api/*` requests
to the API at `http://localhost:3000` (see `web/vite.config.ts`), so make sure the API is running
first. Log in with the `AUTH_USERNAME`/`AUTH_PASSWORD` from your `.env`.

The JWT is kept in memory only (not `localStorage`/`sessionStorage`), so refreshing the page
requires logging in again — this is intentional, to limit exposure if the page is ever
compromised by XSS.

## Import diagnostics

Every import receives a durable numeric `syncRunId`. The API returns it from `POST /sync`, and
all structured lifecycle logs for that import include the same field. Events are named
`sync.started`, `sync.client.*`, `sync.fetch.*`, `sync.persist.*`, and either `sync.completed` or
`sync.failed`.

Filter retained JSON logs with a tool such as `jq`:

```sh
jq 'select(.syncRunId == 42)' api.log
```

The Import screen's **Recent imports** table keeps durable diagnostics even when stdout logs are
not retained. Expand **Details** to see timestamps, duration, continuation movement, fetched and
inserted counts, duplicates, categorization counts, and safe error/retry metadata. Console logs
still require external retention in production (for example, systemd journal or container logs).
Neither logs nor durable diagnostics include tokens, raw SDK response bodies, or invoice XML.

## Building for production

```sh
# API: type-check + compile to dist/
pnpm run build

# Web UI: type-check + production bundle to web/dist/
cd web && pnpm run build
```

The production web bundle is a set of static files (`web/dist/`) — serve them with any static
file host, configured to talk to the API's real URL (adjust CORS/`WEB_ORIGIN` accordingly, since
there's no dev-server proxy in production).

## Tests, lint, typecheck

Run from the relevant package directory (repo root for the API, `web/` for the UI):

```sh
pnpm test         # vitest run
pnpm run typecheck
pnpm run lint     # Biome (repo root only; lints both packages)
```

## Manual/one-off scripts (API side)

These are developer tools, not part of the API server itself — see `package.json` for the full
list:

- `pnpm run smoke:ksef` / `pnpm run smoke:invoices` — quick manual checks against a real KSeF
  environment.
- `pnpm run dump:invoices` — dumps raw KSeF invoice data to the gitignored `data/` folder.
- `pnpm run migrate` / `pnpm run db:generate` — Drizzle migrations.
