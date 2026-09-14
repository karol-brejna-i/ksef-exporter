# Docker Deployment Plan

*Created: 2026-09-13 19:07 CEST · Updated: 2026-09-14 10:37 CEST*

Implementation design for containerising KSeF Exporter and running it on the home
infrastructure, reachable over the internet with TLS. This document is the design to agree
on; the developer guide (`docs/DEPLOYMENT.md`) and the agent context document
(`.cognitron/contexts/DEPLOYMENT_CONTEXT.md`) are written during implementation so they describe what
actually exists rather than what was planned.

## 1. Goal and scope

Run both tenants (`parkowa`, `portowa`) as long-lived Docker stacks on `linuc`, each
reachable at its own HTTPS subdomain through the existing nginx edge on `durga`, with the
SQLite database on a persistent volume, backups, and a repeatable update path.

In scope: images, compose stacks, per-tenant configuration and secrets, edge integration,
data seeding/backup/restore, one-off maintenance tasks, operator and agent documentation.

Out of scope, deliberately:

- **No scheduled sync.** The KSeF export-init endpoint is capped at 16 requests/minute and
  20/hour, and `syncPurchaseInvoices` defaults to `maxIterations: 1` because the SDK
  default caused a real rate-limit incident. Sync stays user-triggered from the UI. Nothing
  in this deployment may add a cron or boot-time sync.
- No CI/CD pipeline, no registry, no orchestrator beyond Compose, no horizontal scaling
  (SQLite allows exactly one writer process per file).
- No changes to KSeF permissions or sync behaviour.

## 2. Decisions

| #   | Decision                                                                                                    | Rationale                                                                                                                                                                                   |
| --- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Compose stacks on `linuc` (192.168.0.102); TLS terminated by nginx on `durga`; plain HTTP over the LAN      | Reuses the working CaterScan topology, certbot, and NAT forwarding already on `durga`                                                                                                       |
| D2  | Two containers per tenant: `api` (Fastify, unpublished) + `web` (nginx serving `web/dist`, proxying `/api`) | `web/src/api/client.ts` hardcodes the same-origin `/api` prefix, so the SPA needs a same-origin proxy. nginx does that natively, keeps the API off the network, and needs no backend change |
| D3  | One isolated stack per tenant, own subdomain, own volume, own secrets                                       | Tenants already have separate KSeF tokens, credentials, JWT secrets, and databases; sharing any of them would be a regression                                                               |
| D4  | Images built on the target host from a git checkout                                                         | `better-sqlite3` is a single-ABI native addon; a native amd64 build on the host avoids cross-arch and ABI trouble entirely                                                                  |
| D5  | One multi-stage `Dockerfile` with two targets (`api`, `web`)                                                | Both images need the same `pnpm install`; a single builder stage shares that layer and its cache                                                                                            |
| D6  | Non-secret config committed per tenant; secrets in git-ignored files, injected as env vars                  | Real environment variables win over `.env*` files in `src/config/load-env.ts`, so no env file is ever baked into an image                                                                   |
| D7  | Production runs compiled JavaScript (`node dist/api/main.js`), not `tsx`                                    | `tsx` is a devDependency; `tsc` already emits `dist/tools/*.js`, so maintenance tasks work without it                                                                                       |

## 3. Target architecture

