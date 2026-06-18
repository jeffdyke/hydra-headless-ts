#!/usr/bin/env bash
export REPO_BASE="668874212870.dkr.ecr.us-east-1.amazonaws.com"
export COMPOSE_FILE="/src/hydra-headless-ts/docker-compose.yml"
export ECR_REPO="bondlink-hydra-headless-ts"
login() {
  aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin "${REPO_BASE}"
}
