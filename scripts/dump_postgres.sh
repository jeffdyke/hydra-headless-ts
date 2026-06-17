#!/usr/bin/env bash
cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null
source ./pg_base.sh

if [ -f "$BACKUP_FILE" ]; then
  rm -f "$BACKUP_FILE"
fi

sudo docker exec -i hydra-postgres-1 env PGPASSWORD=$PG_PASSWORD pg_dump -U hydra -d hydra > "$BACKUP_FILE"
