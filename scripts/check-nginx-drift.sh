#!/usr/bin/env bash
# Compare the dev nginx conf against the staging render, ignoring the
# differences that are supposed to exist.
#
# build/nginx/dev/conf.d/hydra.conf and the salt template behind
# build/nginx/reference/hydra.conf.staging.example are two copies of the same
# routing rules. Changes are rare, so this is a check rather than shared codegen
# -- but "rare" is exactly why nobody remembers to update both.
#
# It compares STRUCTURE, not text: one normalised record per location, plus the
# upstream name set and the server-scope $mcp_resource default. Cosmetic edits
# do not trip it; a lost auth_request, a changed proxy_pass suffix, or a location
# that exists on one side only does.
#
# Both inputs are committed files, so this runs anywhere -- no salt tree, no
# jinja, no network.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEV="${REPO}/build/nginx/dev/conf.d/hydra.conf"
REF="${REPO}/build/nginx/reference/hydra.conf.staging.example"

# Locations that legitimately exist only in the staging render. Carried as an
# explicit list so their reappearance in dev, or disappearance from staging, is
# still reported.
EXPECTED_ONLY_IN_REFERENCE='^loc=(/hostname|/hostname\.html)\|'

for f in "$DEV" "$REF"; do
  [ -r "$f" ] || { echo "error: missing $f" >&2; exit 2; }
done

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  red() { printf '\033[31m%s\033[0m' "$1"; }; green() { printf '\033[32m%s\033[0m' "$1"; }
else
  red() { printf '%s' "$1"; }; green() { printf '%s' "$1"; }
fi

# Emit one record per location plus two whole-file records.
#
# Normalisation collapses the intended differences (T1-T8 in the dev conf's
# header) so they never register as drift:
#   upstream addresses  -> ADDR      (compose DNS vs VPC IP)
#   $host / $http_host  -> HOSTVAR   (dev must keep the :8888 port)
#   $scheme / $http_x_forwarded_proto and a literal https -> SCHEMEVAR
#   a quoted Host "domain"           -> HOSTVAR
# T9: the dev conf resolves mariadb-mcp at request time (resolver + a variable in
# proxy_pass) instead of via an `upstream` block, so a stopped mariadb-mcp cannot
# stop nginx from starting. Rewrite that back into the canonical upstream form
# before comparing -- the ROUTING is identical, only the resolution timing
# differs, and everything else about the location stays under comparison.
#
# This is now N-aware: every location that resolves this way declares its own
# $mcp_tools_<name>_upstream variable (default instance: $mcp_tools_upstream,
# healthcheck: $mcp_tools_healthcheck_upstream, a named source:
# $mcp_tools_<name>_upstream with underscores for hyphens), so this discovers
# whichever variables the file actually uses rather than hardcoding two names.
normalize() {
  sed -e '/^[ \t]*resolver /d' "$1" | awk '
    function derive_name(v,    suffix, name) {
      suffix = v
      sub(/^\$mcp_tools_/, "", suffix)
      sub(/upstream$/, "", suffix)
      sub(/_$/, "", suffix)
      name = (suffix == "") ? "mcp-tools" : "mcp-tools-" suffix
      gsub(/_/, "-", name)
      return name
    }
    function esc(s,    r) {
      r = s
      gsub(/[.^$*+?()\[\]{}|\\]/, "\\\\&", r)
      return r
    }
    {
      line = $0
      # A location declares `set $mcp_tools_<name>_upstream "...";` before its
      # own `proxy_pass http://$mcp_tools_<name>_upstream/mcp;`, so by the time
      # this proxy_pass line is reached in the same pass, v/name already name
      # the variable it uses.
      if (match(line, /\$mcp_tools_[A-Za-z0-9_]*upstream/)) {
        v = substr(line, RSTART, RLENGTH)
        name = derive_name(v)
        seen[v] = name
      }
      if (line ~ /^[ \t]*set \$mcp_tools_[A-Za-z0-9_]*upstream/) next
      if (match(line, /\$mcp_tools_[A-Za-z0-9_]*upstream/)) {
        gsub("http://" esc(v) "/", "http://" name "/", line)
      }
      print line
    }
    END {
      for (v in seen) printf "upstream %s { }\n", seen[v]
    }
  '
}

# How many named mariadb-mcp instances exist, and what they're called, is
# now environment/pillar-driven (get_mcp_auth_db() in the salt repo) and
# expected to differ per environment -- dev also intentionally keeps just one
# generic named example (see LOCAL_TESTING.md) rather than mirroring every
# real source. So before the structural comparison: keep only the first named
# instance found in each file (by /db-tools/<name> location order) and rename
# it to a fixed placeholder in every form it appears (upstream block or
# synthetic upstream normalize() already emitted for T9's request-time style,
# location, well-known resource doc, map entry). Any additional named
# instance is dropped entirely, not just renamed -- reference legitimately
# having more of them than dev is exactly what this collapses away.
first_named_instance() {
  grep -m1 -oE '^  location /db-tools/[A-Za-z0-9_-]+ \{' "$1" \
    | sed -E 's#.*/db-tools/([A-Za-z0-9_-]+).*#\1#'
}

