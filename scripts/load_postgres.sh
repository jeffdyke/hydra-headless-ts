#!/usr/bin/env bash
cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null
source ./pg_base.sh
if [ ! -f "$BACKUP_FILE" ]; then
  echo "Error: $BACKUP_FILE not found. Please run dump_postgres.sh first to create the backup."
  exit 1
fi

sudo docker exec -i hydra-postgres-1 env PGPASSWORD=$PG_PASSWORD psql -U hydra -d hydra < "${BACKUP_FILE}"
