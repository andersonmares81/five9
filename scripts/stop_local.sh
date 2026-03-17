#!/bin/zsh
set -euo pipefail

for port in 3001 5173; do
  pids=$(lsof -tiTCP:${port} -sTCP:LISTEN || true)
  if [[ -n "${pids}" ]]; then
    echo "${pids}" | xargs kill -9 >/dev/null 2>&1 || true
  fi
done

docker stop five9-server >/dev/null 2>&1 || true

echo "stopped"
