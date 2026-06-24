#!/usr/bin/env bash
###########################
### DEPRECATED.  USE npm cli -- list-clients, get-client <client_id> or new-client <client_name>
###########################
set -e
OPERATION=$1
shift
COOKIE_DOMAIN="domain.tld"
HOST_IP=
ISSUER=
ISSUER_ADMIN=
CALLBACK_HOST=
POSTGRES_PASSWORD="my-super-secret-password"
ENV_PATH=/etc/hydra-headless-ts

# This script creates an OAuth2 client in Hydra and generates a .env file for the consent app.
#TODO Add prod
if [ "$(uname)" = "Darwin" ]; then
  SERVER_NAME="dev.${COOKIE_DOMAIN}"
  HOST_IP=$(ipconfig getifaddr en0)
  ISSUER="http://${SERVER_NAME}:4444"
  ISSUER_ADMIN="http://${HOST_IP}:4445"
  CALLBACK_HOST="http://${SERVER_NAME}:3000"
elif [[ "$(hostname)" == "staging"* ]]; then
  SERVER_NAME="auth.staging.${COOKIE_DOMAIN}"
  HOST_IP=$(hostname -I | cut -d ' ' -f1)
  ISSUER_ADMIN="http://${HOST_IP}:4445"
  CALLBACK_HOST="https://auth.staging.${COOKIE_DOMAIN}"
  ISSUER="https://${SERVER_NAME}"
elif [[ "$(hostname)" == "prod"* ]]; then
  SERVER_NAME="oauth.prod.bondlink.org"
  HOST_IP=$(hostname -I | cut -d ' ' -f1)
  ISSUER_ADMIN="http://${HOST_IP}:4445"
  CALLBACK_HOST="https://oauth.prod.bondlink.org"
  ISSUER="https://${SERVER_NAME}"
fi

declare -A CLIENT_CREDENTIALS_CONFIG
CLIENT_CREDENTIALS_CONFIG[scope]="offline email openid offline_access"
CLIENT_CREDENTIALS_CONFIG[grant]="client_secret_post"

declare -A AUTH_FLOW_CONFIG
AUTH_FLOW_CONFIG[scope]="offline openid"
AUTH_FLOW_CONFIG[grant]="authorization_code,refresh_token"
AUTH_FLOW_CONFIG[response-type]="code,id_token"
AUTH_FLOW_CONFIG[token-endpoint-auth-method]="none"


AUTH_FLOW_CLIENT_ID=$(grep AUTH_FLOW_CLIENT_ID /etc/hydra-headless-ts/hydra.env | cut -d '=' -f2 2>/dev/null) || ""
CODE_CLIENT_ID=$(grep CODE_CLIENT_ID /etc/hydra-headless-ts/hydra.env | cut -d '=' -f2 2>/dev/null) || ""

authClient() {
  if [ -n "${AUTH_FLOW_CLIENT_ID}" ]; then
    echo "Client ID already exists in .env file: $AUTH_FLOW_CLIENT_ID"
    echo "Skipping client creation."
    return
  fi

  client_output=$(hydra create client --endpoint "${ISSUER_ADMIN}" \
    --grant-type "authorization_code,refresh_token" \
    --response-type "code,id_token" \
    --format json \
    --token-endpoint-auth-method none \
    --scope "openid,email,profile,offline_access" \
    --redirect-uri "${CALLBACK_HOST}/callback,https://claude.ai/api/mcp/auth_callback,http://localhost:6274/oauth/callback,http://localhost:6274/oauth/callback/debug,http://127.0.0.1:6274/oauth/callback" \
    --format json
  )
  validateResponse "${client_output}"
  client_id=$(echo $client_output | jq -r '.client_id')
  client_secret=$(echo $client_output | jq -r '.client_secret')
  echo "AUTH_FLOW_CLIENT_ID=$client_id"
  echo "AUTH_FLOW_CLIENT_SECRET=$client_secret"
  echo "$client_output" | jq '.'
}


validateResponse() {
  local client_data="${1}"
  client_id=$(echo "$client_data" | jq -r '.client_id')
  client_secret=$(echo "$client_data" | jq -r '.client_secret')
  if [ -z "$client_id" ] || [ -z "$client_secret" ]; then
    echo "Failed to create OAuth2 client. Output was:"
    echo "$client_data"
    exit 1
  fi
  echo "${client_id} ${client_secret}"
}

codeClient() {
  if [ -n "$CODE_CLIENT_ID" ]; then
    echo "Client ID already exists in .env file: $CODE_CLIENT_ID"
    echo "Skipping client creation."
    return
  fi

  client_output=$(hydra create client --endpoint "${ISSUER_ADMIN}" \
  --name "${APP_NAME}" \
  --scope "${APP_SCOPE}" \
  --grant-type "${APP_GRANT_TYPE}" \
  --response-type code \
  --token-endpoint-auth-method none \
  --redirect-uri "${CALLBACK_HOST}/callback" \
  --format json)

  validateResponse "${client_output}"

  client_id=$(echo "$client_output" | jq -r '.client_id')
  client_secret=$(echo "$client_output" | jq -r '.client_secret')
  echo "AUTH_FLOW_CLIENT_ID=$code_client_id" | tee .env.code.hydra
  echo "AUTH_FLOW_CLIENT_SECRET=$code_client_secret" | tee -a .env.code.hydra
  echo "${client_output}"
}

# Delete/redo this
updateClient() {
  if [ -z "$AUTH_FLOW_CLIENT_ID" ]; then
    echo "CLIENT_ID is not set in .env file. Cannot update client."
    exit 1
  fi
  client_output=$(hydra update client $AUTH_FLOW_CLIENT_ID --endpoint "${ISSUER_ADMIN}" \
  --name "${APP_NAME}" \
  --scope "${APP_SCOPE}" \
  --grant-type "${APP_GRANT_TYPE}" \
  --response-type code \
  --token-endpoint-auth-method none \
  --redirect-uri "${CALLBACK_HOST}/callback" \
  --format json)

  echo "$client_output"
}
getClient() {
  # _validateClientId
  # hydra get oauth2-client $CODE_CLIENT_ID --endpoint "${ISSUER_ADMIN}" --format json | jq '.'
  # _validateAuthClientId
  hydra get oauth2-client $AUTH_FLOW_CLIENT_ID --endpoint "${ISSUER_ADMIN}" --format json | jq '.'
}

$OPERATION "$@"
