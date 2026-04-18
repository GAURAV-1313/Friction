#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Migrate local MySQL database to Aiven MySQL.

Required environment variables:
  LOCAL_DB_USER
  LOCAL_DB_PASSWORD
  LOCAL_DB_NAME
  AIVEN_DB_HOST
  AIVEN_DB_PORT
  AIVEN_DB_USER
  AIVEN_DB_PASSWORD
  AIVEN_DB_NAME

Optional environment variables:
  LOCAL_DB_HOST=127.0.0.1
  LOCAL_DB_PORT=3306
  AIVEN_SSL_MODE=REQUIRED      # REQUIRED | VERIFY_CA | VERIFY_IDENTITY
  AIVEN_SSL_CA=                # required when AIVEN_SSL_MODE is VERIFY_CA/VERIFY_IDENTITY
  DUMP_DIR=./tmp/db_dumps
  SKIP_COUNTS=false            # set true to skip post-import count checks
  REPLACE_TARGET_DB=false      # set true for full clone (drops and recreates target DB)
  REPLACE_CONFIRM=             # required text when REPLACE_TARGET_DB=true: REPLACE_AIVEN_DB

Example:
  LOCAL_DB_USER=root \
  LOCAL_DB_PASSWORD=localpass \
  LOCAL_DB_NAME=friction_local \
  AIVEN_DB_HOST=mysql-xxxx.aivencloud.com \
  AIVEN_DB_PORT=12345 \
  AIVEN_DB_USER=avnadmin \
  AIVEN_DB_PASSWORD=secret \
  AIVEN_DB_NAME=friction \
  REPLACE_TARGET_DB=true \
  REPLACE_CONFIRM=REPLACE_AIVEN_DB \
  AIVEN_SSL_MODE=VERIFY_CA \
  AIVEN_SSL_CA=$PWD/aiven-ca.pem \
  bash scripts/migrate_local_to_aiven.sh
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Error: required command not found: $cmd" >&2
    exit 1
  fi
}

require_env() {
  local var_name="$1"
  if [[ -z "${!var_name:-}" ]]; then
    echo "Error: missing required env var: $var_name" >&2
    usage
    exit 1
  fi
}

require_cmd mysqldump
require_cmd mysql

LOCAL_DB_HOST="${LOCAL_DB_HOST:-127.0.0.1}"
LOCAL_DB_PORT="${LOCAL_DB_PORT:-3306}"
AIVEN_SSL_MODE="${AIVEN_SSL_MODE:-REQUIRED}"
DUMP_DIR="${DUMP_DIR:-./tmp/db_dumps}"
SKIP_COUNTS="${SKIP_COUNTS:-false}"
REPLACE_TARGET_DB="${REPLACE_TARGET_DB:-false}"
REPLACE_CONFIRM="${REPLACE_CONFIRM:-}"
SKIP_COUNTS_LC="$(printf '%s' "$SKIP_COUNTS" | tr '[:upper:]' '[:lower:]')"
REPLACE_TARGET_DB_LC="$(printf '%s' "$REPLACE_TARGET_DB" | tr '[:upper:]' '[:lower:]')"

require_env LOCAL_DB_USER
require_env LOCAL_DB_PASSWORD
require_env LOCAL_DB_NAME
require_env AIVEN_DB_HOST
require_env AIVEN_DB_PORT
require_env AIVEN_DB_USER
require_env AIVEN_DB_PASSWORD
require_env AIVEN_DB_NAME

case "$AIVEN_SSL_MODE" in
  REQUIRED|VERIFY_CA|VERIFY_IDENTITY)
    ;;
  *)
    echo "Error: AIVEN_SSL_MODE must be REQUIRED, VERIFY_CA, or VERIFY_IDENTITY" >&2
    exit 1
    ;;
esac

if [[ "$REPLACE_TARGET_DB_LC" == "true" && "$REPLACE_CONFIRM" != "REPLACE_AIVEN_DB" ]]; then
  echo "Error: for destructive clone set REPLACE_CONFIRM=REPLACE_AIVEN_DB" >&2
  exit 1
fi

