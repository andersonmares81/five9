#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

SERVICE_LABEL="com.gsdoutsource.five9-command-center"
PLIST_PATH="${HOME}/Library/LaunchAgents/${SERVICE_LABEL}.plist"
LOG_DIR="${HOME}/Library/Logs/five9-command-center"
STDOUT_LOG="${LOG_DIR}/stdout.log"
STDERR_LOG="${LOG_DIR}/stderr.log"

PORT="${FIVE9_SERVICE_PORT:-3180}"
DATABASE_URL="${FIVE9_SERVICE_DATABASE_URL:-postgres://five9:five9_local_dev@127.0.0.1:5432/five9}"
AUTH_MODE="${FIVE9_SERVICE_AUTH_MODE:-passthrough}"
BACKUP_ENDPOINT="${FIVE9_SERVICE_BACKUP_ENDPOINT:-}"
TRANSCRIBE_PROVIDER="${FIVE9_SERVICE_TRANSCRIBE_PROVIDER:-}"
SENTIMENT_PROVIDER="${FIVE9_SERVICE_SENTIMENT_PROVIDER:-}"
OLLAMA_HOST="${FIVE9_SERVICE_OLLAMA_HOST:-}"
OLLAMA_SENTIMENT_MODEL="${FIVE9_SERVICE_OLLAMA_SENTIMENT_MODEL:-}"
PYTHON_BIN="${FIVE9_SERVICE_PYTHON_BIN:-}"
FASTER_WHISPER_MODEL="${FIVE9_SERVICE_FASTER_WHISPER_MODEL:-}"
FASTER_WHISPER_DEVICE="${FIVE9_SERVICE_FASTER_WHISPER_DEVICE:-}"
FASTER_WHISPER_COMPUTE_TYPE="${FIVE9_SERVICE_FASTER_WHISPER_COMPUTE_TYPE:-}"
FASTER_WHISPER_LANGUAGE="${FIVE9_SERVICE_FASTER_WHISPER_LANGUAGE:-}"
OPENAI_API_KEY="${FIVE9_SERVICE_OPENAI_API_KEY:-}"
ENABLE_AUTOMATION="${FIVE9_SERVICE_ENABLE_AUTOMATION:-true}"
AUTOMATION_CRON="${FIVE9_SERVICE_AUTOMATION_CRON:-0 * * * *}"
AUTOMATION_TIMEZONE="${FIVE9_SERVICE_AUTOMATION_TIMEZONE:-America/Bogota}"
AUTOMATION_BACKFILL_DAYS_PER_RUN="${FIVE9_SERVICE_AUTOMATION_BACKFILL_DAYS_PER_RUN:-2}"
AUTOMATION_SYNC_MAX_PAGES="${FIVE9_SERVICE_AUTOMATION_SYNC_MAX_PAGES:-20}"

mkdir -p "${LOG_DIR}"

UID_NUM="$(id -u)"
if [[ -f "${PLIST_PATH}" ]]; then
  launchctl bootout "gui/${UID_NUM}" "${PLIST_PATH}" >/dev/null 2>&1 || true
fi

if lsof -nP -iTCP:${PORT} -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port ${PORT} is already in use. Set FIVE9_SERVICE_PORT to a free port."
  exit 1
fi

NODE_BIN="$(command -v node || true)"
if [[ -z "${NODE_BIN}" ]]; then
  echo "node not found in PATH"
  exit 1
fi

if [[ -z "${PYTHON_BIN}" && -x "${ROOT_DIR}/.venv/bin/python" ]]; then
  PYTHON_BIN="${ROOT_DIR}/.venv/bin/python"
fi

if [[ -z "${TRANSCRIBE_PROVIDER}" && -n "${PYTHON_BIN}" && -z "${OPENAI_API_KEY}" ]]; then
  TRANSCRIBE_PROVIDER="faster_whisper"
fi

if [[ -z "${SENTIMENT_PROVIDER}" && -z "${OPENAI_API_KEY}" ]]; then
  SENTIMENT_PROVIDER="heuristic"
fi

cd "${ROOT_DIR}"
echo "Building frontend (web/dist)..."
npm --workspace web run build

cat > "${PLIST_PATH}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${SERVICE_LABEL}</string>

    <key>WorkingDirectory</key>
    <string>${ROOT_DIR}/server</string>

    <key>ProgramArguments</key>
    <array>
      <string>${NODE_BIN}</string>
      <string>${ROOT_DIR}/server/src/index.js</string>
    </array>

    <key>EnvironmentVariables</key>
    <dict>
      <key>PORT</key>
      <string>${PORT}</string>
      <key>DATABASE_URL</key>
      <string>${DATABASE_URL}</string>
      <key>AUTH_MODE</key>
      <string>${AUTH_MODE}</string>
      <key>SERVE_WEB_DIST</key>
      <string>true</string>
EOF

if [[ -n "${BACKUP_ENDPOINT}" ]]; then
  cat >> "${PLIST_PATH}" <<EOF
      <key>BACKUP_ENDPOINT</key>
      <string>${BACKUP_ENDPOINT}</string>
EOF
fi

cat >> "${PLIST_PATH}" <<EOF
      <key>ENABLE_AUTOMATION</key>
      <string>${ENABLE_AUTOMATION}</string>
      <key>AUTOMATION_CRON</key>
      <string>${AUTOMATION_CRON}</string>
      <key>AUTOMATION_TIMEZONE</key>
      <string>${AUTOMATION_TIMEZONE}</string>
      <key>AUTOMATION_BACKFILL_DAYS_PER_RUN</key>
      <string>${AUTOMATION_BACKFILL_DAYS_PER_RUN}</string>
      <key>AUTOMATION_SYNC_MAX_PAGES</key>
      <string>${AUTOMATION_SYNC_MAX_PAGES}</string>
