#!/usr/bin/env bash
# Register the local OAuth2 client in Hydra and print the line to paste into
# /etc/hydra-headless-ts/local.env.
#
# Run once per Hydra database. `docker compose down -v` drops the postgres
# volume and therefore the client, and the symptom is an opaque
# "client not found" during login -- so re-run this after any volume reset.
#
# Why the hydra CLI inside the container rather than the repo's own tooling:
#
#   scripts/oauth2-client-meta.sh is marked DEPRECATED in its own header, and its
#   Darwin branch builds ISSUER/CALLBACK_HOST from a hardcoded
#   COOKIE_DOMAIN="domain.tld" plus `ipconfig getifaddr en0` -- neither matches
#   this setup.
#
#   `npm run cli -- new-client` reads --env-file=./src/env/local.env (see
#   package.json), NOT /etc/hydra-headless-ts, so it registers against whatever
#   placeholder host that file names.
set -uo pipefail

BASE_URL="${BASE_URL:-http://localhost:8888}"
INSPECTOR="${INSPECTOR_URL:-http://localhost:6274}"

command -v docker >/dev/null 2>&1 || { echo "error: docker is required" >&2; exit 2; }

if ! docker compose ps --status running --services 2>/dev/null | grep -qx hydra; then
  echo "error: the 'hydra' service is not running. Start it first:" >&2
  echo "  docker compose up -d postgres hydra" >&2
  exit 1
fi

echo "Registering an OAuth2 client for ${BASE_URL} ..."

# Shape matches the client documented in AUTH_FLOW.md: public client (no secret),
# authorization_code + refresh_token, skip_consent/skip_login left at false so the
# normal Hydra consent flow runs.
out=$(docker compose exec -T hydra hydra create client \
  --endpoint http://127.0.0.1:4445 \
  --grant-type authorization_code,refresh_token \
  --response-type code,id_token \
  --token-endpoint-auth-method none \
  --scope openid,email,profile,offline_access \
  --redirect-uri "${BASE_URL}/callback,https://claude.ai/api/mcp/auth_callback,${INSPECTOR}/oauth/callback" \
  --format json 2>&1)

if [ $? -ne 0 ] || ! printf '%s' "$out" | jq -e .client_id >/dev/null 2>&1; then
  echo "error: client creation failed:" >&2
  printf '%s\n' "$out" >&2
  exit 1
fi

client_id=$(printf '%s' "$out" | jq -r .client_id)
printf '%s' "$out" | jq '{client_id, grant_types, response_types, scope, redirect_uris, token_endpoint_auth_method}'

cat <<EOF

Put this in /etc/hydra-headless-ts/local.env, then restart the app:

  AUTH_FLOW_CLIENT_ID=${client_id}

  docker compose restart headless-ts

Verify with:  npm run cli -- list-clients
EOF
