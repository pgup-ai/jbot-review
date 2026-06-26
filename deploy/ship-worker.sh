#!/usr/bin/env bash
#
# ship-worker.sh — build + (re)deploy the jbot-review worker to the VPS.
#
# Idempotent: safe to run every test cycle. Reads its config from the gitignored
# deploy/jbot-review-worker.env.local (copy it from the .example). It MUTATES the
# production VPS (ships files, writes /etc/jbot-review-worker.env, restarts the
# service) — review before running.
#
# Usage:
#   cp deploy/jbot-review-worker.env.local{.example,}   # then fill it in (once)
#   ./deploy/ship-worker.sh
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "${HERE}/.." && pwd)"
ENV_LOCAL="${HERE}/jbot-review-worker.env.local"
REMOTE_DIR="/opt/jbot-review"

# ---- config ---------------------------------------------------------------
[ -f "${ENV_LOCAL}" ] || {
  echo "ERROR: ${ENV_LOCAL} not found." >&2
  echo "       cp ${HERE}/jbot-review-worker.env.local.example ${ENV_LOCAL} and fill it in." >&2
  exit 1
}
set -a; # shellcheck disable=SC1090
source "${ENV_LOCAL}"; set +a
: "${VPS_HOST:=jbot-vps}"
: "${WORKER_POLL_MS:=5000}"

for v in CONTROL_PLANE_URL WORKER_SHARED_SECRET; do
  [ -n "${!v:-}" ] || { echo "ERROR: ${ENV_LOCAL} is missing ${v}" >&2; exit 1; }
done
case "${CONTROL_PLANE_URL}" in
  https://*) ;;
  http://localhost*|http://127.0.0.1*) ;;
  *) echo "ERROR: CONTROL_PLANE_URL must be https:// (localhost allowed) — got '${CONTROL_PLANE_URL}'" >&2; exit 1;;
esac
[ "${#WORKER_SHARED_SECRET}" -ge 32 ] || { echo "ERROR: WORKER_SHARED_SECRET must be >=32 chars" >&2; exit 1; }

echo "==> target: ${VPS_HOST}:${REMOTE_DIR}  control plane: ${CONTROL_PLANE_URL}"

# ---- 1. build locally -----------------------------------------------------
echo "==> 1/6 build"
( cd "${REPO}" && npm run build )
[ -f "${REPO}/dist/worker/index.js" ] || { echo "ERROR: dist/worker/index.js missing after build" >&2; exit 1; }

# ---- 2. ensure the dedicated worker user (unit runs as User=jbot-worker) ---
echo "==> 2/6 ensure jbot-worker user"
ssh "${VPS_HOST}" 'id jbot-worker >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin jbot-worker'

# ---- 3. ship the build + deploy assets ------------------------------------
echo "==> 3/6 ship dist + deploy + manifests"
# Exclude the gitignored secret env file — it must never be shipped into the
# deploy dir (the secret reaches the box only as mode-600 /etc/jbot-review-worker.env, step 4).
( cd "${REPO}" && tar czf - --exclude='deploy/jbot-review-worker.env.local' \
    dist deploy package.json package-lock.json ) \
  | ssh "${VPS_HOST}" "tar xzf - -C ${REMOTE_DIR}"
ssh "${VPS_HOST}" "chown -R jbot-worker:jbot-worker ${REMOTE_DIR}/dist && ls -l ${REMOTE_DIR}/dist/worker/index.js"
# If package.json deps changed since the box was last provisioned, also run:
#   ssh "${VPS_HOST}" "cd ${REMOTE_DIR} && npm ci --omit=dev"

# ---- 4. write the worker env (mode 600, NO provider keys) ------------------
echo "==> 4/6 write /etc/jbot-review-worker.env"
# Secret travels via stdin (not argv), so it never lands in the remote process list.
printf 'CONTROL_PLANE_URL=%s\nWORKER_SHARED_SECRET=%s\nWORKER_POLL_MS=%s\n' \
  "${CONTROL_PLANE_URL}" "${WORKER_SHARED_SECRET}" "${WORKER_POLL_MS}" \
  | ssh "${VPS_HOST}" 'umask 077; cat > /etc/jbot-review-worker.env && chmod 600 /etc/jbot-review-worker.env'
if [ "$(ssh "${VPS_HOST}" 'grep -ci API_KEY /etc/jbot-review-worker.env')" != "0" ]; then
  echo "SECURITY ABORT: a provider *_API_KEY appeared in the worker env" >&2; exit 1
fi

# ---- 5. install + (re)start the unit --------------------------------------
echo "==> 5/6 install + restart unit"
ssh "${VPS_HOST}" "
  set -e
  cp ${REMOTE_DIR}/deploy/jbot-review-worker.service /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable jbot-review-worker >/dev/null 2>&1 || true
  systemctl restart jbot-review-worker
  sleep 2
  systemctl is-active jbot-review-worker
"

# ---- 6. recent logs -------------------------------------------------------
echo "==> 6/6 recent logs"
ssh "${VPS_HOST}" "journalctl -u jbot-review-worker --no-pager -n 15"
echo
echo "OK. Tail live with:  ssh ${VPS_HOST} 'journalctl -u jbot-review-worker -f'"
echo "Expect a line like:  [worker] polling ${CONTROL_PLANE_URL} every ${WORKER_POLL_MS}ms"
