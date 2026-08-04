#!/usr/bin/env bash
# Validate the request path that ends at a database: OAuth metadata -> nginx
# bearer gate -> /authz decision -> DBHub MCP -> configured MariaDB source.
#
# This checks that the path *works and that the gate is shut*. It does not
# obtain a token for you and has no way to skip authentication: every
# authenticated stage needs a token you already hold, and stages that cannot run
# without one report SKIP rather than working around it. The one negative test
# here (stage 2) exists to prove unauthenticated requests are refused.
#
#   scripts/validate-mcp-path.sh --local
#   scripts/validate-mcp-path.sh --base-url https://auth.staging.bondlink.org --token "$TOK"
#   MCP_TOKEN=$TOK scripts/validate-mcp-path.sh --base-url https://auth.prod.bondlink.org
#
# Getting a token: it is whatever your MCP client already presents as the bearer.
# With JWT_PROVIDER=google that is the Google ID token from the normal browser
# flow -- copy it out of the client's stored credentials, or off the
# Authorization header of a working request. `--token -` reads it from stdin so
# it never lands in your shell history or in `ps`.
#
# Exit status is 0 only if every stage that ran passed. Skipped stages do not
# fail the run, but the summary says what was skipped so a green result cannot be
# mistaken for full coverage.
set -uo pipefail

RESOURCE="db-compare"
BASE_URL="${MCP_BASE_URL:-${BASE_URL:-}}"
TOKEN="${MCP_TOKEN:-}"
DIRECT_MCP=""
AUTHZ_URL=""
SQL="SELECT 1"
SOURCE=""
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
                     point staging uses, plus DBHub on :9002 for --direct-mcp.
  --no-nginx         pre-nginx behaviour: headless-ts on :3000 and DBHub on
                     :9002 directly, gate stage reported SKIP. For a stack
                     running without the nginx service.
  --token TOKEN|-    bearer token; "-" reads one line from stdin
  --direct-mcp URL   DBHub MCP endpoint, bypassing nginx (isolates the DB leg)
  --authz-url URL    /authz endpoint (default: <base-url>/authz)
  --resource NAME    protected resource name (default: db-compare)
  --source NAME      DBHub source id to query (default: first execute_sql_* tool)
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
    --token)
      if [ "$2" = "-" ]; then IFS= read -r TOKEN; else TOKEN="$2"; fi
      shift 2 ;;
    --direct-mcp) DIRECT_MCP="$2"; shift 2 ;;
    --authz-url) AUTHZ_URL="$2"; shift 2 ;;
    --resource) RESOURCE="$2"; shift 2 ;;
    --source) SOURCE="$2"; shift 2 ;;
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
  # Pre-nginx layout: straight at the app and DBHub, no gate in between.
  : "${BASE_URL:=http://localhost:3000}"
  : "${AUTHZ_URL:=http://localhost:3000/authz}"
  : "${DIRECT_MCP:=http://localhost:9002/mcp}"
elif [ $LOCAL -eq 1 ]; then
  # nginx serves :8888 in compose, so --local now exercises the same entry point
  # and the same gate as a deployed host. /authz is reachable through it because
  # the conf's `~ ^/(consent|logout|auth|callback|oauth2)` regex is unanchored on
  # the right, so /authz matches ^/auth.
  : "${BASE_URL:=http://localhost:8888}"
  : "${DIRECT_MCP:=http://localhost:9002/mcp}"
fi
: "${BASE_URL:=http://localhost:8888}"
: "${AUTHZ_URL:=${BASE_URL}/authz}"
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

