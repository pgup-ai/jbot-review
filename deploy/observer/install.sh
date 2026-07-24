#!/usr/bin/env bash
# One-time observer gateway setup for a RHEL-family host (AlmaLinux 8/9).
# Usage: sudo ./install.sh observer.example.com
# Idempotent and additive: installs caddy + the jbot-gateway unit, never
# touches node or unrelated services. Re-run safely after edits.
set -euo pipefail

OBSERVER_HOSTNAME="${1:?usage: install.sh <observer-hostname>}"
APP_DIR=/opt/jbot-observer
ENV_FILE=/etc/jbot-gateway/env
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }

# The gateway reuses the host's node (>=20); other services may depend on the
# installed version, so this script never installs or upgrades node.
NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || { echo "node not found on PATH; install Node.js >=20 first" >&2; exit 1; }

# Users: jbot-gateway runs the service; jbot-deploy owns $APP_DIR and is the
# CI rsync/ssh target.
id -u jbot-gateway >/dev/null 2>&1 || useradd -r -s /sbin/nologin jbot-gateway
id -u jbot-deploy >/dev/null 2>&1 || useradd -m -s /bin/bash jbot-deploy
install -d -o jbot-deploy -g jbot-deploy "$APP_DIR" "$APP_DIR/dist"
install -d -m 700 -o jbot-deploy -g jbot-deploy /home/jbot-deploy/.ssh

# Token: generated once; survives re-runs.
if [ ! -f "$ENV_FILE" ]; then
  install -d -m 755 /etc/jbot-gateway
  umask 077
  {
    echo "JBOT_GATEWAY_TOKEN=$(openssl rand -hex 32)"
    echo "JBOT_GATEWAY_DATA=/var/lib/jbot-gateway"
    # Loopback + token: Caddy is the only public door, firewall or not.
    echo "JBOT_GATEWAY_HOST=127.0.0.1"
  } > "$ENV_FILE"
fi

sed "s|/usr/bin/node|$NODE_BIN|" "$SCRIPT_DIR/jbot-gateway.service" \
  > /etc/systemd/system/jbot-gateway.service
systemctl daemon-reload
systemctl enable jbot-gateway

# CI may only restart the gateway — nothing else. visudo-check before
# installing: a malformed sudoers.d file fails sudo closed for the whole box.
SUDOERS_TMP="$(mktemp)"
echo 'jbot-deploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart jbot-gateway' > "$SUDOERS_TMP"
visudo -cf "$SUDOERS_TMP"
install -m 0440 "$SUDOERS_TMP" /etc/sudoers.d/jbot-deploy
rm -f "$SUDOERS_TMP"

# Caddy terminates TLS. Refuse to clobber a Caddyfile some other service owns.
CADDY_WAS_ACTIVE=false
systemctl is-active --quiet caddy && CADDY_WAS_ACTIVE=true
if ! command -v caddy >/dev/null; then
  dnf -y install 'dnf-command(copr)'
  dnf -y copr enable @caddy/caddy
  dnf -y install caddy
fi
MARK="# managed by jbot-observer install.sh"
if $CADDY_WAS_ACTIVE && ! grep -q "$MARK" /etc/caddy/Caddyfile 2>/dev/null; then
  echo "caddy is already active with an unmanaged Caddyfile;" >&2
  echo "add the site block from $SCRIPT_DIR/Caddyfile (hostname: $OBSERVER_HOSTNAME) yourself" >&2
else
  {
    echo "$MARK"
    sed "s|{\$OBSERVER_HOSTNAME}|$OBSERVER_HOSTNAME|" "$SCRIPT_DIR/Caddyfile"
  } > /etc/caddy/Caddyfile
  systemctl enable caddy
  systemctl reload-or-restart caddy
fi

# SELinux: caddy runs confined as httpd_t; allow its loopback proxy hop.
if command -v getenforce >/dev/null && [ "$(getenforce)" != "Disabled" ]; then
  setsebool -P httpd_can_network_connect 1
fi

# Firewall (when one is running): only caddy's ports. The gateway itself
# binds loopback (JBOT_GATEWAY_HOST), so 8790 is unreachable either way.
if systemctl is-active --quiet firewalld; then
  firewall-cmd --permanent --add-service=http --add-service=https >/dev/null
  firewall-cmd --reload >/dev/null
fi

# First gateway start happens after CI rsyncs the build (Restart=always would
# crash-loop on a missing file).
if [ -f "$APP_DIR/dist/gateway/server.js" ]; then
  systemctl restart jbot-gateway
fi

echo
echo "installed. $(grep JBOT_GATEWAY_TOKEN "$ENV_FILE")"
echo "next: DNS A record $OBSERVER_HOSTNAME -> this host, CI deploy key in"
echo "/home/jbot-deploy/.ssh/authorized_keys, repo secrets, then run the"
echo "deploy-observer workflow (see deploy/observer/README.md)."
