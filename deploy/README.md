# Deploying the jbot-review worker (Part 3)

Step-by-step runbook to deploy the polling **worker** to a VPS as a **native Node
process** (Model 1). The worker pulls one review job at a time from the
**control plane** (`jbot-review-app`), runs `runPrReview`, and reports status
back. This is deferred from the worker PR — do it once the control-plane
claim/update API is live.

## How it fits together

```
GitHub PR ──webhook──▶ control plane (jbot-review-app, e.g. on Render)
                          └─ enqueues a `review_jobs` row (status=queued)
VPS worker ──poll: POST /internal/jobs/claim──▶ control plane
           ◀── one job: model + DECRYPTED provider key + ~1h installation token
   → runs the review, posts comments on the PR
           ──PATCH /internal/jobs/:id──▶ control plane (running → success/failed)
```

**Security model:** the worker holds **no provider keys and no GitHub App private
key**. Its env file contains only the control-plane URL + a shared secret. The
user's BYOK key and a short-lived installation token arrive **per job, over TLS**,
and live only in worker memory. (This is why keys stay on the control plane —
the worker executes untrusted PR code via opencode's `bash`.)

## Prerequisites

- A VPS with **Node 20**, **git**, and **opencode** (`npm i -g opencode-ai@latest`).
  The existing CloudCone box (`ssh jbot-vps`, `/opt/jbot-review`) already has these.
- The **control plane reachable over HTTPS** — the `jbot-review-app` API exposing
  `/internal/jobs/*` (deployed to Render, or fronted by a `cloudflared` tunnel for
  local testing). The worker **rejects non-`https://`** URLs (localhost allowed).
- One **shared secret**, set on BOTH sides:
  ```bash
  openssl rand -hex 32        # → WORKER_SHARED_SECRET
  ```
  Put it in the control plane's env (e.g. Render `WORKER_SHARED_SECRET`) AND in the
  worker env file below — they must match.

## 1. Build

```bash
npm run build                 # emits dist/, incl. dist/worker/index.js
ls dist/worker/index.js
```

## 2. Ship to the VPS

`dist/` is gitignored, so copy the built artifacts up (the box already has prod
`node_modules`; only re-install if `package.json` changed):

```bash
tar czf - dist deploy package.json package-lock.json | ssh jbot-vps 'tar xzf - -C /opt/jbot-review'
ssh jbot-vps 'cd /opt/jbot-review && npm ci --omit=dev'    # only if deps changed
ssh jbot-vps 'ls -l /opt/jbot-review/dist/worker/index.js'
```

## 3. (Recommended) run as a dedicated non-root user

The worker clones untrusted PR code and runs opencode, so don't run it as root:

```bash
ssh jbot-vps '
  useradd --system --create-home --shell /usr/sbin/nologin jbot-worker || true
  chown -R jbot-worker:jbot-worker /opt/jbot-review
'
```

Then uncomment `# User=jbot-worker` in `deploy/jbot-review-worker.service` before
installing it. (Skip this to run as root — matches the current hosted app, but
less safe.)

## 4. Worker env file (no provider keys!)

```bash
ssh jbot-vps 'umask 077; cat > /etc/jbot-review-worker.env <<EOF
CONTROL_PLANE_URL=https://<control-plane-host>
WORKER_SHARED_SECRET=<same value as the control plane>
WORKER_POLL_MS=5000
EOF
chmod 600 /etc/jbot-review-worker.env'

# Sanity: the worker env must hold NO provider keys.
ssh jbot-vps 'grep -ci API_KEY /etc/jbot-review-worker.env'    # → 0
```

## 5. Install + start the service

```bash
ssh jbot-vps '
  cp /opt/jbot-review/deploy/jbot-review-worker.service /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable --now jbot-review-worker
  sleep 2; systemctl is-active jbot-review-worker
  journalctl -u jbot-review-worker --no-pager -n 15
'
```

Expect `active` and a log line `[worker] polling https://… every 5000ms` (then
quiet — the queue is empty until a webhook fires).

## 6. Point GitHub at the control plane (not the VPS)

The GitHub App webhook can target only one URL; for the dashboard/BYOK flow it
must hit the **control plane**, not the old VPS hosted app:

- GitHub App settings → **Webhook URL** = `https://<control-plane>/github/webhook`,
  **Secret** = the control plane's `GITHUB_WEBHOOK_SECRET`, subscribe to **Pull request**.
- Retire the old hosted app on the box (the worker needs no inbound port/tunnel):
  ```bash
  ssh jbot-vps 'systemctl disable --now jbot-review.service cloudflared.service'
  ```

## 7. End-to-end verification

1. On a connected repo (App installed + linked to a user who has a BYOK key for
   the configured model's provider and **reviews enabled**), open or push to a PR.
2. Watch the flow:
   - control-plane log: `Enqueued review job <id> …`
   - dashboard **History**: the job goes `queued` → `running`
   - worker: `ssh jbot-vps 'journalctl -u jbot-review-worker -f'` → `claimed <id> …` → `job <id> -> success`
   - the PR receives J-Bot review comments
   - History flips to `success`
3. Negative check: a user with reviews enabled but **no key** for the model's
   provider → the job lands `failed` quickly (claim's no-key path), worker moves on.

## Rollback

Re-point the GitHub App webhook back to the VPS hosted app URL and
`systemctl enable --now jbot-review.service cloudflared.service`; then
`systemctl disable --now jbot-review-worker`.

## Alternative: containerized (Model 2)

The GitHub Action already publishes `ghcr.io/pgup-ai/jbot-review`. To run the
worker as a container instead of natively (container-level isolation; needs
Docker on the box, tight on 1 GB):

```bash
docker run -d --restart=unless-stopped --env-file /etc/jbot-review-worker.env \
  ghcr.io/pgup-ai/jbot-review node /app/dist/worker/index.js
```

The native systemd unit above is the v1 path; per-review container isolation
(Model 3) is a later hardening that needs a bigger box + per-job orchestration.
