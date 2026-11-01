#!/bin/sh
set -eu

psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  -v test_db="$POSTGRES_TEST_DB" <<'EOSQL'
SELECT format('CREATE DATABASE %I OWNER %I', :'test_db', current_user)
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'test_db')
\gexec
EOSQL
