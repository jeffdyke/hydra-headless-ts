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
if [ $(uname) = "Darwin" ]; then
  export GIT_COMMAND=git
else
  export GIT_COMMAND="sudo -u bldeploy git"
fi
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
source "${SCRIPT_DIR}/shared.sh"
ONLY_ARCH=
IS_CI=0
# Any non-empty, non-zero SKIP_GIT_CHECKS counts as force, so both
# SKIP_GIT_CHECKS=1 and SKIP_GIT_CHECKS=true behave the way they read.
FORCE=0
case "${SKIP_GIT_CHECKS:-0}" in 0 | "") ;; *) FORCE=1 ;; esac
# A loop rather than the old positional `[ "$1" = "--ci" ]`, so --ci and --force
# compose in either order.
for arg in "$@"; do
  case "$arg" in
    --ci)
      IS_CI=1
      GIT_COMMAND=git
      ;;
    --force) FORCE=1 ;;
    *)
      echo "error: unknown argument '$arg' (expected --ci and/or --force)" >&2
      exit 1
      ;;
  esac
done

if [ $IS_CI -eq 1 ]; then
  hydra_running=
  # CI is arm64-only (.drone.yml/amd64 is gone; .woodpecker.yml only runs
  # linux/arm64 agents) -- fail loudly rather than silently building the
  # wrong platform if that ever changes.
  arch=$(uname -m)
  case "$arch" in
    aarch64) ONLY_ARCH=linux/arm64 ;;
    *)
      echo "error: CI is arm64-only; unexpected architecture '$arch'" >&2
      exit 1
      ;;
  esac
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
GIT_COMMIT=$($GIT_COMMAND rev-parse --short HEAD)
BUILD_HASH="${BUILD_DATE}_hydra-headless-ts_${GIT_COMMIT}"

# Which branch the image build clones. An explicit GIT_BRANCH always wins, and
# in CI it is DRONE_BRANCH, which by construction matches the checked-out tree.
#
# Locally there is no DRONE_BRANCH, and defaulting straight to RC made the tag
# lie: BUILD_HASH embeds GIT_COMMIT from *your* HEAD, so a run from a feature
# branch published RC's code under the feature branch's short SHA. Default to
# the checked-out branch instead, so ${BUILD_HASH} describes what is inside the
# image. Detached HEAD has no branch name to clone (`--abbrev-ref` just says
# "HEAD"), so that still falls back to RC.
current_branch=
if [ -z "${GIT_BRANCH:-}" ] && [ -z "${DRONE_BRANCH:-}" ] && [ $IS_CI -eq 0 ]; then
  # `|| true` and the explicit if: under `set -e` a non-zero last command in an
  # if-body aborts the script, and both of these fail routinely (not a git repo,
  # branch is not detached).
  current_branch=$($GIT_COMMAND rev-parse --abbrev-ref HEAD 2>/dev/null || true)
  if [ "$current_branch" = "HEAD" ]; then
    current_branch=
  fi
fi
export GIT_BRANCH="${GIT_BRANCH:-${DRONE_BRANCH:-${current_branch:-RC}}}"
echo "Building from branch: ${GIT_BRANCH} (${GIT_COMMIT})"

