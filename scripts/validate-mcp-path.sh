#!/usr/bin/env bash
# Validate the request path that ends at a database: OAuth/JWKS discovery ->
# mariadb-mcp MCP session -> a query against a named database.
#
# /db-tools (mariadb-mcp) is NOT behind an nginx auth_request gate -- there is no
# bearer-token leg on this path, unlike the old dbhub/db-compare setup this
# script used to validate. This proves discovery, CORS, and the MCP/DB leg work;
# it does not prove anything is authenticated, because nothing here is.
#
#   scripts/validate-mcp-path.sh --local
#   scripts/validate-mcp-path.sh --base-url https://auth.staging.bondlink.org
#
# Exit status is 0 only if every stage that ran passed. Skipped stages do not
# fail the run, but the summary says what was skipped so a green result cannot be
# mistaken for full coverage.
set -uo pipefail

RESOURCE="db-tools"
BASE_URL="${MCP_BASE_URL:-${BASE_URL:-}}"
DIRECT_MCP=""
DIRECT_MCP_EXPLICIT=0
SQL="SELECT 1"
DATABASE=""
INSECURE=0
LOCAL=0
NO_NGINX=0
EXPECT_BASE=""

usage() {
  # Sentinel, not a hardcoded line count: the header above grows, and a fixed
  # range silently truncates the help or spills shell code into it.
  sed -n '2,/^set -uo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'
  cat <<'EOF'

Options:
  --base-url URL     nginx entry point (default: $MCP_BASE_URL, $BASE_URL)
  --local            the docker-compose layout: nginx on :8888, the same entry
                     point staging uses, plus mariadb-mcp on :9001 for
                     --direct-mcp.
  --no-nginx         pre-nginx behaviour: headless-ts on :3000 and mariadb-mcp on
                     :9001 directly. For a stack running without the nginx
                     service.
  --direct-mcp URL   mariadb-mcp endpoint, bypassing nginx (isolates the DB leg)
  --resource NAME    protected-resource document to check (default: db-tools)
  --database NAME    database to query (default: first result of list_databases)
  --sql SQL          statement for the final stage (default: SELECT 1)
  --expect-resource-base URL
                     origin the protected-resource document should advertise
                     (default: the base URL). Set this when the stack serves
                     documents for a different origin than it is reached on.
  --insecure         pass -k to curl (self-signed certs)
  -h, --help         this text
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --base-url) BASE_URL="$2"; shift 2 ;;
    --direct-mcp) DIRECT_MCP="$2"; DIRECT_MCP_EXPLICIT=1; shift 2 ;;
    --resource) RESOURCE="$2"; shift 2 ;;
    --database) DATABASE="$2"; shift 2 ;;
    --sql) SQL="$2"; shift 2 ;;
    --expect-resource-base) EXPECT_BASE="$2"; shift 2 ;;
    --insecure) INSECURE=1; shift ;;
    --local) LOCAL=1; shift ;;
    --no-nginx) NO_NGINX=1; LOCAL=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [ $NO_NGINX -eq 1 ]; then
  # Pre-nginx layout: straight at the app and mariadb-mcp, no gate in between
  # either way.
  : "${BASE_URL:=http://localhost:3000}"
  : "${DIRECT_MCP:=http://localhost:9001/mcp}"
elif [ $LOCAL -eq 1 ]; then
  # nginx serves :8888 in compose, so --local exercises the same entry point
  # staging uses.
  : "${BASE_URL:=http://localhost:8888}"
  : "${DIRECT_MCP:=http://localhost:9001/mcp}"
fi
: "${BASE_URL:=http://localhost:8888}"
: "${EXPECT_BASE:=${BASE_URL}}"

CURL=(curl -sS --max-time 20)
[ $INSECURE -eq 1 ] && CURL+=(-k)

for bin in curl jq; do
  command -v "$bin" >/dev/null 2>&1 || { echo "error: $bin is required" >&2; exit 2; }
done

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
HDRS="$TMP/h"
BODY="$TMP/b"

PASS=0
FAIL=0
SKIP=0
declare -a NOTES=()

