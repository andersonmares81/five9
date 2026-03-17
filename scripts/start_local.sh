#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

BACKEND_PORT=3001
FRONTEND_PORT=5173
BACKEND_LOG="${TMPDIR:-/tmp}/five9-backend.log"
FRONTEND_LOG="${TMPDIR:-/tmp}/five9-frontend.log"

if command -v docker >/dev/null 2>&1; then
  if docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx 'five9-server'; then
    docker stop five9-server >/dev/null 2>&1 || true
  fi
fi

backend_pids=$(lsof -tiTCP:${BACKEND_PORT} -sTCP:LISTEN || true)
if [[ -n "${backend_pids}" ]]; then
  echo "${backend_pids}" | xargs kill -9 >/dev/null 2>&1 || true
fi

frontend_pids=$(lsof -tiTCP:${FRONTEND_PORT} -sTCP:LISTEN || true)
if [[ -n "${frontend_pids}" ]]; then
  echo "${frontend_pids}" | xargs kill -9 >/dev/null 2>&1 || true
fi

while IFS= read -r line || [[ -n "$line" ]]; do
  [[ -z "$line" ]] && continue
  [[ "$line" == \#* ]] && continue
  [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] || continue
  export "$line"
done < server/.env

if [[ "${DATABASE_URL:-}" == *"five9-postgres"* ]]; then
  export DATABASE_URL="postgres://five9:five9_local_dev@localhost:5432/five9"
fi

nohup npm --workspace server run start </dev/null >"$BACKEND_LOG" 2>&1 &
BACKEND_PID=$!

sleep 2

if ! curl -sf "http://127.0.0.1:${BACKEND_PORT}/api/health" >/dev/null; then
  echo "Backend failed to start. Check $BACKEND_LOG"
  exit 1
fi

nohup npm --workspace web run dev -- --host 127.0.0.1 --port ${FRONTEND_PORT} </dev/null >"$FRONTEND_LOG" 2>&1 &
FRONTEND_PID=$!

for _ in {1..20}; do
  if curl -sf "http://127.0.0.1:${FRONTEND_PORT}" >/dev/null; then
    break
  fi
  sleep 1
done

if ! curl -sf "http://127.0.0.1:${FRONTEND_PORT}" >/dev/null; then
  echo "Frontend failed to start. Check $FRONTEND_LOG"
  exit 1
fi

echo "backend_pid=${BACKEND_PID}"
echo "frontend_pid=${FRONTEND_PID}"
echo "backend_health=http://127.0.0.1:${BACKEND_PORT}/api/health"
echo "frontend_url=http://127.0.0.1:${FRONTEND_PORT}"
echo "backend_log=${BACKEND_LOG}"
echo "frontend_log=${FRONTEND_LOG}"
