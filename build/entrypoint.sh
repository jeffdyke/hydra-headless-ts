#!/bin/sh
set -e

echo "Verifying Hydra client registration..."
if ! npm run cli:staging -- ensure-client; then
  echo ""
  echo "ERROR: Hydra client check failed. Update AUTH_FLOW_CLIENT_ID in hydra.env and restart."
  exit 1
fi

exec npm run serve:staging