EOF

cat >> "${PLIST_PATH}" <<EOF
    </dict>

    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>${STDOUT_LOG}</string>
    <key>StandardErrorPath</key>
    <string>${STDERR_LOG}</string>
  </dict>
</plist>
EOF

if [[ -n "${TRANSCRIBE_PROVIDER}" ]]; then
  /usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:TRANSCRIBE_PROVIDER string ${TRANSCRIBE_PROVIDER}" "${PLIST_PATH}" >/dev/null 2>&1 || \
  /usr/libexec/PlistBuddy -c "Set :EnvironmentVariables:TRANSCRIBE_PROVIDER ${TRANSCRIBE_PROVIDER}" "${PLIST_PATH}"
fi

if [[ -n "${SENTIMENT_PROVIDER}" ]]; then
  /usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:SENTIMENT_PROVIDER string ${SENTIMENT_PROVIDER}" "${PLIST_PATH}" >/dev/null 2>&1 || \
  /usr/libexec/PlistBuddy -c "Set :EnvironmentVariables:SENTIMENT_PROVIDER ${SENTIMENT_PROVIDER}" "${PLIST_PATH}"
fi

if [[ -n "${OLLAMA_HOST}" ]]; then
  /usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:OLLAMA_HOST string ${OLLAMA_HOST}" "${PLIST_PATH}" >/dev/null 2>&1 || \
  /usr/libexec/PlistBuddy -c "Set :EnvironmentVariables:OLLAMA_HOST ${OLLAMA_HOST}" "${PLIST_PATH}"
fi

if [[ -n "${OLLAMA_SENTIMENT_MODEL}" ]]; then
  /usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:OLLAMA_SENTIMENT_MODEL string ${OLLAMA_SENTIMENT_MODEL}" "${PLIST_PATH}" >/dev/null 2>&1 || \
  /usr/libexec/PlistBuddy -c "Set :EnvironmentVariables:OLLAMA_SENTIMENT_MODEL ${OLLAMA_SENTIMENT_MODEL}" "${PLIST_PATH}"
fi

if [[ -n "${PYTHON_BIN}" ]]; then
  /usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:PYTHON_BIN string ${PYTHON_BIN}" "${PLIST_PATH}" >/dev/null 2>&1 || \
  /usr/libexec/PlistBuddy -c "Set :EnvironmentVariables:PYTHON_BIN ${PYTHON_BIN}" "${PLIST_PATH}"
fi

if [[ -n "${FASTER_WHISPER_MODEL}" ]]; then
  /usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:FASTER_WHISPER_MODEL string ${FASTER_WHISPER_MODEL}" "${PLIST_PATH}" >/dev/null 2>&1 || \
  /usr/libexec/PlistBuddy -c "Set :EnvironmentVariables:FASTER_WHISPER_MODEL ${FASTER_WHISPER_MODEL}" "${PLIST_PATH}"
fi

if [[ -n "${FASTER_WHISPER_DEVICE}" ]]; then
  /usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:FASTER_WHISPER_DEVICE string ${FASTER_WHISPER_DEVICE}" "${PLIST_PATH}" >/dev/null 2>&1 || \
  /usr/libexec/PlistBuddy -c "Set :EnvironmentVariables:FASTER_WHISPER_DEVICE ${FASTER_WHISPER_DEVICE}" "${PLIST_PATH}"
fi

if [[ -n "${FASTER_WHISPER_COMPUTE_TYPE}" ]]; then
  /usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:FASTER_WHISPER_COMPUTE_TYPE string ${FASTER_WHISPER_COMPUTE_TYPE}" "${PLIST_PATH}" >/dev/null 2>&1 || \
  /usr/libexec/PlistBuddy -c "Set :EnvironmentVariables:FASTER_WHISPER_COMPUTE_TYPE ${FASTER_WHISPER_COMPUTE_TYPE}" "${PLIST_PATH}"
fi

if [[ -n "${FASTER_WHISPER_LANGUAGE}" ]]; then
  /usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:FASTER_WHISPER_LANGUAGE string ${FASTER_WHISPER_LANGUAGE}" "${PLIST_PATH}" >/dev/null 2>&1 || \
  /usr/libexec/PlistBuddy -c "Set :EnvironmentVariables:FASTER_WHISPER_LANGUAGE ${FASTER_WHISPER_LANGUAGE}" "${PLIST_PATH}"
fi

if [[ -n "${OPENAI_API_KEY}" ]]; then
  /usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:OPENAI_API_KEY string ${OPENAI_API_KEY}" "${PLIST_PATH}" >/dev/null 2>&1 || \
  /usr/libexec/PlistBuddy -c "Set :EnvironmentVariables:OPENAI_API_KEY ${OPENAI_API_KEY}" "${PLIST_PATH}"
fi

launchctl bootout "gui/${UID_NUM}" "${PLIST_PATH}" >/dev/null 2>&1 || true
launchctl bootstrap "gui/${UID_NUM}" "${PLIST_PATH}"
launchctl enable "gui/${UID_NUM}/${SERVICE_LABEL}" >/dev/null 2>&1 || true
launchctl kickstart -k "gui/${UID_NUM}/${SERVICE_LABEL}"

echo "installed=true"
echo "label=${SERVICE_LABEL}"
echo "plist=${PLIST_PATH}"
echo "url=http://127.0.0.1:${PORT}"
echo "logs=${LOG_DIR}"
