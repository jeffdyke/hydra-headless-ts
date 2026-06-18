#!/usr/bin/env bash
set -xe
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
source "${SCRIPT_DIR}/shared.sh"
hydra_running=$(docker ps --filter "name=${ECR_REPO}-1" -q) # Running or restarting, it needs to be stopped
BASE_IMAGE="${REPO_BASE}/${ECR_REPO}"
BUILD_DATE=$(date -u +"%Y%m%dT%H%M%S")
GIT_BRANCH=$(git branch --show-current)
GIT_COMMIT=$(git rev-parse --short HEAD)
#Remove slashes from branch name for docker tag compatibility
BUILD_HASH="${BUILD_DATE}_${GIT_BRANCH//\//-}_${GIT_COMMIT}"
if [ ! -z "$hydra_running" ]; then
  sudo docker stop "${ECR_REPO}-1"
  sudo docker system prune -a -f
fi
BRANCH_NAME="${GIT_BRANCH}" docker compose -f "${COMPOSE_FILE}" build headless-ts

sudo docker compose -f "${COMPOSE_FILE}" up -d --force-recreate headless-ts

docker tag "${BASE_IMAGE}":latest "${BASE_IMAGE}":"${BUILD_HASH}"
echo "Login Result $(login)"
docker push "${BASE_IMAGE}":"${BUILD_HASH}"
echo "Build and push complete: ${BASE_IMAGE}":"${BUILD_HASH}"
