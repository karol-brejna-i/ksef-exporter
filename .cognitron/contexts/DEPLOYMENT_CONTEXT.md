# Deployment Context

*Created: 2026-09-13 20:06 CEST · Updated: 2026-09-14 10:37 CEST*

Self-contained context for any agent asked to analyse, change, or debug how KSeF Exporter is
deployed. This is the source of truth for Docker and deployment work: read it before touching
anything under `deploy/`, the `Dockerfile`, the compose stack, or the operational scripts.
`design/DOCKER_DEPLOYMENT_PLAN.md` is the original design and rationale;
`docs/DEPLOYMENT.md` is the human operator guide. Where any of the three disagrees with the
code, the code wins — and fix the document.

**Status as of 2026-09-13:** both tenant stacks are implemented, committed, **running on
`linuc`, and seeded with real tenant data** — the `linuc` instance is now the authoritative
one and the developer-machine instance should no longer be used for real work. Access is
LAN-only: the `durga` edge has deliberately not been touched, and exposing the app publicly is
blocked on stronger authentication being implemented first. See §11 for exactly what is and is
not done.

## 1. What is being deployed

A self-hosted, single-owner app that pulls invoices from Poland's KSeF e-invoicing system,
categorises purchases, and exports to Excel. Two parts, one pnpm workspace:

- **API** — repo root, `src/`. TypeScript, Fastify, SQLite via Drizzle, Zod config
  validation. Talks to KSeF **read-only**.
- **Web UI** — `web/`. React 19 + Vite SPA. Talks only to the API, always at a same-origin
  `/api` prefix (hardcoded in `web/src/api/client.ts`).

It serves **two tenants** — `parkowa` and `portowa` — which are separate businesses with
separate KSeF tokens, separate NIPs, separate login credentials, separate JWT secrets, and
separate SQLite databases. They are never merged and never share a container or a volume.
A third pseudo-tenant, `local`, exists only for throwaway smoke testing.

## 2. Physical infrastructure

Two physical machines on a home LAN (this predates the KSeF app; another project, CaterScan,
already runs this way and its context doc lives at
`.cognitron/prompts/docker-deployment/deployment-context.md`):

| Alias   | LAN IP        | Role                                                            |
| ------- | ------------- | --------------------------------------------------------------- |
| `linuc` | 192.168.0.102 | Application server — runs Docker Compose stacks                 |
| `durga` | 192.168.0.103 | Edge / reverse proxy — nginx + Let's Encrypt, has the public IP |

`durga` holds public IP `194.49.105.105` with ports 80/443 forwarded from the router, and
terminates TLS via certbot for its many hosted vhosts (this app's tenants live under
`zagwozdki.ovh`, alongside unrelated `brejna.ovh` and other `zagwozdki.ovh` sites). All
traffic between `durga` and `linuc`
is plain HTTP inside the LAN. SSH aliases `ssh linuc` / `ssh durga` are configured.

Intended routing for this app (**not yet configured on `durga`** — see §11):

```
Browser (HTTPS)
      │
      ▼
  durga :443  nginx + TLS
      │
      ├── parkowa.zagwozdki.ovh ──► linuc :8081
      └── portowa.zagwozdki.ovh ──► linuc :8082
```

## 3. Architecture on the app host

Two containers per tenant, one Compose project per tenant:

```
project ksef-parkowa                       project ksef-portowa
┌─────────────────────────────────┐        ┌─────────────────────────────────┐
│ web   nginx:1.29-alpine         │        │ web   nginx:1.29-alpine         │
│   published 192.168.0.102:8081  │        │   published 192.168.0.102:8082  │
│   ├── /api/*  ──► api:3000      │        │   ├── /api/*  ──► api:3000      │
│   └── /*      ──► web/dist SPA  │        │   └── /*      ──► web/dist SPA  │
│                                 │        │                                 │
│ api   node:24.16.0-bookworm-slim│        │ api   node:24.16.0-bookworm-slim│
│   NO published ports            │        │   NO published ports            │
│   /data    ──► ksef-parkowa_data│        │   /data    ──► ksef-portowa_data│
│   /backups ──► /srv/ksef-…/…    │        │   /backups ──► /srv/ksef-…/…    │
└─────────────────────────────────┘        └─────────────────────────────────┘
                    │                                      │
                    └──────► KSeF API (outbound HTTPS only)
```

