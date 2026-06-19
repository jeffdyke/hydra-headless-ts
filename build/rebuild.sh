#!/usr/bin/env bash
set -xe
IS_CI=0
if [ "$1" = "--ci" ]; then
  hydra_running=
  IS_CI=1
else
  hydra_running=$(docker ps --filter "name=hydra-headless-ts-1" -q) # Running or restarting, it needs to be stopped
fi
BASE_IMAGE="668874212870.dkr.ecr.us-east-1.amazonaws.com/bondlink-hydra-headless-ts"
BUILD_DATE=$(date -u +"%Y%m%dT%H%M%S")
GIT_COMMIT=$(git rev-parse --short HEAD)
BUILD_HASH="${BUILD_DATE}_hydra-headless-ts_${GIT_COMMIT}"
if [ ! -z "$hydra_running" ]; then
  sudo docker stop hydra-headless-ts-1
  sudo docker system prune -a -f
fi
docker compose -f /src/hydra-headless-ts/docker-compose.yml --build --no-deps headless-ts
#docker push jeffdyke/hydra-headless-ts:latest
if [ $IS_CI -eq 0 ]; then
  sudo docker compose -f /src/hydra-headless-ts/docker-compose.yml up -d --force-recreate --no-deps headless-ts
fi

docker tag $BASE_IMAGE:latest $BASE_IMAGE:$BUILD_HASH
docker push $BASE_IMAGE:$BUILD_HASH
