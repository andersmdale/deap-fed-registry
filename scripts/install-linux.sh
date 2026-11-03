#!/usr/bin/env bash
# Install or update the DEAP-Fed Data Registry as a systemd service on Linux.
#   scripts/install-linux.sh                  user service (no root needed): runs as you
#   sudo -E scripts/install-linux.sh --system system service: starts at boot, runs as the invoking user
# Options via environment: REGISTRY_PORT (8095), REGISTRY_DATA (~/deap-fed-registry-data).
# Keep the data directory on a local disk, not a synced or network folder: SQLite needs reliable file locks.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="$(pwd)"
MODE="user"; [ "${1:-}" = "--system" ] && MODE="system"
RUN_USER="${SUDO_USER:-$(id -un)}"
RUN_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)"
PORT="${REGISTRY_PORT:-8095}"
DATA="${REGISTRY_DATA:-$RUN_HOME/deap-fed-registry-data}"
NODE="$(command -v node || true)"
UNIT="deap-fed-registry.service"

[ -n "$NODE" ] || { echo "Node.js isn't on PATH. Install Node.js 22.13 or newer (e.g. via nvm: https://github.com/nvm-sh/nvm)."; exit 1; }
"$NODE" -e 'require("node:sqlite")' 2>/dev/null || {
  echo "Node.js $("$NODE" -v) has no built-in SQLite; install Node.js 22.13 or newer."; exit 1; }
case "$DATA" in *Dropbox*|/mnt/*|/net/*) echo "Put REGISTRY_DATA on a local disk ($DATA looks synced or network-mounted)."; exit 1;; esac
if [ "$MODE" = "system" ] && [ "$(id -u)" -ne 0 ]; then echo "--system needs sudo: sudo -E $0 --system"; exit 1; fi

echo "== installing dependencies and building (as $RUN_USER)"
as_user() { if [ "$(id -un)" = "$RUN_USER" ]; then "$@"; else sudo -u "$RUN_USER" -E env PATH="$PATH" "$@"; fi; }
as_user npm ci
as_user npm run build
as_user mkdir -p "$DATA"
as_user sh -c "echo '$DATA' > '$REPO/.registry-data'"   # so `npm run cli` finds the same database

SERVICE="[Unit]
Description=DEAP-Fed Data Registry
After=network.target

[Service]
WorkingDirectory=$REPO
ExecStart=$NODE --disable-warning=ExperimentalWarning $REPO/server/dist/index.js
Environment=REGISTRY_PORT=$PORT
Environment=REGISTRY_DATA=$DATA
Restart=always
RestartSec=3
StandardOutput=append:$DATA/registry.log
StandardError=append:$DATA/registry.log"

if [ "$MODE" = "system" ]; then
  printf '%s\nUser=%s\n\n[Install]\nWantedBy=multi-user.target\n' "$SERVICE" "$RUN_USER" > "/etc/systemd/system/$UNIT"
  systemctl daemon-reload
  systemctl enable --now "$UNIT"
  systemctl restart "$UNIT"
  CTL="sudo systemctl"
else
  mkdir -p "$HOME/.config/systemd/user"
  printf '%s\n\n[Install]\nWantedBy=default.target\n' "$SERVICE" > "$HOME/.config/systemd/user/$UNIT"
  systemctl --user daemon-reload
  systemctl --user enable --now "$UNIT"
  systemctl --user restart "$UNIT"
  CTL="systemctl --user"
  if [ "$(loginctl show-user "$RUN_USER" -p Linger --value 2>/dev/null)" != "yes" ]; then
    echo "!! A user service stops when you log out. Keep it running with:  loginctl enable-linger $RUN_USER"
    echo "   (may need an admin: sudo loginctl enable-linger $RUN_USER), or reinstall with: sudo -E $0 --system"
  fi
fi

echo "== waiting for the server to answer on port $PORT"
ok=""
for _ in $(seq 1 30); do
  if curl -kfsS "https://localhost:$PORT/api/auth/setup" >/dev/null 2>&1; then ok=https; break; fi
  if curl -fsS "http://localhost:$PORT/api/auth/setup" >/dev/null 2>&1; then ok=http; break; fi
  sleep 1
done
if [ -n "$ok" ]; then
  echo "== running on $ok://$(hostname -f 2>/dev/null || hostname):$PORT  (log: $DATA/registry.log; restart: $CTL restart $UNIT)"
  if [ "$ok" = http ]; then echo "   Plain HTTP. Turn on HTTPS with: scripts/tls.sh self-signed $(hostname -f 2>/dev/null || hostname)"; fi
else
  echo "!! the server didn't answer within 30 s. Last lines of $DATA/registry.log:"
  tail -n 30 "$DATA/registry.log" 2>/dev/null || echo "(no log yet)"
  exit 1
fi
if [ -f "$DATA/setup-token.txt" ]; then
  echo "== first run: open the site and create the admin account with this setup token:"
  cat "$DATA/setup-token.txt"
fi
