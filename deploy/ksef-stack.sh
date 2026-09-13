#!/usr/bin/env bash
# Tenant-aware wrapper around `docker compose`. This is the only entry point
# operators use to manage a tenant stack. See design/DOCKER_DEPLOYMENT_PLAN.md
# §6 and §9.
#
# Usage: deploy/ksef-stack.sh <tenant> <compose args...>
# Example: deploy/ksef-stack.sh parkowa up -d --build

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
env_dir="${script_dir}/env"
compose_file="${script_dir}/docker-compose.yml"

usage() {
  cat <<'EOF'
Usage: deploy/ksef-stack.sh <tenant> <compose args...>

Examples:
  deploy/ksef-stack.sh parkowa up -d --build
  deploy/ksef-stack.sh parkowa ps
  deploy/ksef-stack.sh parkowa logs -f api
  deploy/ksef-stack.sh parkowa down
EOF
}

if [[ $# -lt 1 ]]; then
  usage
  exit 1
fi

tenant="$1"
shift

stack_env="${env_dir}/${tenant}.stack.env"
secrets_env="${env_dir}/${tenant}.secrets.env"

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

if [[ ! -f "${secrets_env}" ]]; then
  echo "error: missing secrets file ${secrets_env}" >&2
  echo "copy deploy/env/${tenant}.secrets.env.example to ${secrets_env} and fill in real values" >&2
  exit 1
fi

exec docker compose --env-file "${stack_env}" -f "${compose_file}" "$@"