```
                    Browser (HTTPS)
                          │
                 durga :443  nginx + Let's Encrypt
                          │  (plain HTTP over LAN)
        ┌─────────────────┴──────────────────┐
        │                                    │
 parkowa.zagwozdki.ovh              portowa.zagwozdki.ovh
        ▼                                    ▼
 linuc 192.168.0.102:8081            linuc 192.168.0.102:8082
 ┌──────────────────────────┐        ┌──────────────────────────┐
 │ project ksef-parkowa     │        │ project ksef-portowa     │
 │                          │        │                          │
 │  web  (nginx:alpine)     │        │  web  (nginx:alpine)     │
 │   ├── /api/* ─► api:3000 │        │   ├── /api/* ─► api:3000 │
 │   └── /*     ─► web/dist │        │   └── /*     ─► web/dist │
 │                          │        │                          │
 │  api  (node:24-slim)     │        │  api  (node:24-slim)     │
 │   └── /data ─► volume    │        │   └── /data ─► volume    │
 │        ksef-parkowa_data │        │        ksef-portowa_data │
 │   └── /backups ─► bind   │        │   └── /backups ─► bind   │
 └──────────────────────────┘        └──────────────────────────┘
            │                                    │
            └──────────► api.ksef.mf.gov.pl (outbound HTTPS only)
```

Port allocation on `linuc`, chosen to avoid the CaterScan range (3001–3002, 5173–5176):

| Port | Bound to             | Service                            |
| ---- | -------------------- | ---------------------------------- |
| 8081 | 192.168.0.102        | `ksef-parkowa` web                 |
| 8082 | 192.168.0.102        | `ksef-portowa` web                 |
| —    | compose network only | both `api` containers (`api:3000`) |

The API port is never published. Publishing it would also bypass `ufw`, which does not
filter Docker's own DNAT rules; binding the web port to the LAN IP rather than `0.0.0.0`
limits reach to the LAN, and only `durga` is meant to talk to it.

## 4. Repository layout

Everything deployment-related lives under `deploy/`, so nothing in `src/` or `web/` needs
to know it is containerised.

```
deploy/
  README.md                      # one screen: what is here, pointers to the two docs
  docker-compose.yml             # single parameterised stack definition
  ksef-stack.sh                  # tenant-aware wrapper around `docker compose`
  docker/
    Dockerfile                   # multi-stage, targets: api, web
    nginx/app.conf.template      # in-container SPA + /api proxy vhost
  env/
    parkowa.stack.env            # committed, non-secret
    portowa.stack.env            # committed, non-secret
    parkowa.secrets.env.example  # committed template
    portowa.secrets.env.example  # committed template
    <tenant>.secrets.env         # git-ignored, created on the host
  nginx/
    ksef-tenant.conf.template    # durga vhost template (pre-certbot)
  scripts/
    backup.sh                    # snapshot + retention, for cron
    restore.sh                   # restore a snapshot into a volume
    smoke.sh                     # post-deploy health/login/invoices check
.dockerignore                    # new, at repo root
docs/DEPLOYMENT.md               # operator/developer guide (written in wave 3)
.cognitron/contexts/DEPLOYMENT_CONTEXT.md  # agent source of truth (written in wave 3)
```

`.gitignore` currently ignores `*.env`, which would swallow the committed
`<tenant>.stack.env` files; the implementation adds `!deploy/env/*.stack.env`. The
`.secrets.env` files stay ignored by the existing pattern, and `*.secrets.env.example` is
not matched by it.

## 5. Image design

One `deploy/docker/Dockerfile`, build context = repo root.

**`build` stage** — `node:24.16.0-bookworm-slim`, `corepack enable` (pnpm 11.10.0 comes
from `packageManager`), plus `python3 make g++` so `better-sqlite3` can compile from source
when no prebuild matches. Copies manifests and the lockfile first, runs
`pnpm install --frozen-lockfile` for the whole workspace, then copies `src/`, `drizzle/`,
`tsconfig.json`, and `web/`, and runs `pnpm run build` (tsc → `dist/`) and
`pnpm --dir web run build` (→ `web/dist/`). A BuildKit cache mount on the pnpm store keeps
rebuilds cheap. Finally it produces a production-only `node_modules` for the runtime stage;
`pnpm install --frozen-lockfile --prod --filter ksef-exporter` is the intended form, with
`pnpm prune --prod` as the fallback if workspace filtering misbehaves — whichever is used
must be verified to leave a working `better-sqlite3` binding, since the prune step can
trigger a rebuild.

