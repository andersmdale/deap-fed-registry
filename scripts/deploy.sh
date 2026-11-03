#!/usr/bin/env bash
# Pull new code, rebuild and restart the registry service (macOS launchd or Linux systemd).
# The database is untouched; schema upgrades run when the server starts.
set -euo pipefail
cd "$(dirname "$0")/.."
if git rev-parse --git-dir >/dev/null 2>&1; then git pull --ff-only; fi
npm ci
npm run build
case "$(uname)" in
  Darwin)
    launchctl kickstart -k "gui/$(id -u)/org.deapfed.registry"
    echo "Restarted org.deapfed.registry." ;;
  Linux)
    if [ -f /etc/systemd/system/deap-fed-registry.service ]; then sudo systemctl restart deap-fed-registry
    else systemctl --user restart deap-fed-registry; fi
    echo "Restarted deap-fed-registry." ;;
  *) echo "Built. Restart the server yourself (node server/dist/index.js)." ;;
esac
