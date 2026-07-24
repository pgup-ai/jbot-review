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
# The unit's ProtectHome=true hides /root and /home from the service — an
# nvm-style node there would crash-loop it.
NODE_BIN="$(readlink -f "$NODE_BIN")"
case "$NODE_BIN" in
  /home/* | /root/*)
    echo "node resolves to $NODE_BIN; the service needs a system-wide install (ProtectHome=true)" >&2
    exit 1
    ;;
esac

# Users: jbot-gateway runs the service; jbot-deploy owns $APP_DIR and is the
# CI rsync/ssh target.
id -u jbot-gateway >/dev/null 2>&1 || useradd -r -s /sbin/nologin jbot-gateway
id -u jbot-deploy >/dev/null 2>&1 || useradd -m -s /bin/bash jbot-deploy
install -d -o jbot-deploy -g jbot-deploy "$APP_DIR" "$APP_DIR/dist"
install -d -m 700 -o jbot-deploy -g jbot-deploy /home/jbot-deploy/.ssh

# Token: generated once; survives re-runs. Subshell so the tight umask
# cannot leak onto later files (the Caddyfile must stay caddy-readable).
if [ ! -f "$ENV_FILE" ]; then
  install -d -m 755 /etc/jbot-gateway
  (
    umask 077
    {
      echo "JBOT_GATEWAY_TOKEN=$(openssl rand -hex 32)"
      echo "JBOT_GATEWAY_DATA=/var/lib/jbot-gateway"
      # Loopback + token: Caddy is the only public door, firewall or not.
      echo "JBOT_GATEWAY_HOST=127.0.0.1"
    } > "$ENV_FILE"
  )
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

# Caddy terminates TLS. Never clobber a Caddyfile some other setup owns:
# the guard keys on the FILE pre-existing (captured before dnf can install a
# package default), so even a pre-staged config with no caddy binary is safe.
CADDYFILE=/etc/caddy/Caddyfile
MARK="# managed by jbot-observer install.sh"
CADDYFILE_PREEXISTED=false
[ -f "$CADDYFILE" ] && CADDYFILE_PREEXISTED=true
if ! command -v caddy >/dev/null; then
  dnf -y install 'dnf-command(copr)'
  dnf -y copr enable @caddy/caddy
  dnf -y install caddy
fi
SITE="$(
  echo "$MARK"
  sed "s|{\$OBSERVER_HOSTNAME}|$OBSERVER_HOSTNAME|" "$SCRIPT_DIR/Caddyfile"
)"
if $CADDYFILE_PREEXISTED && ! grep -q "$MARK" "$CADDYFILE"; then
  echo "pre-existing unmanaged $CADDYFILE;" >&2
  echo "add the site block from $SCRIPT_DIR/Caddyfile (hostname: $OBSERVER_HOSTNAME) yourself" >&2
else
  # A hand-edited managed file is still rewritten (that is what managed
  # means), but never silently: keep the previous copy next to it.
  if [ -f "$CADDYFILE" ] && grep -q "$MARK" "$CADDYFILE" && ! printf '%s\n' "$SITE" | cmp -s - "$CADDYFILE"; then
    cp -p "$CADDYFILE" "$CADDYFILE.bak"
    echo "rewrote managed $CADDYFILE; previous copy at $CADDYFILE.bak"
  fi
  printf '%s\n' "$SITE" > "$CADDYFILE"
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

# ConditionPathExists in the unit makes this a clean no-op until the first
# CI rsync delivers the bundle.
systemctl restart jbot-gateway

echo
echo "installed. gateway token is in $ENV_FILE"
echo "next: DNS A record $OBSERVER_HOSTNAME -> this host, CI deploy key in"
echo "/home/jbot-deploy/.ssh/authorized_keys, repo secrets, then run the"
echo "deploy-observer workflow (see deploy/observer/README.md)."
