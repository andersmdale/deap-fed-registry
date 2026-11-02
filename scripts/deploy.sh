#!/usr/bin/env bash
# Rebuild after pulling new code and restart the launchd service (no database changes are lost; schema upgrades run at start).
set -euo pipefail
cd "$(dirname "$0")/.."
LABEL="org.deapfed.registry"
if git rev-parse --git-dir >/dev/null 2>&1; then git pull --ff-only; fi
npm ci
npm run build
launchctl kickstart -k "gui/$(id -u)/$LABEL"
echo "Restarted $LABEL."