ssl_args=("--ssl-mode=$AIVEN_SSL_MODE")
if [[ "$AIVEN_SSL_MODE" == "VERIFY_CA" || "$AIVEN_SSL_MODE" == "VERIFY_IDENTITY" ]]; then
  require_env AIVEN_SSL_CA
  if [[ ! -f "$AIVEN_SSL_CA" ]]; then
    echo "Error: AIVEN_SSL_CA file not found: $AIVEN_SSL_CA" >&2
    exit 1
  fi
  ssl_args+=("--ssl-ca=$AIVEN_SSL_CA")
elif [[ -n "${AIVEN_SSL_CA:-}" ]]; then
  if [[ ! -f "$AIVEN_SSL_CA" ]]; then
    echo "Error: AIVEN_SSL_CA file not found: $AIVEN_SSL_CA" >&2
    exit 1
  fi
  ssl_args+=("--ssl-ca=$AIVEN_SSL_CA")
fi

mkdir -p "$DUMP_DIR"
dump_file="$DUMP_DIR/local_to_aiven_$(date +%Y%m%d_%H%M%S).sql"

echo "[1/5] Dumping local database '$LOCAL_DB_NAME' to $dump_file"
MYSQL_PWD="$LOCAL_DB_PASSWORD" mysqldump \
  --single-transaction \
  --quick \
  --routines \
  --triggers \
  --events \
  --set-gtid-purged=OFF \
  --default-character-set=utf8mb4 \
  -h "$LOCAL_DB_HOST" \
  -P "$LOCAL_DB_PORT" \
  -u "$LOCAL_DB_USER" \
  "$LOCAL_DB_NAME" > "$dump_file"

if [[ "$REPLACE_TARGET_DB_LC" == "true" ]]; then
  echo "[2/5] Replacing target Aiven database '$AIVEN_DB_NAME' (drop + create)"
  MYSQL_PWD="$AIVEN_DB_PASSWORD" mysql \
    -h "$AIVEN_DB_HOST" \
    -P "$AIVEN_DB_PORT" \
    -u "$AIVEN_DB_USER" \
    "${ssl_args[@]}" \
    -e "DROP DATABASE IF EXISTS \`$AIVEN_DB_NAME\`; CREATE DATABASE \`$AIVEN_DB_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
else
  echo "[2/5] Ensuring Aiven database '$AIVEN_DB_NAME' exists"
  MYSQL_PWD="$AIVEN_DB_PASSWORD" mysql \
    -h "$AIVEN_DB_HOST" \
    -P "$AIVEN_DB_PORT" \
    -u "$AIVEN_DB_USER" \
    "${ssl_args[@]}" \
    -e "CREATE DATABASE IF NOT EXISTS \`$AIVEN_DB_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
fi

echo "[3/5] Importing dump into Aiven"
MYSQL_PWD="$AIVEN_DB_PASSWORD" mysql \
  -h "$AIVEN_DB_HOST" \
  -P "$AIVEN_DB_PORT" \
  -u "$AIVEN_DB_USER" \
  "${ssl_args[@]}" \
  "$AIVEN_DB_NAME" < "$dump_file"

echo "[4/5] Verifying Aiven connectivity"
MYSQL_PWD="$AIVEN_DB_PASSWORD" mysql \
  -h "$AIVEN_DB_HOST" \
  -P "$AIVEN_DB_PORT" \
  -u "$AIVEN_DB_USER" \
  "${ssl_args[@]}" \
  "$AIVEN_DB_NAME" \
  -e "SELECT NOW() AS connected_at; SHOW TABLES;"

if [[ "$SKIP_COUNTS_LC" != "true" ]]; then
  echo "[5/5] Running core table row counts"
  MYSQL_PWD="$AIVEN_DB_PASSWORD" mysql \
    -h "$AIVEN_DB_HOST" \
    -P "$AIVEN_DB_PORT" \
    -u "$AIVEN_DB_USER" \
    "${ssl_args[@]}" \
    "$AIVEN_DB_NAME" \
    -e "SELECT 'users' AS table_name, COUNT(*) AS row_count FROM users UNION ALL SELECT 'buffer_moments', COUNT(*) FROM buffer_moments UNION ALL SELECT 'candidate_findings', COUNT(*) FROM candidate_findings UNION ALL SELECT 'learning_records', COUNT(*) FROM learning_records;"
else
  echo "[5/5] Skipping counts because SKIP_COUNTS=true"
fi

echo "Migration complete. Dump retained at: $dump_file"