Port map (`local` avoids the real tenants; all three avoid CaterScan's 3001–3002 / 5173–5176):

| Tenant    | Compose project | Web port | Bind address  | Volume              | KSeF env |
| --------- | --------------- | -------- | ------------- | ------------------- | -------- |
| `parkowa` | `ksef-parkowa`  | 8081     | 192.168.0.102 | `ksef-parkowa_data` | `PRD`    |
| `portowa` | `ksef-portowa`  | 8082     | 192.168.0.102 | `ksef-portowa_data` | `PRD`    |
| `local`   | `ksef-local`    | 8091     | 127.0.0.1     | `ksef-local_data`   | `TEST`   |

Two deliberate choices here, both load-bearing:

- **The API publishes no ports at all.** It is reachable only from its `web` sidecar over the
  Compose network. This is also why the web port is bound to a specific host IP rather than
  `0.0.0.0`: Docker's port publishing writes DNAT rules that **bypass `ufw`**, so a
  `0.0.0.0` binding would be reachable from the whole LAN no matter what the firewall says.
- **nginx serves the SPA, not Fastify.** The frontend calls a hardcoded same-origin `/api`
  prefix, so production needs something that serves static files and proxies `/api` on one
  origin. An nginx sidecar does that with no backend code change and no CORS involvement.

## 4. Repository layout

```
deploy/
  README.md                       # orientation map
  docker-compose.yml              # ONE parameterised stack, instantiated per tenant
  ksef-stack.sh                   # tenant-aware wrapper — the only entry point operators use
  docker/
    Dockerfile                    # multi-stage; targets: build, api, web
    nginx/app.conf.template       # in-container vhost; ${API_UPSTREAM} rendered by envsubst
  env/
    <tenant>.stack.env            # COMMITTED, non-secret (3 files: parkowa, portowa, local)
    <tenant>.secrets.env.example  # COMMITTED templates
    <tenant>.secrets.env          # GIT-IGNORED, created by hand on the host
  nginx/
    ksef-tenant.conf.template     # durga vhost SOURCE ONLY — nothing installs it
  scripts/
    backup.sh  restore.sh  smoke.sh
.dockerignore
docs/DEPLOYMENT.md                # operator guide
design/DOCKER_DEPLOYMENT_PLAN.md  # original design + rationale
.cognitron/contexts/DEPLOYMENT_CONTEXT.md  # this file
```

`.gitignore` ignores `*.env`, which would have swallowed the committed stack files, so it
carries an explicit `!deploy/env/*.stack.env` negation. `*.secrets.env` stays ignored;
`*.secrets.env.example` is not matched by the ignore pattern and is committed.

## 5. Image mechanics

One `deploy/docker/Dockerfile`, three stages, build context **must** be the repo root.

**`build`** — `node:24.16.0-bookworm-slim`. Installs `python3 make g++ ca-certificates` so
`better-sqlite3` can compile from source if no prebuild matches. `corepack enable` takes
pnpm's version from `package.json`'s `packageManager` field (currently 11.10.0) — never
hardcode it. Manifests and the lockfile are copied before sources so the install layer
survives source edits; a BuildKit cache mount on `/pnpm/store` persists the package store
across builds. Then `pnpm run build` (tsc → `dist/`) and `pnpm --dir web run build`
(Vite → `web/dist/`).

Two non-obvious things in this stage, both discovered the hard way:

- `ENV CI=true` is required. Without a TTY, pnpm refuses to purge a modules directory, and
  the prod-only reinstall below fails with `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`.
- Reducing to production dependencies takes **both**
  `pnpm install --frozen-lockfile --prod --filter ksef-exporter` **and** `pnpm prune --prod`,
  run unconditionally. The `--filter` install fixes the top-level symlinks but leaves the
  devDependency package contents physically present inside `node_modules/.pnpm`; the prune
  is what actually deletes them.

The stage ends by **instantiating** a SQLite database
(`new Database(':memory:').pragma('journal_mode')`). This is deliberate: a bare
`require("better-sqlite3")` does not `dlopen` the native addon and would pass against a
broken binding. Failing here fails the build instead of the container boot.

**`api`** — same `node:24.16.0-bookworm-slim` base, so the glibc the native addon was built
against is identical. Copies `node_modules`, `dist`, `drizzle`, `package.json` into `/app`;
creates `/data` and `/backups` owned by `node`; runs as the unprivileged `node` user
(uid/gid 1000); `CMD ["node", "dist/api/main.js"]`.

Verified contents of the built image (checked directly, not inferred): Node `v24.16.0`,
running as `uid=1000(node)`, `/app` containing exactly `dist`, `drizzle`, `node_modules`,
`package.json`, **13** migration `.sql` files at `/app/drizzle/migrations`, no `.env*` file
anywhere, `/data` and `/backups` owned `node:node`. Local arm64 image sizes are roughly
514 MB (`api`) and 92 MB (`web`).

> **Layout invariant — do not break this.** `src/db/client.ts` resolves migrations as
> `../../drizzle/migrations` relative to its own module URL. From `/app/dist/db/client.js`
> that must land on `/app/drizzle/migrations`, which only holds while `drizzle/` stays a
> sibling of `dist/` at the image root. Moving either one silently breaks migrations.

`HEALTHCHECK` probes `GET http://127.0.0.1:3000/health` with a `node -e` one-liner (the slim
image has no curl): interval 30s, timeout 5s, retries 5, start-period 20s.

**`web`** — `nginx:1.29-alpine`. Removes the stock `default.conf` (it would otherwise share
`:80` with no distinguishing `server_name`), copies `web/dist` to
`/usr/share/nginx/html`, and drops `app.conf.template` into `/etc/nginx/templates/` so the
official entrypoint's envsubst step renders it at container start.

`.dockerignore` excludes `node_modules`, `dist`, `web/dist`, `data/`, `.env*`, `*.env`,
`.git`, `.venv`, `.pnpm-store`, `.secrets`, `.cognitron`, `design`, `docs`, `scratch`,
`coverage`, `*.log`, `*.xlsx`. This is the primary guarantee that no secret and no real
invoice data can enter an image layer — observed effect: a 7 kB build context from a repo
whose working tree holds hundreds of MB.

## 6. nginx sidecar mechanics

`deploy/docker/nginx/app.conf.template`:

- `location /api/ { proxy_pass ${API_UPSTREAM}/; }` — the **trailing slash strips the `/api`
  prefix**, mirroring the Vite dev proxy's rewrite, so `/api/auth/login` on the wire reaches
  the backend's `/auth/login`. The backend has no `/api` prefix of its own.
- `proxy_read_timeout 300s` on `/api/`, well past nginx's 60s default: `POST /sync` polls a
  KSeF export and `GET /invoices/export` streams a generated workbook.
- `/assets/` gets `public, max-age=31536000, immutable` (Vite content-hashes those names);
  `index.html` gets `no-store`.
- SPA fallback `try_files $uri $uri/ /index.html`.

`${API_UPSTREAM}` (supplied by compose as `http://api:3000`) is the **only** dollar-brace
name in that file. nginx's own variables are written bare (`$host`, `$remote_addr`,
`$scheme`, `$proxy_add_x_forwarded_for`) precisely so envsubst leaves them alone. Never wrap
an nginx variable in `${...}` there.

