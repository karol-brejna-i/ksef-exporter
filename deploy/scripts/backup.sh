#!/usr/bin/env bash
# Wrapper around the containerized backup tool. Runs
# `node dist/tools/backup-db.js` inside the tenant's running "api" container,
# writing a `VACUUM INTO` snapshot into /backups (bind-mounted from that
# tenant's BACKUP_DIR) and pruning old snapshots. Intended to be installed as
# a nightly per-tenant cron entry — see design/DOCKER_DEPLOYMENT_PLAN.md §8-9.
#
# Usage: deploy/scripts/backup.sh <tenant>
# Example: deploy/scripts/backup.sh parkowa
#
# The container's BACKUP_DIR env var is deliberately unset (see
# deploy/docker-compose.yml): src/tools/backup-db.ts defaults its output
# directory to /backups when BACKUP_DIR is unset, which is exactly where
# compose bind-mounts the host backup directory. No extra flag is needed.

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
env_dir="${script_dir}/../env"
stack_sh="${script_dir}/../ksef-stack.sh"

usage() {
  cat <<'EOF'
Usage: deploy/scripts/backup.sh <tenant>

Runs the containerized backup tool inside the tenant's running "api"
container. Fails loudly (non-zero exit) if the tenant is unknown or its
stack is not running.
EOF
}

if [[ $# -lt 1 ]]; then
  usage
  exit 1
fi

tenant="$1"

# Same tenant validation as deploy/ksef-stack.sh, so a bad tenant name fails
# here with the same wording before anything talks to Docker.
stack_env="${env_dir}/${tenant}.stack.env"
if [[ ! -f "${stack_env}" ]]; then
  echo "error: unknown tenant '${tenant}' (no ${stack_env})" >&2
  echo "available tenants:" >&2
  for f in "${env_dir}"/*.stack.env; do
    [[ -e "${f}" ]] || continue
    base="$(basename "${f}")"
    echo "  - ${base%.stack.env}" >&2
  done
  exit 1
fi

# Don't let `exec` silently do nothing useful against a stopped stack: confirm
# the "api" service actually has a running container first. ksef-stack.sh's
# own secrets-file validation still applies and surfaces naturally here (its
# stderr is not captured).
if ! running_services="$("${stack_sh}" "${tenant}" ps --status running --services)"; then
  echo "error: failed to query stack status for tenant '${tenant}'" >&2
  exit 1
fi

if ! grep -qx "api" <<<"${running_services}"; then
  echo "error: tenant '${tenant}' stack is not running (no running 'api' service)" >&2
  echo "start it first: deploy/ksef-stack.sh ${tenant} up -d" >&2
  exit 1
fi

if ! output="$("${stack_sh}" "${tenant}" exec -T api node dist/tools/backup-db.js 2>&1)"; then
  echo "error: backup failed for tenant '${tenant}':" >&2
  echo "${output}" >&2
  exit 1
fi

# One line on success, prefixed with the tenant, so nightly cron mail (one
# job per tenant) stays readable without being noisy.
echo "[${tenant}] ${output}"
