#!/usr/bin/env bash
# Validate the request path that ends at a database: OAuth/JWKS discovery ->
# (for a gated resource) the bearer gate -> a mariadb-mcp session -> a query
# against a named database.
#
# Only bare /db-tools (the default/legacy instance) is ungated. Every named
# instance from pillar mariadb-mcp:sources (e.g. /db-tools/staging-db-galera-prime)
# sits behind the same auth_request gate dbhub's /db-compare used to. Pass
# --gated for those; the default resource stays ungated unless you say so.
#
#   scripts/validate-mcp-path.sh --local                                   # default, ungated
#   scripts/validate-mcp-path.sh --local --resource staging-db-galera-prime --gated --token "$TOK"
#   scripts/validate-mcp-path.sh --local \
#     --resources db-tools,staging-db-galera-prime:gated --token "$TOK"    # both in one run
#
# Exit status is 0 only if every stage that ran passed. Skipped stages do not
# fail the run, but the summary says what was skipped so a green result cannot be
# mistaken for full coverage.
set -uo pipefail

RESOURCE="db-tools"
GATED=0
RESOURCES_ARG=""
BASE_URL="${MCP_BASE_URL:-${BASE_URL:-}}"
TOKEN="${MCP_TOKEN:-}"
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
                     service. The gate stage is reported SKIP (nothing to gate).
  --direct-mcp URL   mariadb-mcp endpoint, bypassing nginx (isolates the DB leg)
  --resource NAME    protected resource to check (default: db-tools)
  --gated            this resource sits behind auth_request (default instance
                     bare db-tools does not; every named source does)
  --resources LIST   comma-separated NAME or NAME:gated entries; validates all
                     of them in one run with one aggregated summary. Overrides
                     --resource/--gated.
  --token TOKEN|-    bearer token for a --gated resource; "-" reads one line
                     from stdin. Ignored for ungated resources.
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
    --gated) GATED=1; shift ;;
    --resources) RESOURCES_ARG="$2"; shift 2 ;;
    --token)
      if [ "$2" = "-" ]; then IFS= read -r TOKEN; else TOKEN="$2"; fi
      shift 2 ;;
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