# Decode a JWT segment. Padding is re-added because base64url strips it.
b64url() {
  local d="$1" pad
  pad=$(( (4 - ${#d} % 4) % 4 ))
  [ $pad -ne 0 ] && d="${d}$(printf '=%.0s' $(seq 1 $pad))"
  printf '%s' "$d" | tr '_-' '/+' | base64 -d 2>/dev/null
}

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

printf 'Target      : %s\n' "$BASE_URL"
printf 'Resource    : %s\n' "$RESOURCE"
printf 'Authz       : %s\n' "$AUTHZ_URL"
[ -n "$DIRECT_MCP" ] && printf 'Direct MCP  : %s\n' "$DIRECT_MCP"

# Report who the token is for without echoing the token itself.
if [ -n "$TOKEN" ]; then
  claims=$(b64url "$(printf '%s' "$TOKEN" | cut -d. -f2)")
  if [ -n "$claims" ] && printf '%s' "$claims" | jq -e . >/dev/null 2>&1; then
    exp=$(printf '%s' "$claims" | jq -r '.exp // empty')
    now=$(date +%s)
    left="unknown"
    [ -n "$exp" ] && left="$(( (exp - now) / 60 ))m"
    printf 'Token       : %s (aud=%s, expires in %s)\n' \
      "$(printf '%s' "$claims" | jq -r '.email // .sub // "no email claim"')" \
      "$(printf '%s' "$claims" | jq -r 'if (.aud|type)=="array" then .aud[0] else (.aud // "?") end')" "$left"
    if [ -n "$exp" ] && [ "$exp" -lt "$now" ]; then
      printf '              %s\n' "$(red 'token is expired — authenticated stages will fail')"
    fi
  else
    printf 'Token       : present (not a decodable JWT)\n'
  fi
else
  printf 'Token       : none — authenticated stages will be skipped\n'
fi

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
  ok "protected-resource metadata for ${RESOURCE}"
elif [ "$code" = "000" ]; then
  skip "protected-resource metadata: ${BASE_URL} unreachable"
else
  bad "protected-resource metadata for ${RESOURCE} (HTTP $code)" \
      "an MCP client reads this from the WWW-Authenticate challenge to find where to log in; \
served from the NGINX_WWW_DIR mount (build/nginx/www)"
fi

# --- stage 2: the gate is shut --------------------------------------------

stage "2. Unauthenticated requests are refused"

if [ $NO_NGINX -eq 1 ]; then
  skip "bearer gate (--no-nginx: talking to the backends directly, nothing to gate)"
else
  init_body=$(rpc 1 initialize '{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"validate-mcp-path","version":"1"}}')
  code=$(mcp_post "${BASE_URL}/${RESOURCE}" "$init_body")
  chal=""
  if [ "$code" = "000" ]; then
    skip "bearer gate: nginx not reachable at ${BASE_URL} (docker compose ps nginx)"
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
    bad "no token -> HTTP $code" "$(red 'the gate is not refusing unauthenticated requests to /'"${RESOURCE}")"
  fi

  # Follow the challenge. A syntactically fine header pointing at an unfetchable
  # URL fails an MCP client before the OAuth flow starts, and the symptom lands
  # inside the client where it never mentions nginx. This is what catches a
  # hardcoded scheme or a dropped port in the resource_metadata value.
  if [ -n "$chal" ]; then
    chal_url=$(printf '%s' "$chal" | sed -n 's/.*resource_metadata="\([^"]*\)".*/\1/p')
    if [ -z "$chal_url" ]; then
      bad "challenge carries no resource_metadata URL" "$chal"
    else
      code=$(http_get "$chal_url")
      res_claim=$(jq -r '.resource // empty' "$BODY" 2>/dev/null)
      if [ "$code" != "200" ]; then
        bad "challenge URL is not fetchable (HTTP $code)" \
            "$chal_url — an MCP client follows this first and stops here"
      elif [ -z "$res_claim" ]; then
        bad "challenge URL returned no .resource" "$chal_url"
      elif [ "${res_claim#"$EXPECT_BASE"}" = "$res_claim" ]; then
        bad "protected-resource document advertises a different origin" \
            "document says '${res_claim}', expected it to start with '${EXPECT_BASE}' (--expect-resource-base overrides)"
      else
        ok "challenge URL resolves and advertises ${res_claim}"
      fi
    fi
  fi

  if [ "$code" != "000" ]; then
    code=$(mcp_post "${BASE_URL}/${RESOURCE}" "$init_body" "not.a.token")
    if [ "$code" = "401" ]; then
      ok "malformed token -> 401"
    else
      bad "malformed token -> HTTP $code" "expected 401"
    fi

    # Cheap proof that options_request's RELATIVE `include cors_headers;`
    # resolved inside the container. A missing mount fails nginx at start, but an
    # empty cors_headers fails silently and only breaks browser MCP clients.
    pre=$("${CURL[@]}" -o /dev/null -D "$HDRS" -w '%{http_code}' -X OPTIONS \
      -H 'Origin: https://claude.ai' -H 'Access-Control-Request-Method: POST' \
      "${BASE_URL}/${RESOURCE}" 2>/dev/null)
    acao=$(header_value 'Access-Control-Allow-Origin')
    if [ "$pre" = "204" ] && [ -n "$acao" ]; then
      ok "CORS preflight -> 204 with Access-Control-Allow-Origin"
    else
      bad "CORS preflight -> HTTP $pre, Allow-Origin '${acao:-<absent>}'" \
          "expected 204 + the header; check the cors_headers/options_request mounts"
    fi
  fi
fi

# --- stage 3: the authz decision ------------------------------------------

stage "3. /authz decision endpoint"

authz() {
  local -a h=()
  [ -n "${2:-}" ] && h+=(-H "X-MCP-Resource: $2")
  [ -n "${1:-}" ] && h+=(-H "Authorization: Bearer $1")
  "${CURL[@]}" -o /dev/null -w '%{http_code}' -X POST "${h[@]}" "$AUTHZ_URL"
}

code=$(authz "" "$RESOURCE")
case "$code" in
  401) ok "no bearer -> 401" ;;
  000) skip "/authz unreachable at $AUTHZ_URL" ;;
  *)   bad "no bearer -> HTTP $code" "expected 401" ;;
esac

code=$(authz "" "")
case "$code" in
  403) ok "missing X-MCP-Resource -> 403 (refuses to guess an allowlist)" ;;
  000) skip "/authz unreachable at $AUTHZ_URL" ;;
  *)   bad "missing X-MCP-Resource -> HTTP $code" "expected 403" ;;
