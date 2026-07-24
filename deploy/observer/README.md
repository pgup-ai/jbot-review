# Observer gateway — VPS deploy

Self-hosts the [observer gateway](../../src/gateway) on any RHEL-family box
(one node process behind Caddy TLS). Deploys are two files —
`dist/gateway/server.js` + `dist/package.json` — rsynced by the
[deploy-observer workflow](../../.github/workflows/deploy-observer.yml) on
every gateway change merged to main.

## One-time setup

1. **DNS**: `A` record `observer.<your-domain>` → the VPS IP (any DNS host).
2. **On the box** (as root):

   ```sh
   ./install.sh observer.<your-domain>
   ```

   Installs Caddy (auto-TLS), the `jbot-gateway` systemd unit, a
   `jbot-deploy` CI user (sudo scoped to restarting the gateway), and
   generates `JBOT_GATEWAY_TOKEN` into `/etc/jbot-gateway/env`. The gateway
   binds loopback (`JBOT_GATEWAY_HOST=127.0.0.1`), so Caddy's TLS is the
   only path in — with or without a host firewall. Re-run safely.

3. **CI deploy key**: generate a dedicated keypair, put the public half in
   `/home/jbot-deploy/.ssh/authorized_keys` (mode 600, owner `jbot-deploy`).
4. **Repo secrets** (secrets, not vars — they must stay out of public logs):

   | Secret              | Value                                       |
   | ------------------- | ------------------------------------------- |
   | `VPS_SSH_KEY`       | the private key from step 3                 |
   | `VPS_HOST`          | the VPS IP or hostname                      |
   | `VPS_HOST_KEY`      | one line of `ssh-keyscan -t ed25519 <host>` |
   | `OBSERVER_HOSTNAME` | `observer.<your-domain>`                    |

5. **First deploy**: run the `Deploy Observer Gateway` workflow manually
   (`workflow_dispatch`); it builds, rsyncs, restarts, and checks
   `/healthz`. Later merges that touch `src/gateway/**` redeploy on their
   own.

## Pointing reviews at it

Set on the review process (e.g. `env:` on the action step, or the shell for
`npm run review:local`):

```sh
JBOT_OBSERVER_URL=https://observer.<your-domain>
JBOT_OBSERVER_TOKEN=<token from /etc/jbot-gateway/env>
```

Viewer: `https://observer.<your-domain>/?token=<token>`.

## Notes

- Migrating hosts = re-run `install.sh` + copy `/var/lib/jbot-gateway`
  (journals) and `/etc/jbot-gateway/env` (token).
- The gateway is single-process by design (in-memory SSE fan-out): one
  instance, no replicas.
