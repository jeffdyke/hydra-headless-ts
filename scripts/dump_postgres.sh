#!/usr/bin/env bash
cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null
source ./pg_base.sh
source ./compose-env.sh

if [ -f "$BACKUP_FILE" ]; then
  rm -f "$BACKUP_FILE"
fi

compose exec -T postgres env PGPASSWORD=$PG_PASSWORD pg_dump -U hydra -d hydra > "$BACKUP_FILE"