`deploy/nginx/ksef-tenant.conf.template` is a different thing with a different convention: it
is the source for the vhost on `durga`, filled in **by hand** using `__TENANT__` / `__PORT__`
placeholders, because no entrypoint ever renders it. Do not confuse the two.

## 7. Configuration and secrets model

`deploy/ksef-stack.sh <tenant> <compose args…>` validates that both env files exist (with a
readable error naming the `.example` to copy) and then execs
`docker compose --env-file deploy/env/<tenant>.stack.env -f deploy/docker-compose.yml "$@"`.
Compose reads `COMPOSE_PROJECT_NAME` from that env file, which is what namespaces the
project, containers, network, and volume per tenant.

| Where                             | Contents                                                                                                                    | Committed? |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `deploy/env/<tenant>.stack.env`   | `COMPOSE_PROJECT_NAME`, `TENANT`, `KSEF_ENVIRONMENT`, `WEB_ORIGIN`, `WEB_BIND`, `WEB_PORT`, `LOG_LEVEL`, `TZ`, `BACKUP_DIR` | yes        |
| `deploy/env/<tenant>.secrets.env` | `KSEF_NIP`, `KSEF_TOKEN`, `AUTH_USERNAME`, `AUTH_PASSWORD`, `JWT_SECRET`                                                    | **no**     |
| compose `environment:` block      | `DATABASE_PATH`, `PORT`, `NODE_ENV`, plus pass-through of `WEB_ORIGIN`/`KSEF_ENVIRONMENT`/`LOG_LEVEL`/`TZ`                  | yes        |

