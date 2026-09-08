#!/usr/bin/env bash
# Register the OAuth2 client in Hydra and print how to wire AUTH_FLOW_CLIENT_ID
# in for it.
#
# Works against either a local dev checkout or a deployed host managed by
# /etc/init.d/hydra-mcp -- scripts/compose-env.sh auto-detects which compose
# files/project this host is actually running under, and which of the two
# this is drives both BASE_URL's default and the follow-up instructions below:
# a deployed host's /etc/hydra-headless-ts/hydra.env is rendered by Salt from
# pillar (pillar/<env>/oauth's dcr_client_id), NOT a symlink to local.env the
# way a local dev checkout's is -- editing local.env there does nothing.
#
# Run once per Hydra database. `compose down -v` (or a fresh postgres volume)
# drops the client, and the symptom is an opaque "client not found" during
# login -- so re-run this after any volume reset.
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

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
source "${SCRIPT_DIR}/compose-env.sh"

INSPECTOR="${INSPECTOR_URL:-http://localhost:6274}"

command -v docker >/dev/null 2>&1 || { echo "error: docker is required" >&2; exit 2; }

if [ -z "${BASE_URL:-}" ]; then
  if [ "$DEPLOYED" = "1" ]; then
    # Authoritative for this host: what Salt actually rendered into hydra.env,
    # not a guess -- a deployed host's real BASE_URL varies per environment
    # (e.g. https://oauth.prod.bondlink.org) and is never localhost.
    BASE_URL="$(sed -n 's/^BASE_URL=//p' /etc/hydra-headless-ts/hydra.env 2>/dev/null | head -1)"
    if [ -z "$BASE_URL" ]; then
      echo "error: could not read BASE_URL from /etc/hydra-headless-ts/hydra.env; pass BASE_URL=... explicitly" >&2
      exit 1
    fi
  else
    BASE_URL="http://localhost:8888"
  fi
fi

if ! compose ps --status running --services 2>/dev/null | grep -qx hydra; then
  echo "error: the 'hydra' service is not running. Start it first:" >&2
  echo "  $DOCKER_CMD compose $COMPOSE_ARGS_STR up -d postgres hydra" >&2
  exit 1
fi

echo "Registering an OAuth2 client for ${BASE_URL} ..."

# Shape matches the client documented in AUTH_FLOW.md: public client (no secret),
# authorization_code + refresh_token, skip_consent/skip_login left at false so the
# normal Hydra consent flow runs.
out=$(compose exec -T hydra hydra create client \
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

  AUTH_FLOW_CLIENT_ID=${client_id}

EOF

if [ "$DEPLOYED" = "1" ]; then
  cat <<EOF
This host's /etc/hydra-headless-ts/hydra.env is rendered by Salt from pillar
(pillar/${COMPOSE_ENV}/oauth/init.sls's dcr_client_id) -- editing
/etc/hydra-headless-ts/local.env has no effect here.

Durable fix: set pillar/${COMPOSE_ENV}/oauth/init.sls's dcr_client_id to the
AUTH_FLOW_CLIENT_ID above (in the salt repo), then re-apply the
hydra-headless-ts state so hydra.env gets re-rendered.

Immediate stopgap (the next salt highstate will overwrite it): set
AUTH_FLOW_CLIENT_ID directly in /etc/hydra-headless-ts/hydra.env, then:

  $DOCKER_CMD compose $COMPOSE_ARGS_STR restart headless-ts
EOF
else
  cat <<EOF
Put the AUTH_FLOW_CLIENT_ID above in /etc/hydra-headless-ts/local.env, then
restart the app:

  $DOCKER_CMD compose $COMPOSE_ARGS_STR restart headless-ts
EOF
fi

cat <<EOF

Verify with:
  $DOCKER_CMD compose $COMPOSE_ARGS_STR exec -T headless-ts npm run cli:env -- list-clients
EOF