esac

if [ -n "$TOKEN" ]; then
  code=$(authz "$TOKEN" "$RESOURCE")
  case "$code" in
    204) ok "valid token on ${RESOURCE} allowlist -> 204" ;;
    401) bad "valid token -> 401" "signature/expiry/global allowlist rejected it; try: npm run validate-token -- \$TOKEN" ;;
    403) bad "valid token -> 403" "token verified but this address is not in allowed_emails_${RESOURCE}.txt" ;;
    000) skip "/authz unreachable at $AUTHZ_URL" ;;
    *)   bad "valid token -> HTTP $code" "expected 204" ;;
  esac
else
  skip "authorized /authz decision (no token)"
fi

# --- stage 4: MCP session --------------------------------------------------

stage "4. DBHub MCP session"

MCP_URL=""
MCP_VIA=""
# With a token, go through nginx even locally -- exercising the proxied path is
# the point of having the gate in compose. --direct-mcp is the fallback, and
# still the way to isolate DBHub->DB from the gate.
if [ -n "$TOKEN" ] && [ $NO_NGINX -eq 0 ]; then
  MCP_URL="${BASE_URL}/${RESOURCE}"; MCP_VIA="through nginx"
elif [ -n "$DIRECT_MCP" ]; then
  MCP_URL="$DIRECT_MCP"; MCP_VIA="direct, bypassing the gate"
fi

SESSION=""
TOOLS_JSON=""
if [ -z "$MCP_URL" ]; then
  skip "MCP session (needs --token for the proxied path, or --direct-mcp for the DB leg alone)"
else
  printf '  (%s: %s)\n' "$MCP_VIA" "$MCP_URL"
  init_body=$(rpc 1 initialize '{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"validate-mcp-path","version":"1"}}')
  code=$(mcp_post "$MCP_URL" "$init_body" "$TOKEN")
  body=$(mcp_json)
  if [ "$code" = "000" ]; then
    # Nothing listening. That is an environment fact, not a broken path -- report
    # it the same way stage 3 reports an unreachable /authz.
    skip "MCP endpoint unreachable at $MCP_URL"
  elif [ "$code" = "200" ] || [ "$code" = "202" ]; then
    SESSION=$(header_value 'Mcp-Session-Id')
    srv=$(printf '%s' "$body" | jq -r '.result.serverInfo | "\(.name) \(.version)"' 2>/dev/null)
    ok "initialize -> ${srv:-ok}${SESSION:+ (session ${SESSION:0:8}…)}"
  else
    bad "initialize -> HTTP $code" "$(printf '%s' "$body" | head -c 200)"
  fi

  if [ -n "$SESSION" ] || [ "$code" = "200" ]; then
    mcp_post "$MCP_URL" '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}' "$TOKEN" "$SESSION" >/dev/null
    code=$(mcp_post "$MCP_URL" "$(rpc 2 tools/list '{}')" "$TOKEN" "$SESSION")
    body=$(mcp_json)
    if [ "$code" = "200" ]; then
      TOOLS_JSON="$body"
      names=$(printf '%s' "$body" | jq -r '.result.tools[]?.name' 2>/dev/null)
      n=$(printf '%s' "$names" | grep -c . || true)
      sqln=$(printf '%s' "$names" | grep -c '^execute_sql' || true)
      if [ "${sqln:-0}" -gt 0 ]; then
        ok "tools/list -> $n tool(s), $sqln execute_sql_* source(s)"
        printf '%s' "$names" | grep '^execute_sql' | sed 's/^/         /'
      else
        bad "tools/list returned no execute_sql_* tool" \
            "DBHub names them per source; an empty set means dbhub.toml has no [[sources]] (see salt/dbhub/init.sls)"
      fi
    else
      bad "tools/list -> HTTP $code" "$(printf '%s' "$body" | head -c 200)"
    fi
  fi