Two hazards in secret *values*, both found the hard way during the first real deploy:

- **Never `source` a secrets file from a shell script.** A real KSeF token is
  pipe-separated (`<hex>|<hex>|nip-<nip>`), and `source` parses those pipes as a shell
  pipeline, then tries to execute the token's own segments as commands. That both breaks the
  script and prints secret material to the terminal. `deploy/scripts/smoke.sh` originally did
  this and leaked part of a live token into a terminal before being fixed; it now parses
  `KEY=value` line by line with no shell evaluation. The same applies to `$`, backticks,
  `&`, `;`, and parentheses.
- **Compose interpolates `env_file` values, so `$` silently corrupts a secret.** A password
  of `p$ssw0rd-with-$dollar` reached the container as `p-with-` (7 chars) and failed
  validation. Write `$$` for a literal `$`, or avoid it. Pipes, `+`, `/`, and `=` are safe —
  verified by hashing a token inside the container and comparing it to the source value.
  Neither real tenant's secrets currently contain a `$`, a backslash, or a `#`.

Three precedence facts that matter:

1. **Compose's `environment:` overrides `env_file`.** That is why secrets must never also
   appear in a stack file, and why `KSEF_NIP` is deliberately *absent* from the
   `environment:` block — listing it there with an unset value would shadow the real one from
   the secrets file.
2. **`KSEF_NIP` lives in the secrets file, not the stack file**, so no committed file
   carries tenant identity.
3. **Real environment variables beat `.env*` files.** `src/config/load-env.ts` only assigns
   keys that are still `undefined`, so container env vars always win. No `.env` file is ever
   baked into or mounted onto an image, and `APP_ENV` is not set in containers — the loader
   simply finds no files and moves on. `APP_ENV=<tenant>` remains the mechanism for
   *developer machines*, where `.env.<tenant>` files select a tenant.

Validation lives in `src/config/env.ts` (Zod): `KSEF_NIP` must be 10 digits,
`AUTH_PASSWORD` ≥ 8 chars, `JWT_SECRET` ≥ 32 chars, `KSEF_ENVIRONMENT` one of
`TEST`/`DEMO`/`PRD`. It fails fast and aggregates every problem into one message.

## 8. Data lifecycle

**Migrations** are applied by `createDb()` on **every API boot**, forward-only, with foreign
keys disabled around them (SQLite emulates `ALTER TABLE` by rebuilding, and a `DROP TABLE`
with enforcement on fires `ON DELETE CASCADE` — that would silently empty `invoice_items`).
`createDb()` handles this; do not remove it. `pnpm run db:generate` stays a developer-machine
action and generated SQL is never hand-edited.

Consequences: only one container may boot against a given database file at a time (one API
container per tenant, no scaling, no concurrent `run` while the stack is up), and rolling code
back across a migration is not automatically safe.

**Backups.** `src/db/backup.ts`'s `backupDatabase({ sqlite, destDir, now, keep })` writes
`<destDir>/ksef-exporter-<YYYYMMDDTHHMMSS>.sqlite` via SQLite's `VACUUM INTO`, then prunes to
the newest `keep` (default 14). Two details are deliberate: the stamp is **UTC** so lexical
order equals chronological order, and pruning only ever considers files matching
`/^ksef-exporter-\d{8}T\d{6}\.sqlite$/` so nothing else in the directory is at risk.

`VACUUM INTO` is the required primitive — it produces one consistent file that already
includes committed WAL content, unlike copying the live `.sqlite`/`-wal`/`-shm` trio, which
can be torn. This was verified against a database with a row still sitting in an
uncheckpointed WAL.

`src/tools/backup-db.ts` is the CLI (`node dist/tools/backup-db.js` in the container,
`pnpm run backup:db` on a dev machine). Output dir resolution: `--out <dir>` → `BACKUP_DIR`
env var → `/backups`. It deliberately **does not** call `loadConfig()` (a backup must not
require `KSEF_TOKEN`/`AUTH_*`/`JWT_SECRET`) and **does not** use `createDb()` (which would
apply migrations); it opens the file directly with `fileMustExist: true`.

