#!/usr/bin/env bash
# Install or update the DEAP-Fed Data Registry as a launchd service on macOS (runs as you, starts at login, restarts if it stops).
#   scripts/install-mac.sh                          defaults: port 8095, data in ~/deap-fed-registry-data
#   REGISTRY_PORT=8096 REGISTRY_DATA=/path scripts/install-mac.sh
# Keep the data directory OUT of Dropbox: syncing a live SQLite database can corrupt it.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="$(pwd)"
LABEL="org.deapfed.registry"
PORT="${REGISTRY_PORT:-8095}"
DATA="${REGISTRY_DATA:-$HOME/deap-fed-registry-data}"
NODE="$(command -v node || true)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

[ -n "$NODE" ] || { echo "Node.js isn't installed or not on PATH (need version 22.13 or newer)."; exit 1; }
"$NODE" -e 'require("node:sqlite")' 2>/dev/null || {
  echo "Node.js $("$NODE" -v) has no built-in SQLite; install Node.js 22.13 or newer (e.g. brew upgrade node)."; exit 1; }
case "$DATA" in *Dropbox*) echo "Refusing to keep the database in Dropbox ($DATA). Set REGISTRY_DATA to a local folder."; exit 1;; esac

echo "== installing dependencies and building"
npm ci
npm run build
mkdir -p "$DATA" "$HOME/Library/LaunchAgents"
echo "$DATA" > "$REPO/.registry-data"   # so `npm run cli` finds the same database

echo "== writing $PLIST"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>--disable-warning=ExperimentalWarning</string><string>$REPO/server/dist/index.js</string></array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>EnvironmentVariables</key><dict>
    <key>REGISTRY_PORT</key><string>$PORT</string>
    <key>REGISTRY_DATA</key><string>$DATA</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DATA/registry.log</string>
  <key>StandardErrorPath</key><string>$DATA/registry.log</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "== waiting for the server to answer on port $PORT"
ok=""
for _ in $(seq 1 30); do
  if curl -kfsS "https://localhost:$PORT/api/auth/setup" >/dev/null 2>&1; then ok=https; break; fi
  if curl -fsS "http://localhost:$PORT/api/auth/setup" >/dev/null 2>&1; then ok=http; break; fi
  sleep 1
done
if [ -n "$ok" ]; then
  echo "== running on $ok://localhost:$PORT  (log: $DATA/registry.log)"
  if [ "$ok" = http ]; then echo "   Plain HTTP. Turn on HTTPS with: scripts/tls.sh self-signed <hostname>   (or scripts/tls.sh install <cert> <key>)"; fi
else
  echo "!! the server didn't answer within 30 s. Last lines of $DATA/registry.log:"
  tail -n 30 "$DATA/registry.log" 2>/dev/null || echo "(no log yet)"
  launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | grep -E "state =|last exit" || true
  exit 1
fi
if [ -f "$DATA/setup-token.txt" ]; then
  echo "== first run: open the site and create the admin account with this setup token:"
  cat "$DATA/setup-token.txt"
fi