**`api` stage** — same `node:24.16.0-bookworm-slim` base (identical glibc, so the native
binding built in the builder stays valid). Copies `node_modules`, `dist`, `drizzle`, and
`package.json` into `/app`; creates `/data` and `/backups` owned by the `node` user; runs
as `node`. `CMD ["node", "dist/api/main.js"]`.

Two layout constraints that must not be broken:

- `src/db/client.ts` resolves migrations as `../../drizzle/migrations` relative to its own
  module URL. From `/app/dist/db/client.js` that is `/app/drizzle/migrations`, so `drizzle/`
  must sit next to `dist/` at the image root. Migrations therefore apply automatically on
  every boot, with foreign keys disabled around them, exactly as locally.
- `libxmljs2` is a transitive optional dependency with Node 24 prebuilds, loaded lazily
  behind issuing-side XSD validation this read-only app never calls. It must remain
  optional — an install failure for it may not fail the build.

Baked defaults: `NODE_ENV=production`, `DATABASE_PATH=/data/ksef-exporter.sqlite`,
`PORT=3000`, `TZ=Europe/Warsaw`. `TZ` is set for log readability only; stored instants are
epoch milliseconds and civil dates are KSeF strings, so it changes no persisted value.

Healthcheck: `GET /health` on 127.0.0.1:3000 via `node -e` (no curl in the slim image),
`interval 30s, timeout 5s, retries 5, start-period 20s`. This requires the new `/health`
route in §7; until it exists, a TCP connect to port 3000 is the fallback.

**`web` stage** — `nginx:1.29-alpine`, `web/dist` copied to `/usr/share/nginx/html`, and
`app.conf.template` into `/etc/nginx/templates/` so the official entrypoint substitutes
`${API_UPSTREAM}` at container start. nginx's own variables are written `$name` without
braces, so envsubst leaves them alone.

`app.conf.template` responsibilities:

- `location /api/ { proxy_pass http://api:3000/; }` — the trailing slash strips the `/api`
  prefix, mirroring the Vite dev proxy's rewrite, so `/api/auth/login` reaches `/auth/login`.
- `proxy_read_timeout 300s` on `/api/` — `POST /sync` polls a KSeF export and
  `GET /invoices/export` builds a workbook; both can outlast the 60s default.
- `location / { try_files $uri $uri/ /index.html; }` for the SPA.
- Immutable, long-lived caching for `/assets/` (Vite hashes those filenames);
  `no-store` for `index.html`.
- gzip on text types; `client_max_body_size 1m` (the app uploads nothing).

**`.dockerignore`** excludes `node_modules`, `dist`, `web/dist`, `web/node_modules`,
`data/`, `.env*`, `*.env`, `.git`, `.venv`, `.pnpm-store`, `.secrets`, `.cognitron`,
`design`, `docs`, `scratch`, `coverage`, `*.log`, `*.xlsx`. This is also the primary
guarantee that no secret and no real invoice data enters an image layer.

## 6. Compose and configuration design

A single `deploy/docker-compose.yml` is parameterised by substitution variables and
instantiated twice, once per tenant, distinguished by `COMPOSE_PROJECT_NAME`. There is no
base/overlay split: the list-merge semantics of `include:`/multiple `-f` files (where
`ports` and `volumes` concatenate instead of overriding) are a documented footgun on the
CaterScan side, and one file with two env files avoids the whole class of problem.

Services, both `restart: unless-stopped` with `logging: json-file, max-size 10m,
max-file 3`:

- `api` — builds target `api`; `env_file: env/${TENANT}.secrets.env`; `environment:` block
  supplies `DATABASE_PATH=/data/ksef-exporter.sqlite`, `PORT=3000`, `WEB_ORIGIN`,
  `KSEF_ENVIRONMENT`, `KSEF_NIP`, `LOG_LEVEL`, `TZ`; volumes `data:/data` and
  `${BACKUP_DIR}:/backups`. No published ports.