# Colour only for a terminal: this is meant to be runnable from CI and from a
# deploy script, where escape codes just corrupt the log.
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  green() { printf '\033[32m%s\033[0m' "$1"; }
  red() { printf '\033[31m%s\033[0m' "$1"; }
  yellow() { printf '\033[33m%s\033[0m' "$1"; }
else
  green() { printf '%s' "$1"; }
  red() { printf '%s' "$1"; }
  yellow() { printf '%s' "$1"; }
fi

ok()   { PASS=$((PASS + 1)); printf '  [%s] %s\n' "$(green PASS)" "$1"; }
bad()  { FAIL=$((FAIL + 1)); printf '  [%s] %s\n' "$(red FAIL)" "$1"; [ $# -gt 1 ] && printf '         %s\n' "$2"; }
skip() { SKIP=$((SKIP + 1)); printf '  [%s] %s\n' "$(yellow SKIP)" "$1"; NOTES+=("$1"); }
stage() { printf '\n%s\n' "$1"; }

# --- helpers ---------------------------------------------------------------

# curl writes neither -o nor -D when it cannot connect at all, so clear both
# first: otherwise the reader below reports the *previous* request's body.
reset_capture() { : > "$BODY"; : > "$HDRS"; }

http_get() { reset_capture; "${CURL[@]}" -D "$HDRS" -o "$BODY" -w '%{http_code}' "$1"; }

# POST a JSON-RPC frame. Args: url body [session]
mcp_post() {
  local url="$1" body="$2" session="${3:-}"
  local -a h=(-H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream')
  [ -n "$session" ] && h+=(-H "Mcp-Session-Id: $session")
  reset_capture
  "${CURL[@]}" -D "$HDRS" -o "$BODY" -w '%{http_code}' -X POST "${h[@]}" --data "$body" "$url"
}

# Streamable HTTP may answer as a single JSON object or as SSE frames; take the
# first data: frame in the SSE case so callers always get plain JSON.
mcp_json() {
  if grep -q '^data: ' "$BODY" 2>/dev/null; then
    sed -n 's/^data: //p' "$BODY" | head -1
  else
    cat "$BODY"
  fi
}

header_value() { grep -i "^$1:" "$HDRS" 2>/dev/null | tail -1 | cut -d: -f2- | tr -d '\r' | sed 's/^ *//'; }

rpc() { printf '{"jsonrpc":"2.0","id":%s,"method":"%s","params":%s}' "$1" "$2" "$3"; }

printf 'Target      : %s\n' "$BASE_URL"
printf 'Resource    : %s\n' "$RESOURCE"
[ -n "$DIRECT_MCP" ] && printf 'Direct MCP  : %s\n' "$DIRECT_MCP"

# --- stage 1: discovery ----------------------------------------------------

stage "1. OAuth metadata and JWKS"

code=$(http_get "${BASE_URL}/.well-known/oauth-authorization-server")
if [ "$code" = "200" ]; then
  jwks_uri=$(jq -r '.jwks_uri // empty' "$BODY" 2>/dev/null)
  tok_ep=$(jq -r '.token_endpoint // empty' "$BODY" 2>/dev/null)
  if [ -n "$jwks_uri" ] && [ -n "$tok_ep" ]; then
    ok "authorization-server metadata (token_endpoint, jwks_uri present)"
  else
    bad "authorization-server metadata incomplete" "jwks_uri='${jwks_uri}' token_endpoint='${tok_ep}'"
  fi
  if [ -n "$jwks_uri" ]; then
    # Print it: the discovery document comes from Hydra's configured issuer, so
    # a stack whose hydra.yml still names staging sends this check off-box. A
    # "local" run can otherwise pass by testing staging's JWKS.
    printf '         jwks_uri: %s\n' "$jwks_uri"
    code=$(http_get "$jwks_uri")
    n=$(jq -r '.keys | length' "$BODY" 2>/dev/null || echo 0)
    if [ "$code" = "200" ] && [ "${n:-0}" -gt 0 ]; then
      ok "JWKS reachable with $n key(s)"
    else
      bad "JWKS not usable (HTTP $code, ${n:-0} keys)" "$jwks_uri"
    fi
  fi
elif [ "$code" = "000" ]; then
  skip "OAuth metadata: nothing reachable at ${BASE_URL} (docker compose ps nginx)"
else
  bad "authorization-server metadata (HTTP $code)" "${BASE_URL}/.well-known/oauth-authorization-server"
fi

code=$(http_get "${BASE_URL}/.well-known/oauth-protected-resource/${RESOURCE}")
if [ "$code" = "200" ]; then
  res_claim=$(jq -r '.resource // empty' "$BODY" 2>/dev/null)
  if [ -n "$res_claim" ] && [ "${res_claim#"$EXPECT_BASE"}" != "$res_claim" ]; then
    ok "protected-resource metadata for ${RESOURCE} advertises ${res_claim}"
  else
    bad "protected-resource document advertises a different origin" \
        "document says '${res_claim}', expected it to start with '${EXPECT_BASE}' (--expect-resource-base overrides)"
  fi
elif [ "$code" = "000" ]; then
  skip "protected-resource metadata: ${BASE_URL} unreachable"
else
  bad "protected-resource metadata for ${RESOURCE} (HTTP $code)" \
      "served from the NGINX_WWW_DIR mount (build/nginx/www); this document exists even though /db-tools itself is not gated"
fi

# --- stage 2: CORS preflight ------------------------------------------------

stage "2. CORS preflight"

if [ $NO_NGINX -eq 1 ]; then
  skip "CORS preflight (--no-nginx: no nginx in front to add the headers)"
else
  # Cheap proof that options_request's RELATIVE `include cors_headers;` resolved
  # inside the container. A missing mount fails nginx at start, but an empty
  # cors_headers fails silently and only breaks browser MCP clients.
  pre=$("${CURL[@]}" -o /dev/null -D "$HDRS" -w '%{http_code}' -X OPTIONS \
    -H 'Origin: https://claude.ai' -H 'Access-Control-Request-Method: POST' \
    "${BASE_URL}/${RESOURCE}" 2>/dev/null)
  acao=$(header_value 'Access-Control-Allow-Origin')
  if [ "$pre" = "204" ] && [ -n "$acao" ]; then
    ok "CORS preflight -> 204 with Access-Control-Allow-Origin"
  elif [ "$pre" = "000" ]; then
    skip "CORS preflight: ${BASE_URL} unreachable"
  else
    bad "CORS preflight -> HTTP $pre, Allow-Origin '${acao:-<absent>}'" \
        "expected 204 + the header; check the cors_headers/options_request mounts"
  fi
fi

# --- stage 3: MCP session ---------------------------------------------------

stage "3. mariadb-mcp session"

MCP_URL=""
MCP_VIA=""
if [ $NO_NGINX -eq 1 ] || [ $DIRECT_MCP_EXPLICIT -eq 1 ]; then
  MCP_URL="$DIRECT_MCP"; MCP_VIA="direct, bypassing nginx"
else
  MCP_URL="${BASE_URL}/${RESOURCE}"; MCP_VIA="through nginx (ungated)"
fi

SESSION=""
TOOLS_JSON=""
if [ -z "$MCP_URL" ]; then
  skip "MCP session (no --direct-mcp and no --base-url resolved)"
else
  printf '  (%s: %s)\n' "$MCP_VIA" "$MCP_URL"
  init_body=$(rpc 1 initialize '{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"validate-mcp-path","version":"1"}}')
  code=$(mcp_post "$MCP_URL" "$init_body")
  body=$(mcp_json)
  if [ "$code" = "000" ]; then
    # Nothing listening. That is an environment fact, not a broken path.
    skip "MCP endpoint unreachable at $MCP_URL"
  elif [ "$code" = "200" ] || [ "$code" = "202" ]; then
    SESSION=$(header_value 'Mcp-Session-Id')
    srv=$(printf '%s' "$body" | jq -r '.result.serverInfo | "\(.name) \(.version)"' 2>/dev/null)
    ok "initialize -> ${srv:-ok}${SESSION:+ (session ${SESSION:0:8}…)}"
  else
    bad "initialize -> HTTP $code" "$(printf '%s' "$body" | head -c 200)"
  fi

  if [ -n "$SESSION" ] || [ "$code" = "200" ]; then
    mcp_post "$MCP_URL" '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}' "$SESSION" >/dev/null
    code=$(mcp_post "$MCP_URL" "$(rpc 2 tools/list '{}')" "$SESSION")
    body=$(mcp_json)
    if [ "$code" = "200" ]; then
      TOOLS_JSON="$body"
      names=$(printf '%s' "$body" | jq -r '.result.tools[]?.name' 2>/dev/null)
      n=$(printf '%s' "$names" | grep -c . || true)
      if printf '%s' "$names" | grep -qx 'execute_sql'; then
        ok "tools/list -> $n tool(s), including execute_sql"
        printf '%s' "$names" | sed 's/^/         /'
      else
        bad "tools/list returned no execute_sql tool" \
            "advertised: $(printf '%s' "$names" | paste -sd, - 2>/dev/null || printf '%s' "$names")"
      fi
    else
      bad "tools/list -> HTTP $code" "$(printf '%s' "$body" | head -c 200)"
    fi
  fi
fi

# --- stage 4: query ----------------------------------------------------

stage "4. Query reaches the configured database"

if [ -z "$TOOLS_JSON" ]; then
  skip "database query (no MCP session)"
else
  db="$DATABASE"
  if [ -z "$db" ]; then
    code=$(mcp_post "$MCP_URL" "$(rpc 3 tools/call '{"name":"list_databases","arguments":{}}')" "$SESSION")
    body=$(mcp_json)
    if [ "$code" = "200" ] && ! printf '%s' "$body" | jq -e '.result.isError == true' >/dev/null 2>&1; then
      # list_databases returns a JSON array as the tool result's text content.
      db=$(printf '%s' "$body" | jq -r '.result.content[0].text' 2>/dev/null | jq -r '.[0] // empty' 2>/dev/null)
    fi
    if [ -z "$db" ]; then
      bad "no --database given and list_databases returned nothing usable" \
          "$(printf '%s' "$body" | head -c 200)"
    else
      printf '         using database from list_databases: %s\n' "$db"
    fi
  fi

  if [ -n "$db" ]; then
    args=$(jq -nc --arg sql "$SQL" --arg db "$db" '{sql_query: $sql, database_name: $db}')
    code=$(mcp_post "$MCP_URL" "$(rpc 4 tools/call "$(jq -nc --argjson a "$args" '{name:"execute_sql",arguments:$a}')")" "$SESSION")
    body=$(mcp_json)
    if [ "$code" != "200" ]; then
      bad "execute_sql -> HTTP $code" "$(printf '%s' "$body" | head -c 200)"
    elif printf '%s' "$body" | jq -e '.result.isError == true' >/dev/null 2>&1; then
      # A tool-level error is the interesting failure: transport worked, so this
      # is mariadb-mcp -> MariaDB (bad host, credentials, grants, or database name).
      bad "execute_sql executed but returned an error" \
          "$(printf '%s' "$body" | jq -r '.result.content[]?.text' 2>/dev/null | head -c 300)"
    elif printf '%s' "$body" | jq -e '.error' >/dev/null 2>&1; then
      bad "execute_sql -> JSON-RPC error" "$(printf '%s' "$body" | jq -c '.error' | head -c 300)"
    else
      ok "execute_sql ran '${SQL}' against ${db}"
      printf '%s' "$body" | jq -r '.result.content[]?.text' 2>/dev/null | head -5 | sed 's/^/         /'
    fi
  fi
fi

# --- summary ---------------------------------------------------------------

printf '\n%s\n' "----------------------------------------"
printf 'passed %s  failed %s  skipped %s\n' "$PASS" "$FAIL" "$SKIP"
if [ ${#NOTES[@]} -gt 0 ]; then
  printf 'not covered by this run:\n'
  printf '  - %s\n' "${NOTES[@]}"
fi
[ "$FAIL" -eq 0 ] || exit 1