# POST a JSON-RPC frame. Args: url body [token] [session]
mcp_post() {
  local url="$1" body="$2" token="${3:-}" session="${4:-}"
  local -a h=(-H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream')
  [ -n "$token" ] && h+=(-H "Authorization: Bearer $token")
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

# --- per-resource check ------------------------------------------------------
#
# Runs stages 1-4 against one resource. gated=1 adds the bearer-gate stage and
# threads $TOKEN through the MCP session; gated=0 matches bare /db-tools, which
# has no auth_request in front of it at all.
check_resource() {
  local resource="$1" gated="$2"
  # The bare default instance lives at /db-tools; every named source (which is
  # what "gated" always means here) lives at /db-tools/<name>. The resource
  # name itself (used for the allowlist file, X-MCP-Resource, and the
  # well-known document) stays short either way -- only the URL path differs.
  local path
  if [ "$resource" = "db-tools" ]; then path="db-tools"; else path="db-tools/${resource}"; fi

  printf '\n=== %s %s===\n' "$resource" "$([ "$gated" -eq 1 ] && echo '(gated) ')"

  # --- stage 1: discovery ----------------------------------------------------

  stage "1. OAuth metadata and JWKS"

  local code jwks_uri tok_ep n
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

  local res_claim
  code=$(http_get "${BASE_URL}/.well-known/oauth-protected-resource/${resource}")
  if [ "$code" = "200" ]; then
    res_claim=$(jq -r '.resource // empty' "$BODY" 2>/dev/null)
    if [ -n "$res_claim" ] && [ "${res_claim#"$EXPECT_BASE"}" != "$res_claim" ]; then
      ok "protected-resource metadata for ${resource} advertises ${res_claim}"
    else
      bad "protected-resource document advertises a different origin" \
          "document says '${res_claim}', expected it to start with '${EXPECT_BASE}' (--expect-resource-base overrides)"
    fi
  elif [ "$code" = "000" ]; then
    skip "protected-resource metadata: ${BASE_URL} unreachable"
  else
    bad "protected-resource metadata for ${resource} (HTTP $code)" \
        "served from the NGINX_WWW_DIR mount (build/nginx/www)"
  fi

  # --- stage 2: CORS preflight ------------------------------------------------

  stage "2. CORS preflight"

  local pre acao
  if [ $NO_NGINX -eq 1 ]; then
    skip "CORS preflight (--no-nginx: no nginx in front to add the headers)"
  else
    # Cheap proof that options_request's RELATIVE `include cors_headers;` resolved
    # inside the container. A missing mount fails nginx at start, but an empty
    # cors_headers fails silently and only breaks browser MCP clients.
    pre=$("${CURL[@]}" -o /dev/null -D "$HDRS" -w '%{http_code}' -X OPTIONS \
      -H 'Origin: https://claude.ai' -H 'Access-Control-Request-Method: POST' \
      "${BASE_URL}/${path}" 2>/dev/null)
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

  # --- stage 3: the gate is shut (gated resources only) -----------------------

  if [ "$gated" -eq 1 ]; then
    stage "3. Unauthenticated requests are refused"
    if [ $NO_NGINX -eq 1 ]; then
      skip "bearer gate (--no-nginx: talking to the backend directly, nothing to gate)"
    else
      local init_body chal chal_url
      init_body=$(rpc 1 initialize '{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"validate-mcp-path","version":"1"}}')
      code=$(mcp_post "${BASE_URL}/${path}" "$init_body")
      chal=""
      if [ "$code" = "000" ]; then
        skip "bearer gate: nginx not reachable at ${BASE_URL}"
      elif [ "$code" = "401" ]; then
        chal=$(header_value 'WWW-Authenticate')
        if printf '%s' "$chal" | grep -q 'resource_metadata='; then
          ok "no token -> 401 with resource_metadata challenge"
        else
          bad "no token -> 401 but challenge is unusable" "WWW-Authenticate: ${chal:-<absent>}"
        fi
      elif [ "$code" = "403" ]; then
        bad "no token -> 403" "expected 401 so clients get a challenge; 403 will not start an OAuth flow"
      else
        bad "no token -> HTTP $code" "the gate is not refusing unauthenticated requests to /${resource}"
      fi

      if [ -n "$chal" ]; then
        chal_url=$(printf '%s' "$chal" | sed -n 's/.*resource_metadata="\([^"]*\)".*/\1/p')
        if [ -z "$chal_url" ]; then
          bad "challenge carries no resource_metadata URL" "$chal"
        else
          code=$(http_get "$chal_url")
          if [ "$code" != "200" ]; then
            bad "challenge URL is not fetchable (HTTP $code)" "$chal_url"
          else
            ok "challenge URL resolves"
          fi
        fi
      fi
    fi
  fi

  # --- stage 4: MCP session ---------------------------------------------------

  stage "4. mariadb-mcp session"

  local mcp_url mcp_via token_for_call="" session="" tools_json=""
  if [ $NO_NGINX -eq 1 ] || [ $DIRECT_MCP_EXPLICIT -eq 1 ]; then
    mcp_url="$DIRECT_MCP"; mcp_via="direct, bypassing nginx"
  else
    mcp_url="${BASE_URL}/${path}"
    if [ "$gated" -eq 1 ]; then
      mcp_via="through nginx (gated)"
      token_for_call="$TOKEN"
    else
      mcp_via="through nginx (ungated)"
    fi
  fi

  if [ "$gated" -eq 1 ] && [ $NO_NGINX -eq 0 ] && [ $DIRECT_MCP_EXPLICIT -eq 0 ] && [ -z "$token_for_call" ]; then
    skip "MCP session (--gated needs --token to get past the gate)"
  elif [ -z "$mcp_url" ]; then
    skip "MCP session (no --direct-mcp and no --base-url resolved)"
  else
    printf '  (%s: %s)\n' "$mcp_via" "$mcp_url"
    local init_body body srv
    init_body=$(rpc 1 initialize '{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"validate-mcp-path","version":"1"}}')
    code=$(mcp_post "$mcp_url" "$init_body" "$token_for_call")
    body=$(mcp_json)
    if [ "$code" = "000" ]; then
      # Nothing listening. That is an environment fact, not a broken path.
      skip "MCP endpoint unreachable at $mcp_url"
    elif [ "$code" = "200" ] || [ "$code" = "202" ]; then
      session=$(header_value 'Mcp-Session-Id')
      srv=$(printf '%s' "$body" | jq -r '.result.serverInfo | "\(.name) \(.version)"' 2>/dev/null)
      ok "initialize -> ${srv:-ok}${session:+ (session ${session:0:8}…)}"
    elif [ "$code" = "401" ]; then
      bad "initialize -> 401" "signature/expiry/global allowlist rejected the token, or --gated is wrong for this resource"
    elif [ "$code" = "403" ]; then
      bad "initialize -> 403" "token verified but this address is not in allowed_emails_${resource}.txt"
    else
      bad "initialize -> HTTP $code" "$(printf '%s' "$body" | head -c 200)"
    fi

    if [ -n "$session" ] || [ "$code" = "200" ]; then
      mcp_post "$mcp_url" '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}' "$token_for_call" "$session" >/dev/null
      code=$(mcp_post "$mcp_url" "$(rpc 2 tools/list '{}')" "$token_for_call" "$session")
      body=$(mcp_json)
      if [ "$code" = "200" ]; then
        tools_json="$body"
        local names n
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

  # --- stage 5: query ----------------------------------------------------

  stage "5. Query reaches the configured database"

  if [ -z "$tools_json" ]; then
    skip "database query (no MCP session)"
  else
    local db="$DATABASE" body
    if [ -z "$db" ]; then
      code=$(mcp_post "$mcp_url" "$(rpc 3 tools/call '{"name":"list_databases","arguments":{}}')" "$token_for_call" "$session")
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
      local args
      args=$(jq -nc --arg sql "$SQL" --arg db "$db" '{sql_query: $sql, database_name: $db}')
      code=$(mcp_post "$mcp_url" "$(rpc 4 tools/call "$(jq -nc --argjson a "$args" '{name:"execute_sql",arguments:$a}')")" "$token_for_call" "$session")
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
}

# --- run ---------------------------------------------------------------

printf 'Target      : %s\n' "$BASE_URL"
[ -n "$DIRECT_MCP" ] && printf 'Direct MCP  : %s\n' "$DIRECT_MCP"
if [ -n "$TOKEN" ]; then
  printf 'Token       : present\n'
else
  printf 'Token       : none -- gated resources will be skipped at the MCP-session stage\n'
fi

declare -a run_list=()
if [ -n "$RESOURCES_ARG" ]; then
  IFS=',' read -ra entries <<< "$RESOURCES_ARG"
  for e in "${entries[@]}"; do
    if [ "${e##*:}" = "gated" ]; then
      run_list+=("${e%%:*}:1")
    else
      run_list+=("${e}:0")
    fi
  done
else
  run_list=("${RESOURCE}:${GATED}")
fi

for entry in "${run_list[@]}"; do
  check_resource "${entry%%:*}" "${entry##*:}"
done

# --- summary ---------------------------------------------------------------

printf '\n%s\n' "----------------------------------------"
printf 'passed %s  failed %s  skipped %s\n' "$PASS" "$FAIL" "$SKIP"
if [ ${#NOTES[@]} -gt 0 ]; then
  printf 'not covered by this run:\n'
  printf '  - %s\n' "${NOTES[@]}"
fi
[ "$FAIL" -eq 0 ] || exit 1