# Refuse to publish an image whose contents do not match the tag it gets.
#
# build/Dockerfile.headless-ts clones $GIT_BRANCH from GitHub rather than
# copying this working tree, so the local checkout influences the *tag* but
# almost none of the *contents*. Three ways that diverges:
#
#   - Unpushed commits: the clone gets older code than the HEAD whose SHA is
#     baked into BUILD_HASH, so the published tag names a commit the image does
#     not contain.
#   - Uncommitted app source: never reaches the image at all. A green build can
#     silently omit the change you just made.
#   - Uncommitted build/entrypoint.sh: the opposite -- that one file *is* COPYed
#     from the local context, so the image matches no commit anywhere.
#
# Comparing origin's tip against GIT_COMMIT is the check that matters; it also
# catches a branch that was never pushed, which would otherwise fail the clone
# a minute into the build. Untracked files only warn: they are usually editor
# scratch, and blocking on them just trains everyone to reach for --force.
check_git_state() {
  local remote_sha local_sha untracked
  local_sha=$($GIT_COMMAND rev-parse HEAD)
  # GIT_TERMINAL_PROMPT=0 so a missing credential fails here instead of hanging
  # on a prompt nobody is watching.
  remote_sha=$(GIT_TERMINAL_PROMPT=0 $GIT_COMMAND ls-remote origin "refs/heads/${GIT_BRANCH}" 2>/dev/null | cut -f1)

  if [ -z "$remote_sha" ]; then
    echo "error: branch '${GIT_BRANCH}' is not on origin (or origin is unreachable)." >&2
    echo "       The image build clones it from GitHub, so this would fail partway" >&2
    echo "       through the build. Push the branch, or re-run with --force." >&2
    return 1
  fi
  if [ "$remote_sha" != "$local_sha" ]; then
    echo "error: origin/${GIT_BRANCH} is at ${remote_sha:0:7}, but HEAD is ${local_sha:0:7}." >&2
    echo "       The image would be built from ${remote_sha:0:7} and published as" >&2
    echo "       ${BUILD_HASH}, naming a commit it does not contain." >&2
    echo "       Push your commits, or re-run with --force." >&2
    return 1
  fi
  if ! $GIT_COMMAND diff --quiet || ! $GIT_COMMAND diff --cached --quiet; then
    echo "error: uncommitted changes to tracked files:" >&2
    $GIT_COMMAND --no-pager diff --stat HEAD >&2
    echo "       These are not on origin/${GIT_BRANCH}, so they will not be in the" >&2
    echo "       image. Commit and push, or re-run with --force." >&2
    return 1
  fi

  untracked=$($GIT_COMMAND ls-files --others --exclude-standard)
  if [ -n "$untracked" ]; then
    echo "warning: untracked files present; they will not be in the image:" >&2
    echo "$untracked" | sed 's/^/         /' >&2
  fi
}

# Local only: a CI agent builds exactly what it checked out, so these checks are
# noise there (and `git ls-remote` is a needless round trip).
if [ $IS_CI -eq 0 ] && [ $FORCE -eq 0 ]; then
  check_git_state || exit 1
elif [ $FORCE -eq 1 ] && [ $IS_CI -eq 0 ]; then
  echo "warning: --force/SKIP_GIT_CHECKS set; skipping git state checks." >&2
fi

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
set -x
if [ -n "$hydra_running" ]; then
  docker stop hydra-headless-ts-1
  # No -a: `prune -a` removes every image not used by a RUNNING container, and
  # this script had just stopped the one container keeping some of them alive.
  # Plain prune drops dangling (untagged) layers only, which is all this was
  # ever for -- reclaiming space from the previous build of this image. It also
  # keeps the base images, so rebuilds stop re-pulling node:22-alpine every time.
  docker system prune -f
fi

echo "Docker $(which docker) version: $(docker --version)"
export DOCKER_DEFAULT_PLATFORM=$ONLY_ARCH
docker compose -f "${COMPOSE_FILE}" build headless-ts

# Only outside CI. The `sudo docker compose up` that used to sit below this
# block was unguarded and duplicated it, so every CI run also tried to start a
# container on the Drone agent -- under sudo, which the build container has no
# reason to hold.
if [ $IS_CI -eq 0 ]; then
  docker compose -f "${COMPOSE_FILE}" up -d --force-recreate --no-deps headless-ts
fi

# Authenticate to ECR, unless a credential helper already handles it -- see the
# long note on login() in shared.sh. shared.sh has always defined login();
# nothing called it.
login
# docker-compose.yml's build block declares `platforms:`, so :latest in the
# local store is an image index (one platform: linux/arm64). `docker tag`
# carries the index over, and `docker push` without --platform uploads
# everything in it.
docker tag "${PUSH_IMAGE}":latest "${PUSH_IMAGE}":"${BUILD_HASH}"
docker push "${PUSH_IMAGE}":"${BUILD_HASH}"
echo "Build and push complete: ${PUSH_IMAGE}:${BUILD_HASH}"

# Only in CI: docker-compose.yml's headless-ts service pulls this image with no
# tag (implicitly :latest), and nothing else here ever refreshes that tag -- a
# local rebuild pushing it would let one developer's laptop build become what
# everyone else deploys. .drone.yml (amd64) is gone and .woodpecker.yml only
# runs on arm64 agents, so there is exactly one arch to keep this tag pointed
# at; no arch suffix needed the way oddjob's build.sh uses one (that script
# still tags both amd64 and arm64 builds from the same pipeline).
if [ $IS_CI -eq 1 ]; then
  docker push "${PUSH_IMAGE}":latest
  echo "Build and push complete: ${PUSH_IMAGE}:latest"
fi
