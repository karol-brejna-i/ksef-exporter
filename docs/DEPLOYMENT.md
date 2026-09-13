# Deployment

*Created: 2026-09-13 19:56 CEST*

Operator/developer guide for running KSeF Exporter as Docker containers. For the design
this implements, see [`design/DOCKER_DEPLOYMENT_PLAN.md`](../design/DOCKER_DEPLOYMENT_PLAN.md).
For a self-contained agent context document, see `design/DEPLOYMENT_CONTEXT.md` (written
separately; if it isn't there yet, use the design plan instead).

## 1. Overview

Each tenant runs as its own two-container stack: `api` (the Fastify backend, compiled to
`dist/`, not reachable outside the compose network) and `web` (an nginx sidecar that serves
the built React SPA and reverse-proxies `/api/*` to `api`, so the browser only ever talks to
one origin). There is no CI pipeline and no image registry — images are built directly on
the target host from a git checkout, because `better-sqlite3` is a single-ABI native addon
and building natively on the host that will run it avoids cross-architecture trouble
entirely. Every tenant gets its own stack, own volume, own secrets, and own subdomain.

## 2. Prerequisites

- Docker with Compose v2 (`docker compose`, not the standalone `docker-compose`) on the
  target host.
- A git checkout of this repository on that host.

No Node.js or pnpm installation is required on the host itself — everything needed to build
is inside the Docker build stage.

## 3. First-time setup for a tenant

Copy the committed secrets template and fill in real values:

```sh
cp deploy/env/<tenant>.secrets.env.example deploy/env/<tenant>.secrets.env
```

Edit `deploy/env/<tenant>.secrets.env` and set:

- `KSEF_NIP` — 10 digits, no spaces or dashes.
- `KSEF_TOKEN` — a KSeF token scoped to `InvoiceRead` only.
- `AUTH_USERNAME` — any non-empty string.
- `AUTH_PASSWORD` — at least 8 characters.
- `JWT_SECRET` — at least 32 characters; generate one with `openssl rand -base64 32`.

`deploy/env/*.secrets.env` is already git-ignored (only the `.example` templates and the
non-secret `*.stack.env` files are committed) — never commit the filled-in copy regardless.

## 4. Starting or updating a stack

```sh
deploy/ksef-stack.sh <tenant> up -d --build
```

`ksef-stack.sh` is the only entry point operators use: it validates that the tenant's stack
and secrets files exist (a readable error instead of Compose's generic "variable is not
set" warning) and then execs `docker compose --env-file deploy/env/<tenant>.stack.env -f
deploy/docker-compose.yml "$@"`. Three tenants are defined:

- `parkowa`, `portowa` — the real tenants, each with its own subdomain, volume, and KSeF
  credentials.
- `local` — a throwaway smoke-test tenant with obviously-fake-but-schema-valid credentials
  (`deploy/env/local.secrets.env.example`) and no real KSeF access. Use it to prove a build
  or a compose change works before touching a real tenant.

Re-run the same command to deploy an update (`git pull` first, then `up -d --build` again);
Compose only rebuilds and restarts what changed.

## 5. Common operations

`ksef-stack.sh` forwards everything after `<tenant>` straight to `docker compose`, so any
compose subcommand works:

```sh
deploy/ksef-stack.sh parkowa ps                # container status
deploy/ksef-stack.sh parkowa logs -f api        # follow the API's logs
deploy/ksef-stack.sh parkowa logs -f web        # follow nginx's logs
deploy/ksef-stack.sh parkowa down               # stop, keep the data volume
deploy/ksef-stack.sh parkowa exec -T api <cmd>  # run a command inside the api container
```

`down` removes the containers but not the named `data` volume; add `-v` only if you
deliberately want to discard the tenant's database (never do this without a backup — see
§7).

## 6. Running one-off maintenance tasks

Every compiled tool under `dist/tools/` is available inside the running `api` container the
same way:

```sh
deploy/ksef-stack.sh parkowa exec -T api node dist/tools/export-invoices.js
deploy/ksef-stack.sh parkowa exec -T api node dist/tools/reconcile.js
```

Other tools built the same way include `backfill-invoice-items.js`,
`backfill-invoice-kind.js`, `backfill-invoice-totals.js`, `backfill-invoices.js`,
`extract-xlsx.js`, and `backup-db.js` (used internally by `backup.sh`, §7). Check each
tool's own `src/tools/*.ts` source (or its `--help`/usage output) before running it against
a real tenant — several of these write to the database, not just read from it.

## 7. Backups and restore

```sh
deploy/scripts/backup.sh <tenant>
deploy/scripts/restore.sh <tenant> <snapshot>
```

A snapshot is produced by `VACUUM INTO` (`src/db/backup.ts`), not a raw file copy — that
matters because the live database runs in WAL mode, and copying `.sqlite`/`-wal`/`-shm`
individually can produce a torn, inconsistent file. Snapshots are named
`ksef-exporter-<UTC timestamp>.sqlite` (lexical order is chronological order) and the backup
tool keeps the newest 14 by default, deleting older ones automatically. They land in
`/backups` inside the container, which is bind-mounted from the host directory named by that
tenant's `BACKUP_DIR` (e.g. `/srv/ksef-backups/parkowa` for the real tenants) — a bind mount,
not the named `data` volume, so snapshots survive `down -v` even if the database volume is
deliberately discarded.

`backup.sh` is committed as of this wave; `restore.sh` and `smoke.sh` (§9) are being added in
the same wave and may not be present yet in `deploy/scripts/` — if a command isn't found,
check there before assuming it's missing entirely.

## 8. Seeding a deployment from the existing local databases

Before first bringing up a real tenant's stack, load its existing local database rather than
starting empty:

1. Stop the local dev API for that tenant first — a running `tsx watch src/api/main.ts`
   holds the SQLite file open in WAL mode, which would make a snapshot inconsistent.
2. Take a consistent snapshot on the development machine:
   ```sh
   APP_ENV=<tenant> pnpm run backup:db --out /tmp
   ```
3. Transfer the resulting `ksef-exporter-<timestamp>.sqlite` file to the target host.
4. Load it with `deploy/scripts/restore.sh <tenant> <snapshot>` *before* the tenant's stack
   is started for the first time.

Never copy the raw `.sqlite`, `-wal`, and `-shm` files individually into a volume, and never
bind-mount the repository's own `data/` directory into a container — both bypass the
consistency guarantee `VACUUM INTO` exists to provide.

## 9. Post-deploy verification

```sh
deploy/scripts/smoke.sh <tenant>
```

Per the design, this checks `/health`, logs in with the tenant's own credentials, and fetches
one page of invoices — no KSeF call is made. As with `restore.sh` above, this script lands
in the same wave as this guide; if it's not yet in `deploy/scripts/`, verify manually instead:

```sh
curl -sf http://<web-host>:<port>/api/health
```

## 10. Edge integration (durga)

Everything above runs entirely on the target host (`linuc` in this deployment). Making a
tenant reachable over the public internet with TLS is a separate, manual operator procedure
on the edge host (`durga`) that **this repository and this guide do not automate** — none of
it was run as part of building this deployment:

1. Add DNS `A` records for the tenant's subdomain pointing at the edge host's public IP.
2. Render `deploy/nginx/ksef-tenant.conf.template` for the tenant (fill in `server_name` and
   the `proxy_pass` target/port) and copy the result into `/etc/nginx/sites-available/` on
   `durga`, then symlink it into `sites-enabled/`.
3. `nginx -t` to validate the config, then reload nginx.
4. Request a certificate, e.g. `sudo certbot --nginx -d <tenant>.ksef.brejna.ovh
   --non-interactive --agree-tos --redirect`.

Because the app holds real invoice data behind a single-owner login, also consider adding an
IP allow-list or basic-auth in front of the vhost — an operator decision, not a default.

## 11. Rollback

Take a snapshot (§7) before deploying any release that adds a database migration. To roll
back:

```sh
git checkout <older-sha>
deploy/ksef-stack.sh <tenant> up -d --build
```

If the release you're rolling back past added a migration, also restore the pre-release
snapshot (§7) — migrations are forward-only and applied automatically on every API boot, so
an older binary is not guaranteed to work against a migrated schema.

## 12. Troubleshooting

- **`NODE_MODULE_VERSION` mismatch in `api` logs.** This means the image running on this
  host was not built (or not rebuilt) for this host's architecture — never "fix" it by
  editing source. Rebuild the image on the target host: `deploy/ksef-stack.sh <tenant> up -d
  --build`.
- **`api` container crash-looping.** Almost always means `loadConfig()` failed validation at
  boot. Run `deploy/ksef-stack.sh <tenant> logs api` — it prints the aggregated Zod message
  naming every missing or invalid environment variable.
- **`web` never becomes healthy / stack hangs on `up`.** `web`'s `depends_on: api:
  condition: service_healthy` means `web` will not start until `api`'s healthcheck
  (`GET /health`) passes. If this never resolves, the problem is almost always in `api`, not
  `web` — check `deploy/ksef-stack.sh <tenant> logs api`, not `web`'s.
