#!/usr/bin/env bash
# Copy the dev sample config into /etc/hydra-headless-ts.
#
# The compose stack cannot start without these: `env_file:` is a hard
# requirement, so a missing mariadb-mcp.env aborts the whole `docker compose up`,
# not just the one service.
#
# Idempotent and non-destructive: an existing file is never overwritten. When one
# differs from the sample the diff is printed so you can merge by hand -- these
# files hold credentials, and clobbering them silently is how a working local
# setup gets lost.
#
#   scripts/dev-bootstrap-env.sh          # copy what is missing, diff what is not
#   scripts/dev-bootstrap-env.sh --force  # overwrite, keeping a .bak of each
set -uo pipefail

DEST="${HYDRA_ETC:-/etc/hydra-headless-ts}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

# sample -> destination filename
MAP=(
  "build/support_files/mariadb-mcp/mariadb-mcp.env:mariadb-mcp.env"
  "build/support_files/mariadb-mcp/mariadb-mcp-staging-db-galera-prime.env:mariadb-mcp-staging-db-galera-prime.env"
  "build/support_files/hydra/hydra.local.yml:hydra.yml"
  "build/support_files/hydra-headless-ts/local.env.sample:local.env"
  "build/support_files/hydra-headless-ts/allowed_emails_staging-db-galera-prime.txt:allowed_emails_staging-db-galera-prime.txt"
)

copied=0
differs=0
same=0

if [ ! -d "$DEST" ]; then
  echo "error: $DEST does not exist. Create it (and make it writable) first:" >&2
  echo "  sudo mkdir -p $DEST && sudo chown \"$(id -un)\" $DEST" >&2
  exit 1
fi

for entry in "${MAP[@]}"; do
  src="${REPO}/${entry%%:*}"
  dst="${DEST}/${entry##*:}"

  if [ ! -r "$src" ]; then
    echo "error: sample missing: $src" >&2
    exit 1
  fi

  if [ ! -e "$dst" ]; then
    cp "$src" "$dst"
    echo "copied   ${entry##*:}"
    copied=$((copied + 1))
  elif cmp -s "$src" "$dst"; then
    echo "same     ${entry##*:}"
    same=$((same + 1))
  elif [ $FORCE -eq 1 ]; then
    cp "$dst" "${dst}.bak"
    cp "$src" "$dst"
    echo "replaced ${entry##*:} (previous saved as ${entry##*:}.bak)"
    copied=$((copied + 1))
  else
    echo "differs  ${entry##*:}  -- left alone; diff (sample -> current):"
    diff -u "$src" "$dst" | sed 's/^/         /' | head -40
    differs=$((differs + 1))
  fi
done

echo
echo "copied $copied, unchanged $same, differing $differs"

if [ $differs -gt 0 ]; then
  cat <<EOF

$differs file(s) already existed with different contents and were NOT touched.
That is usually right: the staging-clone config on a workstation carries real
Google credentials the samples do not. Merge by hand, or re-run with --force to
replace them (a .bak is kept).
EOF
fi

cat <<EOF

Still manual after this:
  1. Fill GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / JWT_AUDIENCE in ${DEST}/local.env
     (JWT_AUDIENCE must equal GOOGLE_CLIENT_ID, or every token is rejected on aud)
  2. Add http://localhost:8888/callback as an Authorized redirect URI, and
     http://localhost:8888 as a JavaScript origin, on that Google client
  3. Set ${DEST}/mariadb-mcp.env's DB_PASSWORD, and point DB_HOST at a database
     you can actually reach. mariadb-mcp connects eagerly and crash-loops if it
     cannot, so a wrong value shows up immediately rather than on first query.
     Same for ${DEST}/mariadb-mcp-staging-db-galera-prime.env -- it's a second,
     independent instance/connection, not a copy of the first.
  4. Add your address to ${DEST}/allowed_emails_staging-db-galera-prime.txt.
     Unlike bare /db-tools, /db-tools/staging-db-galera-prime IS gated -- a
     missing or empty per-resource list denies everyone.
  5. scripts/dev-register-client.sh   (needs hydra running; sets AUTH_FLOW_CLIENT_ID)

Then: scripts/validate-mcp-path.sh --local
EOF
