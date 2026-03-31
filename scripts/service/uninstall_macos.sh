#!/usr/bin/env bash
set -euo pipefail

SERVICE_LABEL="com.gsdoutsource.five9-command-center"
PLIST_PATH="${HOME}/Library/LaunchAgents/${SERVICE_LABEL}.plist"

UID_NUM="$(id -u)"
launchctl bootout "gui/${UID_NUM}" "${PLIST_PATH}" >/dev/null 2>&1 || true
rm -f "${PLIST_PATH}"

echo "uninstalled=true"
echo "label=${SERVICE_LABEL}"
