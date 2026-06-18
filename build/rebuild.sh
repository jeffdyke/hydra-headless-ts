#!/usr/bin/env bash
set -xe
hydra_running=$(docker ps --filter "name=hydra-headless-ts-1" -q) # Running or restarting, it needs to be stopped
BASE_IMAGE="668874212870.dkr.ecr.us-east-1.amazonaws.com/bondlink-hydra-headless-ts"
COMPOSE_FILE="/src/hydra-headless-ts/docker-compose.yml"
BUILD_DATE=$(date -u +"%Y%m%dT%H%M%S")
GIT_BRANCH=$(git branch --show-current | tr '/' '-')
GIT_COMMIT=$(git rev-parse --short HEAD)
BUILD_HASH="${BUILD_DATE}_${GIT_BRANCH}_${GIT_COMMIT}"
if [ ! -z "$hydra_running" ]; then
  sudo docker stop hydra-headless-ts-1
  sudo docker system prune -a -f
fi
BRANCH_NAME=$GIT_BRANCH docker compose -f $COMPOSE_FILE build headless-ts

sudo docker compose -f $COMPOSE_FILE up -d --force-recreate headless-ts

docker tag $BASE_IMAGE:latest $BASE_IMAGE:$BUILD_HASH
source ./login.sh
docker push $BASE_IMAGE:$BUILD_HASH
echo "Build and push complete: $BASE_IMAGE:$BUILD_HASH"