fi

# --- stage 5: DBHub -> MariaDB --------------------------------------------

stage "5. Query reaches the configured database"

if [ -z "$TOOLS_JSON" ]; then
  skip "database query (no MCP session)"
else
  # DBHub namespaces its per-source tools as execute_sql_<id>, but with exactly
  # one source configured it emits a bare `execute_sql` instead. Resolve against
  # the names the server actually advertised rather than constructing one --
  # a constructed name that does not exist fails at call time as an opaque
  # "unknown tool", which reads like a database problem rather than a naming one.
  sql_tools=$(printf '%s' "$TOOLS_JSON" | jq -r '.result.tools[]?.name | select(startswith("execute_sql"))')
  sql_count=$(printf '%s\n' "$sql_tools" | grep -c . || true)
  tool=""

  if [ -z "$SOURCE" ]; then
    tool=$(printf '%s\n' "$sql_tools" | head -1)
  elif printf '%s\n' "$sql_tools" | grep -qx "execute_sql_${SOURCE}"; then
    tool="execute_sql_${SOURCE}"
  elif [ "${sql_count:-0}" -eq 1 ] && printf '%s\n' "$sql_tools" | grep -qx 'execute_sql'; then
    # Single source: the tool carries no source id, so --source cannot be
    # confirmed from the tool list. Use it, but say the name was not verified
    # rather than implying the query definitely hit the requested host. DBHub's
    # description is the source's `description` from dbhub.toml, not its `id`,
    # so print it -- it is the only clue available about which host this is.
    tool="execute_sql"
    desc=$(printf '%s' "$TOOLS_JSON" | jq -r '.result.tools[]? | select(.name=="execute_sql") | .description // empty' | cut -d. -f1)
    printf '         note: server advertises a bare "execute_sql" (single source), so\n'
    printf '               --source %s cannot be confirmed from the tool list.\n' "$SOURCE"
    [ -n "$desc" ] && printf '               it describes itself as: %s\n' "$desc"
  fi

  if [ -z "$tool" ] && [ -n "$SOURCE" ]; then
    bad "no execute_sql tool matches --source ${SOURCE}" \
        "advertised: $(printf '%s\n' "$sql_tools" | paste -sd, - 2>/dev/null || printf '%s' "$sql_tools")"
  elif [ -z "$tool" ]; then
    skip "database query (no execute_sql_* tool to call)"
  else
    # Use whatever the tool actually calls its statement argument rather than
    # assuming "sql" -- a schema change would otherwise look like a DB failure.
    argname=$(printf '%s' "$TOOLS_JSON" \
      | jq -r --arg t "$tool" '.result.tools[]? | select(.name==$t) | .inputSchema.properties | keys[]' 2>/dev/null \
      | grep -E '^(sql|query|statement)$' | head -1)
    argname="${argname:-sql}"
    args=$(jq -nc --arg k "$argname" --arg v "$SQL" '{($k): $v}')
    code=$(mcp_post "$MCP_URL" "$(rpc 3 tools/call "$(jq -nc --arg n "$tool" --argjson a "$args" '{name:$n,arguments:$a}')")" "$TOKEN" "$SESSION")
    body=$(mcp_json)
    if [ "$code" != "200" ]; then
      bad "$tool -> HTTP $code" "$(printf '%s' "$body" | head -c 200)"
    elif printf '%s' "$body" | jq -e '.result.isError == true' >/dev/null 2>&1; then
      # A tool-level error is the interesting failure: auth and transport worked,
      # so this is DBHub -> MariaDB (bad host, credentials, or grants).
      bad "$tool executed but returned an error" \
          "$(printf '%s' "$body" | jq -r '.result.content[]?.text' 2>/dev/null | head -c 300)"
    elif printf '%s' "$body" | jq -e '.error' >/dev/null 2>&1; then
      bad "$tool -> JSON-RPC error" "$(printf '%s' "$body" | jq -c '.error' | head -c 300)"
    else
      ok "$tool ran '${SQL}' against the configured source"
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