- `web` — builds target `web`; `environment: API_UPSTREAM=http://api:3000`;
  `ports: ["${WEB_BIND}:${WEB_PORT}:80"]`; `depends_on: api: {condition: service_healthy}`.

Compose's `environment:` block overrides `env_file` values, which is exactly the split
wanted: operational values live in the committed stack file, secrets live only in the
git-ignored one.

`deploy/env/<tenant>.stack.env` (committed) holds `COMPOSE_PROJECT_NAME=ksef-<tenant>`,
`TENANT`, `KSEF_ENVIRONMENT=PRD`, `WEB_ORIGIN=https://<tenant>.zagwozdki.ovh`,
`WEB_BIND=192.168.0.102`, `WEB_PORT`, `LOG_LEVEL=info`, `TZ=Europe/Warsaw`,
`BACKUP_DIR=/srv/ksef-backups/<tenant>`.

`deploy/env/<tenant>.secrets.env` (git-ignored, created on the host from the committed
`.example`) holds `KSEF_NIP`, `KSEF_TOKEN`, `AUTH_USERNAME`, `AUTH_PASSWORD`, `JWT_SECRET`.
`KSEF_NIP` lives here rather than in the stack file so that no committed file carries tenant
identity; because `environment:` overrides `env_file`, it must not also be listed in the
compose `environment:` block, where an unset value would shadow the real one. A third
committed pair, `local.stack.env` and `local.secrets.env.example`, exists purely for local
smoke testing against a throwaway volume.
`WEB_ORIGIN` must match the public origin so the API's CORS allow-list stays correct even
though the nginx sidecar makes every request same-origin.

`deploy/ksef-stack.sh <tenant> <compose args…>` is the only entry point operators use. It
validates that the tenant's stack and secrets files exist (failing with a readable message
rather than Compose's "variable is not set" warnings), then execs
`docker compose --env-file deploy/env/<tenant>.stack.env -f deploy/docker-compose.yml "$@"`.
Compose reads `COMPOSE_PROJECT_NAME` from that env file, so project, container, volume, and
network names are namespaced without any extra flag.

## 7. Backend changes required

These are the only edits outside `deploy/`, and both need tests per the repo's mandatory
testing rule.

1. **`GET /health` in `src/api/server.ts`** — unauthenticated, no side effects, runs a
   trivial `select 1` so the check fails when the database is unreachable, returns
   `{ status: "ok" }`. Consumed by the container healthcheck, by `depends_on:
   service_healthy`, and by `smoke.sh`. Tested with `fastify.inject()` alongside the
   existing route tests.
2. **Database snapshot tool** — `src/db/backup.ts` exporting
   `backupDatabase(sqlite, destDir, now)`, which runs `VACUUM INTO` a timestamped file
   (`ksef-exporter-YYYYMMDDTHHMMSS.sqlite`, UTC so lexical order is chronological) and then
   prunes all but the newest `keep` snapshots. `VACUUM INTO` is the correct primitive here:
   it produces one consistent file that already includes committed WAL content, unlike a
   naive `cp` of a live WAL database. Thin CLI wrapper `src/tools/backup-db.ts` plus a
   `backup:db` package script, so the same code runs in the container
   (`node dist/tools/backup-db.js`) and on a developer machine
   (`APP_ENV=parkowa pnpm run backup:db`). Unit-tested against a temp-directory database.

## 8. Data lifecycle

**Seeding the first deployment.** The live databases are on the Mac
(`data/tenants/<tenant>/ksef-exporter.sqlite`, 4 MB and 9.6 MB, with non-empty WAL). Stop
the local API first — a running `tsx watch` holds the file open in WAL mode. Then, per
tenant: `APP_ENV=<tenant> pnpm run backup:db --out /tmp` to get a single consistent
snapshot, `scp` it to `linuc`, and copy it into the tenant volume with the stack stopped
(`restore.sh` does exactly this). Never copy the `.sqlite`, `-wal`, and `-shm` files
individually into a volume, and never bind-mount the repo's `data/` directory into a
container.

