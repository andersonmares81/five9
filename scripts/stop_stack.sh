#!/bin/zsh
set -euo pipefail

frontend_pids=$(lsof -tiTCP:5173 -sTCP:LISTEN || true)
if [[ -n "${frontend_pids}" ]]; then
  echo "${frontend_pids}" | xargs kill -9 >/dev/null 2>&1 || true
fi

docker stop five9-server >/dev/null 2>&1 || true
docker rm five9-server >/dev/null 2>&1 || true

echo "stopped"
