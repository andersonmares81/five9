#!/bin/zsh
set -euo pipefail

SERVICE_LABEL="com.gsdoutsource.five9-command-center"
UID_NUM="$(id -u)"

launchctl print "gui/${UID_NUM}/${SERVICE_LABEL}" 2>/dev/null || {
  echo "loaded=false"
  echo "label=${SERVICE_LABEL}"
  exit 0
}
