#!/usr/bin/env bash
# Turn on HTTPS for the registry, then restart it.
#   scripts/tls.sh self-signed [hostname ...]   make a self-signed certificate (browsers warn until you trust it)
#   scripts/tls.sh install <cert.pem> <key.pem> use a real certificate (full chain) and its private key
#   scripts/tls.sh status                       show the certificate in use
# Files go to <data>/tls/cert.pem and key.pem, where the server looks for them.
set -euo pipefail
cd "$(dirname "$0")/.."
DATA="${REGISTRY_DATA:-$( [ -f .registry-data ] && cat .registry-data || echo "$HOME/deap-fed-registry-data")}"
TLS="$DATA/tls"
mkdir -p "$TLS" && chmod 700 "$TLS"

restart() {
  case "$(uname)" in
    Darwin) launchctl kickstart -k "gui/$(id -u)/org.deapfed.registry" 2>/dev/null && echo "Restarted the registry." ;;
    Linux)
      if [ -f /etc/systemd/system/deap-fed-registry.service ]; then sudo systemctl restart deap-fed-registry && echo "Restarted the registry."
      else systemctl --user restart deap-fed-registry 2>/dev/null && echo "Restarted the registry."; fi ;;
  esac || echo "Restart the registry to pick up the certificate."
}

case "${1:-}" in
  self-signed)
    shift
    names=("$@"); [ ${#names[@]} -eq 0 ] && names=("$(hostname -f 2>/dev/null || hostname)")
    san="DNS:localhost,IP:127.0.0.1"; for n in "${names[@]}"; do san="DNS:$n,$san"; done
    openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 825 -subj "/CN=${names[0]}/O=DEAP-Fed Data Registry" \
      -addext "subjectAltName=$san" -keyout "$TLS/key.pem" -out "$TLS/cert.pem" 2>/dev/null
    chmod 600 "$TLS/key.pem"
    echo "Self-signed certificate for ${names[*]} written to $TLS (valid 825 days)."
    restart ;;
  install)
    [ $# -eq 3 ] || { echo "Usage: scripts/tls.sh install <cert.pem> <key.pem>"; exit 2; }
    openssl x509 -in "$2" -noout >/dev/null || { echo "$2 isn't a PEM certificate."; exit 1; }
    cmp -s <(openssl x509 -in "$2" -noout -pubkey) <(openssl pkey -in "$3" -pubout) || { echo "The key doesn't match the certificate."; exit 1; }
    install -m 644 "$2" "$TLS/cert.pem"
    install -m 600 "$3" "$TLS/key.pem"
    echo "Installed $(openssl x509 -in "$TLS/cert.pem" -noout -subject -enddate | tr '\n' ' ')"
    restart ;;
  status)
    if [ -f "$TLS/cert.pem" ]; then openssl x509 -in "$TLS/cert.pem" -noout -subject -issuer -enddate -ext subjectAltName 2>/dev/null
    else echo "No certificate in $TLS: the registry serves plain HTTP."; fi ;;
  *) sed -n '2,6p' "$0" | sed 's/^# //'; exit 2 ;;
esac
