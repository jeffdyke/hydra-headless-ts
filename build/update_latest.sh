#!/usr/bin/env bash
set -xe
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
source "${SCRIPT_DIR}/shared.sh"

LAST_TAG=$(aws ecr describe-images \
    --repository-name $ECR_REPO \
    --query 'sort_by(imageDetails, &imagePushedAt)[-1].imageTags[0]' \
    --output text || echo "None")

if [ "$LAST_TAG" == "None" ]; then
  echo "No existing tags found in ECR repository '$ECR_REPO'."
  exit 1
fi

echo "Latest ECR image tag: $LAST_TAG"
sudo docker pull "${REPO_BASE}/$ECR_REPO:$LAST_TAG"
sudo docker tag "${REPO_BASE}/$ECR_REPO:$LAST_TAG" "${REPO_BASE}/$ECR_REPO:latest"
sudo docker compose -f "${COMPOSE_FILE}" up -d --force-recreate headless-ts