`deploy/scripts/backup.sh <tenant>` runs that tool inside the running container and refuses
if the stack is down. Snapshots land in the host bind mount (`/srv/ksef-backups/<tenant>` for
real tenants), so they survive `down -v`. Intended as a nightly per-tenant cron entry.

**Restore.** `deploy/scripts/restore.sh <tenant> <snapshot> --yes` copies a snapshot into the
tenant's volume via a throwaway `alpine` container, removing stale `-wal`/`-shm` sidecar files
from the destination first and `chown`ing the result to `1000:1000` (the `node` user).
Guardrails: it refuses while the stack is running, never stops or starts the stack itself, and
without the literal `--yes` prints a dry run and exits non-zero.

**Seeding a server from the live dev databases.** The real data currently lives on the
developer Mac at `data/tenants/<tenant>/ksef-exporter.sqlite` (roughly 4 MB parkowa,
9.6 MB portowa, with non-empty WAL files). Procedure: stop the local API first (a running
`tsx watch` holds the file open in WAL mode), `APP_ENV=<tenant> pnpm run backup:db --out /tmp`
to get one consistent snapshot, transfer it, then `restore.sh` it into the volume with the
stack stopped. **Never** copy `.sqlite`/`-wal`/`-shm` individually, and never bind-mount the
repo's `data/` directory into a container.

## 9. Operations

All commands run on the app host, from the checkout:

| Task                 | Command                                                                      |
| -------------------- | ---------------------------------------------------------------------------- |
| First start / update | `deploy/ksef-stack.sh <tenant> up -d --build`                                |
| Status / logs        | `deploy/ksef-stack.sh <tenant> ps` · `… logs -f api`                         |
| Stop (keep data)     | `deploy/ksef-stack.sh <tenant> down`                                         |
| Post-deploy check    | `deploy/scripts/smoke.sh <tenant>`                                           |
| One-off task         | `deploy/ksef-stack.sh <tenant> exec -T api node dist/tools/<name>.js`        |
| Manual backup        | `deploy/scripts/backup.sh <tenant>`                                          |
| Restore              | stop stack → `deploy/scripts/restore.sh <tenant> <snapshot> --yes` → `up -d` |

Every compiled tool under `dist/tools/` is available through `exec` — backfills, reconcile,
export, backup. `tsx` is not present in the runtime image, which is why they run as compiled
JS.

`smoke.sh` checks `/health`, logs in, and makes one authenticated call; it makes **no** KSeF
call. Its credential handling is deliberate: the tenant's secrets file is sourced into local
shell variables, never echoed, and the login body goes through a `0600` temp file via
`curl --data-binary @file` so no password appears in `ps` output or shell history.

Images carry `org.opencontainers.image.revision` from a `GIT_SHA` build arg. Rollback is
`git checkout <sha>` plus a rebuild, not a registry pull — there is no registry.

## 10. Invariants an agent must not violate

1. **No scheduled or automatic sync, ever.** The KSeF export-init endpoint is capped at 16
   requests/minute and 20/hour, and `syncPurchaseInvoices` defaults to `maxIterations: 1`
   because the SDK's default of 20 caused a real production rate-limit incident. Sync stays
   user-triggered from the UI. Do not add a cron, a boot-time sync, or a retry loop around
   export-init in any deployment glue.
2. **KSeF access is read-only.** Never add invoice-issuing permissions. Never log KSeF
   tokens, JWTs, or raw SDK response bodies / invoice XML.
3. **One writer per SQLite file.** No scaling, no second container against one volume.
4. **Volumes stay on local disk.** SQLite locking is unreliable on NFS/SMB.
5. **Tenant isolation is absolute** — separate volumes, credentials, and `JWT_SECRET`s. A
   shared secret would make one tenant's session valid on the other.
6. **`better-sqlite3` is a single-ABI native addon.** Node 24 is ABI 137, Node 22 is 127. A
   `NODE_MODULE_VERSION` mismatch is an environment/build problem — the image was built for
   the wrong architecture or Node version. It is *never* fixed by editing source or tests.
   Never mount host `node_modules` into a container or copy it between architectures.
7. **Secrets and real data never enter an image.** No `COPY . .`; keep `.dockerignore` honest.
8. **Do not touch `durga` implicitly.** Edge changes are deliberate operator actions.

