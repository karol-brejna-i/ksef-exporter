#!/usr/bin/env bash
# Post-deploy health/login/invoices check. Makes NO KSeF call. See
# design/DOCKER_DEPLOYMENT_PLAN.md §9.
#
# Usage: deploy/scripts/smoke.sh <tenant>
# Example: deploy/scripts/smoke.sh parkowa
#
# Credential handling: this script needs the tenant's real AUTH_USERNAME/
# AUTH_PASSWORD to exercise POST /api/auth/login end to end, but must never
# print them, put them on the command line (visible in `ps` and shell
# history), or require the operator to type them interactively (this must
# run non-interactively, e.g. right after `up -d --build`). The approach:
#   - source deploy/env/<tenant>.secrets.env (already present on the host by
#     the time anyone runs a smoke test) into local shell variables only;
#     it is never echoed, printed, or passed through `env`/`set` output.
#   - the JSON login body is built with a bash builtin (printf) into a
#     0600 temp file and sent with `curl --data-binary @file`, so the
#     password never appears as a literal in this script's own argv (which
#     is all that's visible externally in `ps`) or in curl's argv.
#   - the temp file is removed on exit via a trap, success or failure.

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
env_dir="${script_dir}/../env"

usage() {
  cat <<'EOF'
Usage: deploy/scripts/smoke.sh <tenant>

Checks (in order): GET /api/health returns 200 {"status":"ok"}; POST
/api/auth/login with the tenant's real credentials succeeds; GET
/api/invoices with the returned JWT returns 200. Makes no KSeF call.
Exits non-zero if any check fails.
EOF
}

if [[ $# -lt 1 ]]; then
  usage
  exit 1
fi

tenant="$1"

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

secrets_env="${env_dir}/${tenant}.secrets.env"
if [[ ! -f "${secrets_env}" ]]; then
  echo "error: missing secrets file ${secrets_env}" >&2
  echo "copy deploy/env/${tenant}.secrets.env.example to ${secrets_env} and fill in real values" >&2
  exit 1
fi

web_bind="$(grep -E '^WEB_BIND=' "${stack_env}" | tail -1 | cut -d= -f2-)"
web_port="$(grep -E '^WEB_PORT=' "${stack_env}" | tail -1 | cut -d= -f2-)"
if [[ -z "${web_bind}" || -z "${web_port}" ]]; then
  echo "error: WEB_BIND/WEB_PORT not set in ${stack_env}" >&2
  exit 1
fi
base_url="http://${web_bind}:${web_port}"

# Read one KEY=value out of an env file WITHOUT letting the shell evaluate the
# value. This must never be `source`d: a real KSeF token contains "|" (its
# format is pipe-separated), which bash parses as a pipeline and then tries to
# execute the token's own segments as commands -- that both breaks the script
# and prints secret material into the terminal. The same applies to any value
# containing $, `, &, ;, (), or a newline continuation.
read_env_value() {
  local file="$1" key="$2" line value
  while IFS= read -r line || [[ -n "${line}" ]]; do
    [[ "${line}" =~ ^[[:space:]]*# ]] && continue
    [[ "${line}" == "${key}="* ]] || continue
    value="${line#"${key}"=}"
    # Strip one layer of matching surrounding quotes, as dotenv/Compose do.
    if [[ "${value}" == \"*\" && ${#value} -ge 2 ]]; then
      value="${value:1:${#value}-2}"
    elif [[ "${value}" == \'*\' && ${#value} -ge 2 ]]; then
      value="${value:1:${#value}-2}"
    fi
    printf '%s' "${value}"
    return 0
  done <"${file}"
  return 1
}

# The tenant's real credentials, held in local shell variables only: never
# echoed, never passed as a CLI arg, never exported into a child's argv.
AUTH_USERNAME="$(read_env_value "${secrets_env}" AUTH_USERNAME || true)"
AUTH_PASSWORD="$(read_env_value "${secrets_env}" AUTH_PASSWORD || true)"
if [[ -z "${AUTH_USERNAME}" || -z "${AUTH_PASSWORD}" ]]; then
  echo "error: AUTH_USERNAME/AUTH_PASSWORD not set in ${secrets_env}" >&2
  exit 1
fi

tmp_dir="$(mktemp -d)"
trap 'rm -rf "${tmp_dir}"' EXIT
login_body_file="${tmp_dir}/login-body.json"
login_resp_file="${tmp_dir}/login-resp.json"
invoices_resp_file="${tmp_dir}/invoices-resp.json"
health_resp_file="${tmp_dir}/health-resp.json"
( umask 077; : > "${login_body_file}" )

json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf '%s' "${s}"
}

overall_pass=true

report() {
  local name="$1" ok="$2" detail="$3"
  if [[ "${ok}" == "true" ]]; then
    echo "PASS: ${name}"
  else
    echo "FAIL: ${name} -- ${detail}"
    overall_pass=false
  fi
}

# 1. Health check.
health_code="$(curl -sS -o "${health_resp_file}" -w '%{http_code}' "${base_url}/api/health" || echo "000")"
if [[ "${health_code}" == "200" ]] && grep -q '"status"[[:space:]]*:[[:space:]]*"ok"' "${health_resp_file}"; then
  report "GET /api/health" true ""
else
  report "GET /api/health" false "http ${health_code}, body: $(cat "${health_resp_file}" 2>/dev/null || echo '<none>')"
fi

# 2. Login with the tenant's real credentials. The JSON body is written with
# printf (a shell builtin, no exec, so nothing appears in `ps`) into a 0600
# temp file, then sent via --data-binary @file so the password is never a
# literal in curl's own argv either.
printf '{"username":"%s","password":"%s"}' \
  "$(json_escape "${AUTH_USERNAME}")" "$(json_escape "${AUTH_PASSWORD}")" \
  > "${login_body_file}"

login_code="$(curl -sS -o "${login_resp_file}" -w '%{http_code}' \
  -X POST "${base_url}/api/auth/login" \
  -H "Content-Type: application/json" \
  --data-binary "@${login_body_file}" || echo "000")"

token=""
if [[ "${login_code}" == "200" ]]; then
  token="$(grep -o '"token"[[:space:]]*:[[:space:]]*"[^"]*"' "${login_resp_file}" | sed -E 's/.*:[[:space:]]*"([^"]*)"/\1/')"
fi

if [[ "${login_code}" == "200" && -n "${token}" ]]; then
  report "POST /api/auth/login" true ""
else
  report "POST /api/auth/login" false "http ${login_code} (response body withheld: may echo credential-adjacent error text)"
fi

# 3. One authenticated call with the returned JWT. Only status is asserted;
# invoice content depends on real tenant data and is out of scope here.
if [[ -n "${token}" ]]; then
  invoices_code="$(curl -sS -o "${invoices_resp_file}" -w '%{http_code}' \
    "${base_url}/api/invoices" \
    -H "Authorization: Bearer ${token}" || echo "000")"
  if [[ "${invoices_code}" == "200" ]]; then
    report "GET /api/invoices (authenticated)" true ""
  else
    report "GET /api/invoices (authenticated)" false "http ${invoices_code}"
  fi
else
  report "GET /api/invoices (authenticated)" false "skipped: no token from login step"
fi

echo "---"
if [[ "${overall_pass}" == "true" ]]; then
  echo "smoke.sh ${tenant}: ALL CHECKS PASSED"
  exit 0
else
  echo "smoke.sh ${tenant}: SOME CHECKS FAILED"
  exit 1
fi