collapse_named_instances() {
  local rawfile="$1" name
  name="$(first_named_instance "$rawfile")"
  awk -v first="$name" '
    function is_first(n) { return first != "" && n == first }
    # normalize()s synthetic upstream (T9 form) is a one-liner; a real static
    # upstream block spans until its own closing brace -- handled separately.
    /^upstream mcp-tools-[A-Za-z0-9_-]+ \{ \}$/ {
      n = $2; sub(/^mcp-tools-/, "", n)
      if (n == "healthcheck") { print; next }
      if (!is_first(n)) next
    }
    /^upstream mcp-tools-[A-Za-z0-9_-]+ \{$/ {
      n = $2; sub(/^mcp-tools-/, "", n); sub(/\{$/, "", n); gsub(/ /, "", n)
      if (n == "healthcheck") { print; next }
      if (!is_first(n)) { skip = 1; next }
    }
    skip && /^\}$/ { skip = 0; next }
    skip { next }
    /^  location \/db-tools\/[A-Za-z0-9_-]+ \{/ {
      n = $0; sub(/^  location \/db-tools\//, "", n); sub(/ \{.*/, "", n)
      if (!is_first(n)) { skiploc = 1; next }
    }
    skiploc && /^  \}$/ { skiploc = 0; next }
    skiploc { next }
    /^  location = \/\.well-known\/oauth-protected-resource\/[A-Za-z0-9_-]+ \{/ {
      n = $0; sub(/^  location = \/\.well-known\/oauth-protected-resource\//, "", n); sub(/ \{.*/, "", n)
      if (n != "db-tools" && !is_first(n)) { skipwk = 1; next }
    }
    skipwk && /^  \}$/ { skipwk = 0; next }
    skipwk { next }
    /^  ~\^\/db-tools\/[A-Za-z0-9_-]+ / {
      n = $0; sub(/^  ~\^\/db-tools\//, "", n); sub(/ .*/, "", n)
      if (!is_first(n)) next
    }
    {
      if (first != "") {
        gsub("mcp-tools-" first, "mcp-tools-NAMED")
        gsub("/db-tools/" first, "/db-tools/NAMED")
        gsub("oauth-protected-resource/" first, "oauth-protected-resource/NAMED")
        gsub("\"" first "\"", "\"NAMED\"")
      }
      print
    }
  '
}

extract() {
  normalize "$1" | collapse_named_instances "$1" | awk '
    function flush() {
      if (loc != "") {
        printf "loc=%s|inc=%s|authreq=%s|res=%s|err401=%s|pass=%s|alias=%s|root=%s|tryfiles=%s\n",
          loc, (inc == "" ? "-" : inc), authreq, (res == "" ? "-" : res),
          (err == "" ? "-" : err), (pass == "" ? "-" : pass),
          (alias == "" ? "-" : alias), (root == "" ? "-" : root),
          (tf == "" ? "-" : tf)
      }
      loc=""; inc=""; authreq="no"; res=""; err=""; pass=""; alias=""; root=""; tf=""
      loc_depth=-1
    }
    BEGIN { depth=0; loc=""; loc_depth=-1 }

    # strip comments and collapse whitespace
    { sub(/#.*/, ""); gsub(/^[ \t]+|[ \t]+$/, ""); gsub(/[ \t]+/, " ") }
    /^$/ { next }

    # Brace bookkeeping. gsub with an identical replacement leaves the line
    # unchanged and returns the count. Without this a location never "closes",
    # so anything at server scope after the first location -- notably the
    # `set $mcp_resource ""` default -- gets attributed to that location and
    # compares equal on both sides no matter what.
    { o = gsub(/\{/, "{"); c = gsub(/\}/, "}") }

    # The map that assigns $mcp_resource decides which paths are gated, so it is
    # compared rather than ignored: a resource silently dropping out of it
    # disables that gate just as effectively as removing auth_request.
    /^map .*\$mcp_resource/ && o > 0 { flush(); inmap=1; depth += o - c; next }
    inmap == 1 {
      depth += o - c
      if (depth == 0) { inmap = 0; next }
      if ($0 ~ /^default/) next
      e=$0; sub(/;$/, "", e); gsub(/"/, "", e); gsub(/ +/, ":", e)
      maps = maps (maps=="" ? "" : ",") e
      next
    }

    /^upstream / { up=$2; ups = ups (ups=="" ? "" : ",") up; depth += o - c; next }
    /^server / && o > 0 { flush(); depth += o - c; next }
    /^location / && o > 0 {
      flush()
      line=$0; sub(/^location /, "", line); sub(/ *\{.*$/, "", line)
      loc=line
      loc_depth=depth          # depth BEFORE entering the block
      depth += o - c
      next
    }

    {
      if (loc != "") {
        if ($0 ~ /^include \/etc\/nginx\/cors_headers;/)          { inc = inc (inc=="" ? "" : ",") "cors" }
        else if ($0 ~ /^include \/etc\/nginx\/options_request;/)  { inc = inc (inc=="" ? "" : ",") "options" }
        else if ($0 ~ /^auth_request \/_authz;/)                  { authreq="yes" }
        # split on the quote rather than a backreference: POSIX awk gsub() has no
        # capture groups in the replacement (that is gawk gensub), and "\\1"
        # would be taken literally -- silently making every value compare equal.
        else if ($0 ~ /^set \$mcp_resource/)                      { n=split($0, q, "\""); res=(n < 2 ? "" : q[2]) }
        else if ($0 ~ /^error_page 401/)                          { err=$NF; sub(/;$/, "", err) }
        else if ($0 ~ /^alias /)                                  { alias=$2; sub(/;$/, "", alias) }
        else if ($0 ~ /^root /)                                   { root=$2; sub(/;$/, "", root) }
        else if ($0 ~ /^try_files /)                              { tf=$0; sub(/^try_files /, "", tf); sub(/;$/, "", tf) }
        else if ($0 ~ /^proxy_pass /) {
          p=$2; sub(/;$/, "", p); sub(/^http:\/\//, "", p)
          # keep "<upstream><suffix>": the upstream NAME is comparable, the
          # address behind it is not, and the suffix (/mcp) must match.
          pass=p
        }
      } else if ($0 ~ /^set \$mcp_resource/) {
        n=split($0, q, "\""); srv_default=(n < 2 || q[2] == "" ? "empty" : q[2])
      }

      depth += o - c
      if (loc != "" && depth <= loc_depth) flush()
    }

    END {
      flush()
      n=split(ups, a, ",")
      # insertion sort the upstream names so order in the file does not matter
      for (i=1; i<=n; i++) for (j=i+1; j<=n; j++) if (a[j] < a[i]) { t=a[i]; a[i]=a[j]; a[j]=t }
      s=""; for (i=1; i<=n; i++) s = s (s=="" ? "" : ",") a[i]
      printf "upstreams=%s\n", s
      printf "mcp_resource_map=%s\n", (maps=="" ? "ABSENT" : maps)
      printf "server_mcp_resource_default=%s\n", (srv_default=="" ? "ABSENT" : srv_default)
    }
  ' | sort
}

echo "dev       : ${DEV#$REPO/}"
echo "reference : ${REF#$REPO/}"
# A stale baseline is this check's one blind spot, so make its age visible.
echo "            captured $(date -r "$REF" '+%Y-%m-%d %H:%M' 2>/dev/null || echo 'unknown')"
echo

d=$(mktemp); r=$(mktemp)
trap 'rm -f "$d" "$r"' EXIT
extract "$DEV" > "$d"
extract "$REF" | grep -Ev "$EXPECTED_ONLY_IN_REFERENCE" > "$r"

if diff -u "$r" "$d" > /dev/null 2>&1; then
  printf '[%s] no structural drift\n' "$(green OK)"
  status=0
else
  printf '[%s] structural drift between the dev conf and the staging reference\n\n' "$(red DRIFT)"
  diff -u --label "reference (staging)" --label "dev" "$r" "$d" | tail -n +3
  cat <<'EOF'

A line only under "reference" means staging has routing dev does not: port the
change from /src/salt/salt/hydra-headless-ts/etc/nginx/conf.d/hydra.conf into
build/nginx/dev/conf.d/hydra.conf.

A line only under "dev" means the opposite -- either dev gained something that
belongs in salt, or the reference render is stale. Refresh it with the scp
command in that file's header before assuming the former.
EOF
  status=1
fi

cat <<'EOF'

intentionally not compared (see T1-T8 in the dev conf header):
  listen proxy_protocol / default_server  no HAProxy in dev
  server_name                             environment-specific hostnames
  upstream server addresses               compose DNS vs the VPC address
  Host / X-Forwarded-Proto values         no HAProxy to set them
  $host vs $http_host, https vs $scheme   dev is http on a non-default port
  locations /hostname, /hostname.html     HAProxy ops URLs, no local equivalent
  named mariadb-mcp instance identity     collapsed to one "NAMED" placeholder
                                           on both sides (see
                                           collapse_named_instances above) --
                                           how many exist and what they're
                                           called is pillar-driven per
                                           environment now, not fixed
  the shared cors_headers/options_request fragments are not covered at all
EOF

exit $status
