#!/usr/bin/env bash
set -xe
ECR_REPO="bondlink-hydra-headless-ts"
LAST_TAG=$(aws ecr describe-images \
    --repository-name $ECR_REPO \
    --query 'sort_by(imageDetails, &imagePushedAt)[-1].imageTags[0]' \
    --output text || echo "None")

if [ "$LAST_TAG" == "None" ]; then
  echo "No existing tags found in ECR repository '$ECR_REPO'."
  exit 1
fi

echo "Latest ECR image tag: $LAST_TAG"
sudo docker pull "668874212870.dkr.ecr.us-east-1.amazonaws.com/$ECR_REPO:$LAST_TAG"
sudo docker tag "668874212870.dkr.ecr.us-east-1.amazonaws.com/$ECR_REPO:$LAST_TAG" "668874212870.dkr.ecr.us-east-1.amazonaws.com/$ECR_REPO:latest"
sudo docker compose -f /src/hydra-headless-ts/docker-compose.yml up -d --force-recreate headless-ts
