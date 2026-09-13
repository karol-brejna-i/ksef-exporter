# KSeF Exporter

**Last updated:** 2026-09-06 13:58 CEST

Self-hosted app that pulls purchase invoices from KSeF, categorizes them, and supports manual
correction. See [`design/SPEC.md`](./design/SPEC.md) for the business context and
[`design/IMPLEMENTATION_PLAN.md`](./design/IMPLEMENTATION_PLAN.md) for the build plan/status.

This is a two-part app:

- **API** (repo root, `src/`) — Node.js/TypeScript/Fastify. Talks to KSeF, persists data in
  SQLite, and exposes the engine over HTTP.
- **Web UI** (`web/`) — Vite + React + TypeScript. Talks only to the API.

## Prerequisites

- Node.js ≥ 24 (use the version in `.nvmrc`, currently 24.16.0)
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

If outbound traffic requires a proxy, set the standard uppercase `HTTPS_PROXY` (preferred for
KSeF HTTPS traffic) or `HTTP_PROXY` variable. `ksef-client` also honors uppercase `NO_PROXY`.
The pinned SDK does not read lowercase `https_proxy`, `http_proxy`, or `no_proxy`; the API logs a
startup warning when it detects a lowercase-only proxy configuration.

### Selecting an env file (modes)

Env loading mirrors the `web/` Vite app. On every run the backend loads a shared base `.env`,
then layers a mode-specific file on top. Precedence, lowest to highest:

| #   | Source                     |
| --- | -------------------------- |
| 1   | `.env`                     |
| 2   | `.env.local`               |
| 3   | `.env.<mode>`              |
| 4   | `.env.<mode>.local`        |
| 5   | the real shell environment |

The mode comes from the `APP_ENV` variable — the analogue of Vite's `--mode`, since there is no
CLI flag here — and defaults to `development`. Keep shared settings in `.env` and put
per-target overrides (typically `DATABASE_PATH`, `KSEF_NIP`, `KSEF_TOKEN`) in `.env.<mode>`:

```sh
APP_ENV=parkowa pnpm run dev:api      # loads .env, then .env.parkowa
APP_ENV=portowa pnpm run start:api    # loads .env, then .env.portowa
pnpm run dev:api                      # mode "development": .env (+ .env.development if present)
```

The same applies to the KSeF CLI helpers that read config — `smoke:ksef`, `smoke:invoices`,
`dump:invoices`, `backfill:invoices`:

```sh
APP_ENV=portowa pnpm run smoke:invoices
```

`APP_ENV` also selects the mode file for `pnpm run dev:web`, so the API and the web dev server
can be started as a matched pair — see [Run the web UI](#4-run-the-web-ui).

The backend loader does not expand `${OTHER_VAR}` references. The `web/` Vite app reads these
same repo-root files (via `envDir`) and *does* expand them. All `.env*` files are git-ignored.

## 3. Run the API

```sh
pnpm run dev:api      # watches for changes (tsx watch)
# or
pnpm run start:api    # runs once, no watch
```

The API listens on `http://localhost:$PORT` (default `3000`). It loads `.env` automatically, plus
any `.env.<APP_ENV>` overrides — see [Selecting an env file (modes)](#selecting-an-env-file-modes).

Useful checks once it's running:

```sh
curl -X POST http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"<AUTH_USERNAME>","password":"<AUTH_PASSWORD>"}'
```

## 4. Run the web UI

In a separate terminal, from the repo root:

```sh
pnpm run dev:web      # = pnpm --dir web run dev
```

Run the API and the web dev server as a tenant-matched pair — one per terminal, same `APP_ENV`
on both so the web proxy resolves against the same `.env.<mode>` file the API loaded:

```sh
APP_ENV=parkowa pnpm run dev:api      # API: .env, then .env.parkowa
APP_ENV=parkowa pnpm run dev:web      # web: proxy target from the same files

pnpm run dev:api                      # default mode: .env only
pnpm run dev:web
```

Open the printed URL (default `http://localhost:5173`). The dev server proxies `/api/*` requests
to the API, so make sure the API is running first. Log in with the `AUTH_USERNAME`/`AUTH_PASSWORD`
from your `.env`.

`web/vite.config.ts` reads the same repo-root `.env*` files as the backend (it points Vite's
`envDir` at the repo root), so the proxy target follows `PORT` with no extra configuration.
Override either side from those files:

| Variable           | Effect                                                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `API_PROXY_TARGET` | Where `/api/*` is proxied. Defaults to `http://localhost:${PORT}`. `${VAR}` references are expanded, and a full URL lets you point at an API on another host. |
| `WEB_DEV_PORT`     | Port the Vite dev server listens on (default `5173`). Change `WEB_ORIGIN` to match so the API's CORS allow-list still accepts it.                             |

`APP_ENV` picks the tenant/mode file for the proxy resolution, exactly as it does for the API;
without it the web server reads `.env` only. Vite's own `--mode` flag is separate and still
governs `VITE_`-prefixed vars and production builds.

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

For running this app as per-tenant Docker Compose stacks instead, see
[`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md).

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
- `pnpm run export:invoices` — exports invoices and their line items to a two-sheet `.xlsx`
  workbook (`data/invoices-export.xlsx` by default). Takes a positional database path (or
  `APP_ENV`/`DATABASE_PATH`, like `dev:api`), `--from`/`--to` (issue-date range), and `--out`.
  Makes no KSeF calls; reads only from the local SQLite database. See
  [`excel-export-script.readme.md`](./docs/excel-export-script.readme.md) for full usage.
- `pnpm run migrate` / `pnpm run db:generate` — Drizzle migrations.
