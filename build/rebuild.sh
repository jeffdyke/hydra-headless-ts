#!/usr/bin/env bash
set -xe
IS_CI=0
if [ "$1" = "--ci" ]; then
  hydra_running=
  IS_CI=1
else
  hydra_running=$(docker ps --filter "name=hydra-headless-ts-1" -q) # Running or restarting, it needs to be stopped
fi
COMPOSE_FILE="/src/hydra-headless-ts/docker-compose.yml"
BASE_IMAGE="668874212870.dkr.ecr.us-east-1.amazonaws.com/drone-hydra-headless-ts"
PUSH_IMAGE=${BASE_IMAGE/drone/bondlink}
BUILD_DATE=$(date -u +"%Y%m%dT%H%M%S")
GIT_COMMIT=$(git rev-parse --short HEAD)
BUILD_HASH="${BUILD_DATE}_hydra-headless-ts_${GIT_COMMIT}"

if [ ! -z "$hydra_running" ]; then
  docker stop hydra-headless-ts-1
  docker system prune -a -f
fi
echo "Docker $(which docker) version: $(docker --version)"
docker compose -f "${COMPOSE_FILE}" build headless-ts

if [ $IS_CI -eq 0 ]; then
  docker compose -f "${COMPOSE_FILE}" up -d --force-recreate --no-deps headless-ts
fi

sudo docker compose -f "${COMPOSE_FILE}" up -d --force-recreate --no-deps headless-ts

docker tag "${BASE_IMAGE}":latest "${PUSH_IMAGE}":"${BUILD_HASH}"
docker push "${PUSH_IMAGE}":"${BUILD_HASH}"
echo "Build and push complete: ${PUSH_IMAGE}":"${BUILD_HASH}"
