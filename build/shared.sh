#!/usr/bin/env bash
export REPO_BASE="668874212870.dkr.ecr.us-east-1.amazonaws.com"
export ECR_REPO="bondlink-hydra-headless-ts"
if [ "$(uname)" = "Darwin" ]; then
  DOCKER_CMD="docker"
else
  DOCKER_CMD="sudo docker"
fi
# True when ~/.docker/config.json maps $1 to the amazon-ecr-credential-helper.
# Deliberately grep rather than jq: this runs inside minimal CI containers too.
ecr_cred_helper_configured() {
  local cfg="${DOCKER_CONFIG:-${HOME}/.docker}/config.json"
  [ -r "$cfg" ] || return 1
  command -v docker-credential-ecr-login >/dev/null 2>&1 || return 1
  grep -q "\"${1}\"[[:space:]]*:[[:space:]]*\"ecr-login\"" "$cfg"
}

# Each Drone step is its own container, so an ECR login done in an earlier step
# does not carry over and we have to authenticate here.
#
# On a workstation you almost certainly do NOT want that `docker login`, and it
# is what breaks `rebuild.sh` locally. `docker login` does two things: get a
# token, then *save* it through the configured credential store. Both of the
# credential stores available on a Mac fail that second step:
#
#   - docker-credential-ecr-login implements only `get`; its `store` verb is a
#     deliberate no-op that exits non-zero, so login dies with
#     "error storing credentials ... out: `not implemented`".
#   - docker-credential-osxkeychain fails with "The specified item already
#     exists in the keychain. (-25299)" once a Docker-Credentials item exists
#     that the current helper binary is not in the ACL of -- e.g. an entry
#     written by Docker Desktop's helper, then re-written by OrbStack's. Its
#     delete-then-add cannot delete, so the add collides. `docker logout` hits
#     the same wall, which is why logging out does not clear it.
#
# The login is also unnecessary there: with ecr-login listed under credHelpers
# for this registry, docker mints a fresh ECR token from the ambient AWS
# credentials on every pull/push. Nothing to log into, nothing to store.
login() {
  if ecr_cred_helper_configured "${REPO_BASE}"; then
    echo "ecr-login credential helper is configured for ${REPO_BASE}; skipping docker login"
    return 0
  fi
  aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin "${REPO_BASE}"
}