**Migrations.** Applied by `createDb()` on every API boot, forward-only. Two consequences
to respect: only one container may boot against a given database file at a time (one API
container per tenant, no scaling, no parallel `run` while the stack is up), and a code
rollback across a migration is not automatically safe — take a snapshot before deploying a
release that adds one. `pnpm run db:generate` remains a developer-machine action; generated
SQL is committed and never hand-edited.

**Backups.** `deploy/scripts/backup.sh <tenant>` runs `ksef-stack.sh <tenant> exec -T api
node dist/tools/backup-db.js` writing into `/backups` (bind-mounted from
`/srv/ksef-backups/<tenant>` on the host, so snapshots survive `down -v`), keeping the last
14. Installed as a nightly host cron entry per tenant. Restore is `restore.sh <tenant>
<snapshot>`: stop the stack, replace `/data/ksef-exporter.sqlite` in the volume, delete any
stale `-wal`/`-shm`, start the stack.

**Excel exports** are streamed to the browser by `GET /invoices/export` and need no shared
volume.

## 9. Operations

| Task                 | Command (run on `linuc`, from the checkout)                                              |
| -------------------- | ---------------------------------------------------------------------------------------- |
| First start / update | `git pull && deploy/ksef-stack.sh parkowa up -d --build`                                 |
| Status / logs        | `deploy/ksef-stack.sh parkowa ps` · `… logs -f api`                                      |
| Stop (keep data)     | `deploy/ksef-stack.sh parkowa down`                                                      |
| Post-deploy check    | `deploy/scripts/smoke.sh parkowa`                                                        |
| One-off task         | `deploy/ksef-stack.sh parkowa exec -T api node dist/tools/export-invoices.js`            |
| Manual backup        | `deploy/scripts/backup.sh parkowa`                                                       |
| Rollback             | snapshot, `git checkout <sha>`, `up -d --build`; restore the snapshot if a migration ran |

Every compiled tool under `dist/tools/` is available the same way — backfills, reconcile,
export. `smoke.sh` checks `/health`, logs in with the tenant's credentials, and fetches one
page of invoices; it makes no KSeF call.

Images are labelled with the build's git SHA (`org.opencontainers.image.revision` from a
build arg) so a running container can be traced back to a commit. Rollback is a rebuild
from an older checkout rather than a registry pull, which is the accepted cost of D4.

## 10. Edge integration on `durga`

Nothing on `durga` is touched by this work. The vhost template is committed as source only;
installing it, requesting certificates, and adding DNS records are operator steps, deferred
until the stacks are verified on `linuc`.

`deploy/nginx/ksef-tenant.conf.template` is committed as the source for both vhosts:
`server_name <tenant>.zagwozdki.ovh`, `proxy_pass http://192.168.0.102:<port>`, standard
`X-Forwarded-{For,Proto,Host}` headers, and `proxy_read_timeout 300s` on `/api/` so the
edge does not cut off a sync or an export before the app does. No WebSocket upgrade is
needed. Installation is the existing routine: DNS `A` records for both names →
`194.49.105.105`, copy the rendered file into `/etc/nginx/sites-available/`, symlink,
`nginx -t`, reload, then
`sudo certbot --nginx -d <tenant>.zagwozdki.ovh --non-interactive --agree-tos --redirect`.

Because the app is single-owner with credential login and holds real invoice data, the guide
also documents optional edge hardening (a `deny`/`allow` list or basic-auth in front of the
vhost) as a decision for the operator, not a default.

## 11. Implementation plan

Three waves. Each agent owns its files exclusively and runs only focused checks; the full
suite, typecheck, lint, and the container smoke run at each wave boundary, by me.

**Wave 1 — three parallel agents, no file overlap:**

