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
normalize() {
  if grep -q '\$mcp_tools_upstream' "$1"; then
    # Balanced one-liner: the awk below tracks brace depth, so this must not
    # leave an unclosed block.
    printf 'upstream mcp-tools { }\n'
  fi
  sed -e '/^[ \t]*resolver /d' \
      -e '/^[ \t]*set \$mcp_tools_upstream/d' \
      -e 's|http://\$mcp_tools_upstream/|http://mcp-tools/|' \
      "$1"
}

extract() {
  normalize "$1" | awk '
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
  the shared cors_headers/options_request fragments are not covered at all
EOF

exit $status
