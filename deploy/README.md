# deploy/

*Created: 2026-09-13 19:56 CEST*

Everything needed to run KSeF Exporter as per-tenant Docker Compose stacks. Nothing under
`src/` or `web/` needs to know it is containerised — all of that lives here.

| Path                | What it is |
| ------------------- | ---------- |
| `docker-compose.yml`| Single parameterised stack definition, instantiated once per tenant via `ksef-stack.sh`. |
| `ksef-stack.sh`     | Tenant-aware wrapper around `docker compose` — the entry point operators use. |
| `docker/`           | The multi-stage `Dockerfile` (targets `api`, `web`) and the in-container nginx vhost template. |
| `env/`              | Per-tenant config: committed non-secret `<tenant>.stack.env`, committed `<tenant>.secrets.env.example` templates, and the git-ignored `<tenant>.secrets.env` files created on the host. |
| `scripts/`          | Operational scripts: `backup.sh`, `restore.sh`, `smoke.sh`. |
| `nginx/`            | Source template for the edge (`durga`) vhost, installed manually — not run by anything in this repo. |

For how to actually use this — first-time setup, starting/updating a stack, backups,
restore, seeding a deployment, and troubleshooting — see
[`docs/DEPLOYMENT.md`](../docs/DEPLOYMENT.md).

For the original design this implements, see
[`design/DOCKER_DEPLOYMENT_PLAN.md`](../design/DOCKER_DEPLOYMENT_PLAN.md). For a
self-contained agent context document (infrastructure, hostnames, ports, config
precedence, data lifecycle), see `design/DEPLOYMENT_CONTEXT.md` — written separately; if
it isn't there yet, use the design plan instead.