| Agent       | Owns                                                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------------------- |
| A · images  | `deploy/docker/Dockerfile`, `deploy/docker/nginx/app.conf.template`, `.dockerignore`                                  |
| B · stack   | `deploy/docker-compose.yml`, `deploy/ksef-stack.sh`, `deploy/env/*`, `.gitignore`                                     |
| C · backend | `src/api/server.ts` (+`server.test.ts`), `src/db/backup.ts`, `src/tools/backup-db.ts` (+tests), `package.json` script |

Wave 1 gate: `pnpm test`, `pnpm run typecheck`, `pnpm run lint`, then
`deploy/ksef-stack.sh <scratch-tenant> up -d --build` locally on the Mac against a throwaway
volume, verifying `/health`, login, and an empty `/invoices` — no KSeF traffic. An arm64
build here proves the Dockerfile; the amd64 build on `linuc` is proven on first deploy.

**Wave 2 — two parallel agents:**

| Agent           | Owns                                                                                                                   |
| --------------- | ---------------------------------------------------------------------------------------------------------------------- |
| D · ops scripts | `deploy/scripts/{backup,restore,smoke}.sh`, `deploy/nginx/ksef-tenant.conf.template`                                   |
| E · docs        | `docs/DEPLOYMENT.md`, `deploy/README.md`, pointer lines in `README.md`, `.github/copilot-instructions.md`, `AGENTS.md` |

Wave 2 gate: run `backup.sh` and `restore.sh` end to end against the local scratch stack,
and re-run the full suite plus lint after the doc edits.

**Wave 3 — me, not delegated:** `.cognitron/contexts/DEPLOYMENT_CONTEXT.md`, the self-contained agent
source of truth (infrastructure, hostnames, ports, volume and project names, image
internals, config precedence, data lifecycle, the gotchas in §12, and the operations table),
plus a status entry in `design/IMPLEMENTATION_PLAN.md`. Any figure or path that came from a
subagent is re-derived before it lands in a document.

Deployment itself — DNS, certbot, host directories, cron, seeding the volumes with real
tenant data — is an operator action on `linuc` and `durga`, documented in
`docs/DEPLOYMENT.md` and run by you, not from here.

## 12. Risks and gotchas

1. **Native addon, single ABI.** `better-sqlite3` serves exactly one Node ABI (Node 24 =
   137). Never mount host `node_modules` into a container, never copy `node_modules` between
   architectures, and build on the host that runs it. A `NODE_MODULE_VERSION` mismatch at
   boot is an environment problem, never a code regression.
2. **Docker bypasses `ufw`.** Published ports are reachable from the whole LAN regardless of
   firewall rules; hence the explicit `192.168.0.102:` bind and the unpublished API port.
3. **One writer per database file.** SQLite in WAL mode tolerates many readers and one
   writer, but migrations run on boot. Never run two API containers, or `exec`/`run` a
   migration-triggering tool concurrently, against one volume.
4. **Volumes are local disks.** Do not relocate a tenant volume onto NFS/SMB; SQLite locking
   is unreliable there.
5. **Rate limits are a product invariant.** No scheduled or boot-time sync, no raising
   `maxIterations`, no retry loop around export-init in any deployment glue.
6. **`environment:` beats `env_file`.** Intentional, and the reason a secret must never also
   appear in a stack file — the stack file would win and shadow it.
7. **Restart loop on bad config.** `loadConfig()` fails fast and the process exits non-zero;
   with `restart: unless-stopped` that shows up as a crash-looping container. `logs api`
   prints the aggregated Zod message naming every missing variable.
8. **Secrets and data must stay out of images.** `.dockerignore` covers `.env*`, `data/`,
   and the workbooks; no `COPY . .` anywhere in the Dockerfile.
9. **Tenant isolation.** Separate volumes, separate `JWT_SECRET`s, separate credentials. A
   shared JWT secret would make one tenant's session valid on the other.
10. **Long requests.** Both nginx layers need the raised `proxy_read_timeout`, or a slow sync
    or export surfaces as a 504 while the backend is still working.
