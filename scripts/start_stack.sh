#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

BACKEND_PORT=3001
FRONTEND_PORT=5173
BACKEND_LOG="${TMPDIR:-/tmp}/five9-docker-backend.log"

docker stop five9-server >/dev/null 2>&1 || true
docker rm five9-server >/dev/null 2>&1 || true

docker run -d --name five9-server \
  --network five9-net \
  -p ${BACKEND_PORT}:3001 \
  -v "$ROOT_DIR":/app \
  -w /app/server \
  --env-file "$ROOT_DIR/server/.env" \
  node:20 npm run start >/dev/null

for _ in {1..20}; do
  if curl -sf "http://127.0.0.1:${BACKEND_PORT}/api/health" >/dev/null; then
    break
  fi
  sleep 1
done

if ! curl -sf "http://127.0.0.1:${BACKEND_PORT}/api/health" >/dev/null; then
  docker logs five9-server >"$BACKEND_LOG" 2>&1 || true
  echo "Backend failed to start. Check $BACKEND_LOG"
  exit 1
fi

echo "backend_container=five9-server"
echo "backend_health=http://127.0.0.1:${BACKEND_PORT}/api/health"
echo "frontend_command=npm --workspace web run dev"
echo "frontend_url=http://127.0.0.1:${FRONTEND_PORT}"
