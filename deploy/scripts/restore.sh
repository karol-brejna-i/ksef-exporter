#!/usr/bin/env bash
# Restores a `VACUUM INTO` snapshot into a tenant's Docker volume, replacing
# the live database. DESTRUCTIVE — see design/DOCKER_DEPLOYMENT_PLAN.md §8.
#
# Usage: deploy/scripts/restore.sh <tenant> <snapshot-filename-or-path> --yes
#   <snapshot-filename-or-path> is either a bare filename (looked up inside
#   the tenant's BACKUP_DIR, as configured in deploy/env/<tenant>.stack.env)
#   or an absolute/relative path to a snapshot file.
#
# Without --yes this prints what it WOULD do and exits non-zero (dry run).
# Nothing destructive happens without that explicit, literal flag.
#
# This script does NOT stop or start the tenant's stack — it refuses to run
# while the stack is up, and leaves starting it back up to the operator via
# `deploy/ksef-stack.sh <tenant> up -d`.

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
env_dir="${script_dir}/../env"
deploy_dir="${script_dir}/.."
stack_sh="${script_dir}/../ksef-stack.sh"

usage() {
  cat <<'EOF'
Usage: deploy/scripts/restore.sh <tenant> <snapshot-filename-or-path> [--yes]

Restores a VACUUM INTO snapshot into the tenant's Docker volume, replacing
/data/ksef-exporter.sqlite and removing any stale -wal/-shm sidecar files.

Requires the tenant's stack to be stopped first (checked, never done
automatically). Without --yes, prints a dry run of what would happen and
exits non-zero; nothing is written without that literal flag.
EOF
}

# --yes may appear anywhere in argv; everything else is positional.
positional=()
confirm=false
for arg in "$@"; do
  if [[ "${arg}" == "--yes" ]]; then
    confirm=true
  else
    positional+=("${arg}")
  fi
done

if [[ ${#positional[@]} -lt 2 ]]; then
  usage
  exit 1
fi

tenant="${positional[0]}"
snapshot_arg="${positional[1]}"

# Same tenant validation as deploy/ksef-stack.sh.
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

# This is destructive, so refuse outright if the stack is up. Stopping it is
# an explicit operator decision, not something this script does for you.
if ! running_services="$("${stack_sh}" "${tenant}" ps --status running --services)"; then
  echo "error: failed to query stack status for tenant '${tenant}'" >&2
  exit 1
fi

if [[ -n "${running_services}" ]]; then
  echo "error: tenant '${tenant}' stack is running — refusing to restore over a live database." >&2
  echo "Stop it first: deploy/ksef-stack.sh ${tenant} down" >&2
  exit 1
fi

# Resolve BACKUP_DIR (relative paths, like the "local" tenant's, are relative
# to deploy/ — the compose file's directory, same as Compose itself resolves
# them) and COMPOSE_PROJECT_NAME straight out of the committed stack env
# file, rather than duplicating tenant config elsewhere.
backup_dir_raw="$(grep -E '^BACKUP_DIR=' "${stack_env}" | tail -1 | cut -d= -f2-)"
project_name="$(grep -E '^COMPOSE_PROJECT_NAME=' "${stack_env}" | tail -1 | cut -d= -f2-)"

if [[ -z "${backup_dir_raw}" ]]; then
  echo "error: BACKUP_DIR not set in ${stack_env}" >&2
  exit 1
fi
if [[ -z "${project_name}" ]]; then
  echo "error: COMPOSE_PROJECT_NAME not set in ${stack_env}" >&2
  exit 1
fi

if [[ "${backup_dir_raw}" = /* ]]; then
  backup_dir="${backup_dir_raw}"
else
  backup_dir="${deploy_dir}/${backup_dir_raw}"
fi

# Bare filename (no "/") -> look up inside the tenant's backup directory.
# Anything containing "/" is treated as the path itself (absolute or
# relative to the current working directory).
if [[ "${snapshot_arg}" == */* ]]; then
  snapshot_path="${snapshot_arg}"
else
  snapshot_path="${backup_dir}/${snapshot_arg}"
fi

if [[ ! -f "${snapshot_path}" ]]; then
  echo "error: snapshot file not found: ${snapshot_path}" >&2
  exit 1
fi

# Resolve to an absolute path so the read-only bind mount below is unambiguous.
snapshot_dir="$(cd "$(dirname "${snapshot_path}")" && pwd)"
snapshot_name="$(basename "${snapshot_path}")"
snapshot_path="${snapshot_dir}/${snapshot_name}"

# Compose's default volume naming for a top-level `volumes: data:` entry with
# no explicit `name:` is "<project>_<volume-key>" (confirmed against
# deploy/docker-compose.yml's top-level `volumes:` block and `docker volume
# ls` after bringing up a local stack).
volume_name="${project_name}_data"

cat <<SUMMARY
About to restore tenant '${tenant}':
  snapshot:        ${snapshot_path}
  target volume:   ${volume_name}
  target file:     /data/ksef-exporter.sqlite (inside ${volume_name})
  also removed:    /data/ksef-exporter.sqlite-wal, /data/ksef-exporter.sqlite-shm
                   (stale sidecar files, if present, so SQLite doesn't get
                   confused about WAL state on next open)

This REPLACES the live database in that volume. It cannot be undone except
by restoring an earlier snapshot. The '${tenant}' stack is confirmed stopped.
SUMMARY

if [[ "${confirm}" != "true" ]]; then
  echo
  echo "Dry run only — no changes made. Re-run with --yes to actually restore." >&2
  exit 1
fi

echo
echo "Restoring..."

# Throwaway alpine container: bind the snapshot's directory read-only, mount
# the named volume, remove any stale sidecar files, copy the snapshot in as
# the new database file, and chown it to uid:gid 1000:1000 (the "node" user
# in node:24-bookworm-slim, which the api container runs as) so the api
# container can still read/write it after restart. alpine has no "node" user
# of its own, hence the numeric chown rather than a name.
docker run --rm \
  -v "${volume_name}:/data" \
  -v "${snapshot_dir}:/backup:ro" \
  alpine:3 \
  sh -c "rm -f /data/ksef-exporter.sqlite /data/ksef-exporter.sqlite-wal /data/ksef-exporter.sqlite-shm \
    && cp \"/backup/${snapshot_name}\" /data/ksef-exporter.sqlite \
    && chown 1000:1000 /data/ksef-exporter.sqlite"

echo "Restore complete: ${volume_name} now has ${snapshot_name} as ksef-exporter.sqlite."
echo "Start the stack when ready: deploy/ksef-stack.sh ${tenant} up -d"
