#!/usr/bin/env bash
set -xe
hydra_running=$(docker ps --filter "name=hydra-headless-ts-1" -q) # Running or restarting, it needs to be stopped
if [ ! -z "$hydra_running" ]; then
  sudo docker stop hydra-headless-ts-1
  sudo docker system prune -a -f
fi
docker compose -f /src/hydra-headless-ts/docker-compose.yml build headless-ts
docker push jeffdyke/hydra-headless-ts:latest
sudo docker compose -f /src/hydra-headless-ts/docker-compose.yml up -d --force-recreate headless-ts