## 11. What is done, and what is not

Implemented, committed on branch `docker-deployment`, and verified:

- Both images build; `docker compose config` renders correctly for all three tenants with
  correct project/volume/port namespacing and no published API port.
- A real end-to-end smoke test against the `local` tenant: `/health` → 200 `{"status":"ok"}`,
  the SPA served with expected cache headers, login issuing a JWT, and an authenticated
  `GET /api/invoices` → 200 — all through the nginx sidecar.
- `backup.sh` produced a valid, openable snapshot; `restore.sh` performed a real destructive
  restore into the disposable `local` volume, after which the API booted and served cleanly
  off the restored file.
- Repo checks: 328 backend tests, 65 frontend tests, both typechecks, biome across 123 files.

**Deployed to `linuc` on 2026-09-13.** Both tenant stacks are running there from a checkout at
`~/playground/ksef-exporter` (branch `docker-deployment`, image label
`org.opencontainers.image.revision` = `0ab4521` on both). The amd64 build is now proven: it
compiled `better-sqlite3` natively and passed the in-image instantiation probe on
Ubuntu 6.8 / x86_64 with Docker 24.0.2. `smoke.sh` passes for both tenants against real
credentials. `/srv/ksef-backups/{parkowa,portowa}` exist, owned by `karol` (uid 1000, which
matches the container's `node` user, so the bind mount is writable).

Also confirmed on the host: ports 8081/8082 were free, `api` publishes nothing while `web`
binds only `192.168.0.102:<port>`, and the tenant volumes `ksef-parkowa_data` /
`ksef-portowa_data` were created cleanly.

**Seeded with real data on 2026-09-13**, following the §8 procedure, and `linuc` is now the
authoritative instance. Verified after restore, per tenant, against the source databases:

| Tenant    | invoices | invoice_items | sync_runs | sync_state                         |
| --------- | -------- | ------------- | --------- | ---------------------------------- |
| `parkowa` | 493      | 4 534         | 54        | 2 rows, continuation points intact |
| `portowa` | 655      | 6 557         | 36        | 2 rows, continuation points intact |

Row counts are identical to the source across every table, the `sync_state` rows hash
byte-identically to the source (so the next sync resumes instead of refetching into a
rate-limited endpoint), no migration was applied on boot, and the API serves the real data
through the sidecar. Pre-cutover snapshots are retained as `seed-<tenant>.sqlite` in each
tenant's backup directory; they deliberately do **not** match the
`ksef-exporter-<stamp>.sqlite` pattern, so `backup.sh`'s retention will never prune them.

Note for anyone re-running the seeding procedure: `backup-db.ts` opens the source read-write
(it must, to run `VACUUM INTO`), so closing it **checkpoints a non-empty WAL into the main
database file**, changing that file's mtime. That is a safe consolidation, not a write of new
data — verified with `integrity_check` and `foreign_key_check` plus unchanged row counts — but
do not be alarmed by the mtime, and do not run it against a database another process is
writing.

Not done:

- **`durga` is untouched, deliberately.** No DNS records, no vhost installed, no certificate
  issued, so the app is **not reachable from the internet** — only from the LAN at
  `http://192.168.0.102:8081` / `:8082`. Public exposure is intentionally deferred until
  stronger authentication is in place (the app currently has one shared username/password per
  tenant and no rate limiting on `POST /auth/login`).
  `deploy/nginx/ksef-tenant.conf.template` is committed source only.
- **No cron entry for `backup.sh` is installed yet** — now the more pressing gap, since the
  volumes hold the only actively-used copy of this data.
- The branch is pushed but not merged to `main`.

## 12. Known deployment-relevant defect found during this work

`exceljs` was declared in `devDependencies` but is imported at runtime by
`src/invoices/export-invoices-workbook.ts`, which backs `GET /invoices/export`. Every install
anyone had ever run happened to include devDependencies, so it never surfaced; the first
production-only install crashed the API at boot with `ERR_MODULE_NOT_FOUND`. Fixed by moving
it to `dependencies`.

The general lesson for this repo: the container is the only environment that installs
production dependencies only, so it is the only place a misclassified dependency shows up.
If a module resolves in tests and on a dev machine but not in the image, check which
dependency block it is in before suspecting the Dockerfile.
