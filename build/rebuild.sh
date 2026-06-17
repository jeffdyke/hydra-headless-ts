#!/usr/bin/env bash
set -xe
hydra_running=$(docker ps --filter "name=hydra-headless-ts-1" -q) # Running or restarting, it needs to be stopped
BASE_IMAGE="668874212870.dkr.ecr.us-east-1.amazonaws.com/bondlink-hydra-headless-ts"
BUILD_DATE=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
GIT_COMMIT=$(git rev-parse --short HEAD)
BUILD_HASH="hydra-headless-ts_${BUILD_DATE}_${GIT_COMMIT}"
if [ ! -z "$hydra_running" ]; then
  sudo docker stop hydra-headless-ts-1
  sudo docker system prune -a -f
fi
docker compose -f /src/hydra-headless-ts/docker-compose.yml build headless-ts
#docker push jeffdyke/hydra-headless-ts:latest
sudo docker compose -f /src/hydra-headless-ts/docker-compose.yml up -d --force-recreate headless-ts

docker tag $BASE_IMAGE:latest $BASE_IMAGE:$BUILD_HASH
docker push $BASE_IMAGE:$BUILD_HASH
