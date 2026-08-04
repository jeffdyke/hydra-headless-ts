#!/bin/sh
set -e

# Verify the configured OAuth2 client still exists in Hydra before serving. A
# reset Hydra database leaves AUTH_FLOW_CLIENT_ID naming a client that is gone,
# and that would otherwise surface as an opaque error part-way through a login.
#
# `cli:env` deliberately passes no --env-file. The container's configuration
# already arrives as real environment variables via docker-compose's
# `env_file: /etc/hydra-headless-ts/hydra.env`, so the process environment IS the
# configuration and this works unchanged in local, staging and prod.
#
# This used to run `cli:staging`, which loads ./src/env/staging.env from the
# image. That file is a committed template of placeholders
# (auth.staging.domain.tld, your-staging-client-id) plus a hardcoded VPC address.
# Node's --env-file does not override variables already set in the environment,
# so it was inert for every key hydra.env defines -- but it silently supplied a
# placeholder for any key hydra.env leaves out, which then fails a long way from
# its cause. Filling gaps with fiction is worse than leaving them empty, so
# nothing fills them now.
#
# SKIP_CLIENT_CHECK=1 serves without the pre-flight. Intended for local work
# where Hydra's admin API is not reachable yet: otherwise a failed check exits
# non-zero, the container restarts, and it crash-loops without ever serving --
# so nothing else can be tested either. Leave it unset in staging and prod.
if [ "${SKIP_CLIENT_CHECK:-0}" = "1" ]; then
  echo "SKIP_CLIENT_CHECK=1 -- skipping Hydra client verification."
else
  echo "Verifying Hydra client registration..."
  if ! npm run cli:env -- ensure-client; then
    echo ""
    echo "ERROR: Hydra client check failed."
    echo "  - client missing?  register one and set AUTH_FLOW_CLIENT_ID in hydra.env"
    echo "                     (locally: scripts/dev-register-client.sh)"
    echo "  - admin unreachable? HYDRA_ADMIN_HOST is dialled from INSIDE this"
    echo "                     container, so it must be a name this container can"
    echo "                     resolve -- the compose service is 'hydra'"
    echo "  - serve anyway:    SKIP_CLIENT_CHECK=1"
    exit 1
  fi
fi

exec npm run serve:staging
