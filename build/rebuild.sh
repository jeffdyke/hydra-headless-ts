#!/usr/bin/env bash
# No `set -x` (this used to be `set -xe`): xtrace would echo the GIT_TOKEN
# handling below into the CI log. `set -e` is kept, and -o pipefail added so a
# failure inside a pipeline isn't swallowed.
set -eo pipefail

# Build the headless-ts runtime image and push it to ECR under a build hash.
#
#   rebuild.sh          local: stop a running container, rebuild, bring it back up
#   rebuild.sh --ci     CI: build and push only, never touch a running container
#
# The image build clones this private repo, so it needs a GitHub PAT with read
# access to mblink/hydra-headless-ts: either GIT_TOKEN in the environment, or a
# readable file at $PAT_SRC (see below). COMPOSE_FILE/REPO_BASE/ECR_REPO and
# login() all come from build/shared.sh.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
source "${SCRIPT_DIR}/shared.sh"

IS_CI=0
if [ "$1" = "--ci" ]; then
  hydra_running=
  IS_CI=1
else
  hydra_running=$(docker ps --filter "name=hydra-headless-ts-1" -q) # Running or restarting, it needs to be stopped
fi

# PUSH_IMAGE is what docker-compose.yml's headless-ts service declares as its
# `image:`, i.e. what `compose build` actually produces and what we tag/push.
# This used to tag ${BASE_IMAGE}:latest -- the drone-hydra-headless-ts *CI base*
# image -- and push it under the app image's build hash, so every published
# "app" tag contained the CI toolchain instead of the built app.
PUSH_IMAGE="${REPO_BASE}/${ECR_REPO}"
BUILD_DATE=$(date -u +"%Y%m%dT%H%M%S")
GIT_COMMIT=$(git rev-parse --short HEAD)
BUILD_HASH="${BUILD_DATE}_hydra-headless-ts_${GIT_COMMIT}"

# The image build clones this private repo, so it needs a PAT. Locally that's
# GIT_TOKEN in your environment; on a Drone agent it's the bldeploy PAT file the
# host mounts at /var/bondlink/tmp/.github/bldeploy.pat (same source oddjob's
# drone/build-salt.sh reads). Read from the file rather than plumbing it through
# an env var when we can -- one less place it can be echoed.
if [ -z "${GIT_TOKEN:-}" ]; then
  PAT_SRC="${PAT_SRC:-/var/bondlink/tmp/.github/bldeploy.pat}"
  if [ ! -r "$PAT_SRC" ]; then
    echo "error: no PAT available -- set GIT_TOKEN, or provide a readable file at $PAT_SRC" >&2
    ls -la "$(dirname "$PAT_SRC")" >&2 2>&1 || echo "error: $(dirname "$PAT_SRC") does not exist" >&2
    exit 1
  fi
  GIT_TOKEN="$(cat "$PAT_SRC")"
fi

# GIT_ASKPASS script for the image build's clone, passed through
# docker-compose.yml's `secrets:` block as a BuildKit secret so it is mounted
# only for the RUN that declares it and never lands in a layer. Written to a
# file rather than passed as a build-arg or argv -- argv is visible in `ps` and
# in `docker inspect`, a build-arg in `docker history`.
GIT_ASKPASS_FILE="$(mktemp)"
trap 'rm -f "$GIT_ASKPASS_FILE"' EXIT
cat > "$GIT_ASKPASS_FILE" <<EOF
#!/usr/bin/env bash
case "\$1" in
  Username*) echo "x-access-token" ;;
  *) echo "$GIT_TOKEN" ;;
esac
EOF
chmod 700 "$GIT_ASKPASS_FILE"
export GIT_ASKPASS_FILE
export GIT_BRANCH="${GIT_BRANCH:-${DRONE_BRANCH:-RC}}"

if [ -n "$hydra_running" ]; then
  docker stop hydra-headless-ts-1
  docker system prune -a -f
fi

echo "Docker $(which docker) version: $(docker --version)"
docker compose -f "${COMPOSE_FILE}" build headless-ts

# Only outside CI. The `sudo docker compose up` that used to sit below this
# block was unguarded and duplicated it, so every CI run also tried to start a
# container on the Drone agent -- under sudo, which the build container has no
# reason to hold.
if [ $IS_CI -eq 0 ]; then
  docker compose -f "${COMPOSE_FILE}" up -d --force-recreate --no-deps headless-ts
fi

# Each Drone step is its own container, so an ECR login done in an earlier step
# does not carry over -- authenticate here or the push fails. shared.sh has
# always defined login(); nothing called it.
login
docker tag "${PUSH_IMAGE}":latest "${PUSH_IMAGE}":"${BUILD_HASH}"
docker push "${PUSH_IMAGE}":"${BUILD_HASH}"
echo "Build and push complete: ${PUSH_IMAGE}:${BUILD_HASH}"
