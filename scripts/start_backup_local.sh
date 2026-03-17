#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

docker compose -f docker-compose.backup-local.yml up -d --build

for _ in {1..60}; do
  if curl -sf "http://127.0.0.1:8088/ingest.php" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

echo "mysql_host=127.0.0.1"
echo "mysql_port=3307"
echo "ingest_url=http://127.0.0.1:8088/ingest.php"
