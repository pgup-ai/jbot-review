# jbot-review

An agentic PR reviewer built on OpenCode. Two deployment modes, one review engine:

| Mode                  | Trigger             | Runs on                                    | Repo config needed             |
| --------------------- | ------------------- | ------------------------------------------ | ------------------------------ |
| **In-repo workflow**  | PR opened/synced    | User's GitHub Actions runner               | One YAML file + one secret     |
| **Hosted GitHub App** | Webhook from GitHub | Your infrastructure (Cloud Run, VPS, etc.) | Install once, zero repo config |

The review core (`runner.ts` + `opencode.ts` + `github.ts`) is shared between both.

## In-repo workflow

The review runs as a Docker container action inside the user's GitHub Actions
runner. The source code is private; users only see the public [`pgup-ai/jbot-review-action`](https://github.com/pgup-ai/jbot-review-action) repo with the thin `action.yml`.

### How it works

1. The user drops a workflow file into `.github/workflows/` and adds an API key
   as a repo secret.
2. On `pull_request` events, GitHub Actions checks out their repo and runs
   the `jbot-review` Docker container action.
3. The action pulls the pre-built image from `ghcr.io/pgup-ai/jbot-review`,
   starts `opencode serve` inside the container, and drives a read-only `plan`
   agent over the SDK. The agent discovers repo guidelines (`AGENTS.md`,
   `REVIEW.md`, `.pr-governance/`) and explores the full repo with its own
   tools.
4. The agent returns structured findings as JSON; the wrapper validates,
   gates, and posts one review with inline comments + a deterministic verdict.

### For the action developer (you)

This private repo builds the Docker image. The public
[`pgup-ai/jbot-review-action`](https://github.com/pgup-ai/jbot-review-action)
repo is what users reference — it contains just the thin `action.yml` that
pulls the image.

```bash
# CI auto-builds and pushes the image on every push to main.
# To release a new v0 version of the public action:
# 1. Make sure ghcr.io/pgup-ai/jbot-review:latest exists and is public.
# 2. Make sure the public action.yml matches this repo's action.yml.
# 3. Move the v0 tag:
cd ../jbot-review-action    # or wherever it's checked out
git tag -f v0
git push origin v0 --force
```

The Dockerfile uses `node:20-slim` and runs the bundled JS from `dist/`.
The `v0` action reference is a moving major-version tag; pin to an immutable
release tag if you need fully stable action behavior.

### For the user (repo owner who wants reviews)

**Step 1 — Add the workflow file.** Copy
[`examples/jbot-review.yml`](examples/jbot-review.yml) into
`.github/workflows/jbot-review.yml`, or use this minimal version:

```yaml
name: J-Bot Code Review
on:
  pull_request:
    types: [opened, reopened, ready_for_review, synchronize]

concurrency:
  group: jbot-review-${{ github.event.pull_request.number }}
  cancel-in-progress: true

permissions:
  contents: read
  packages: read
  pull-requests: write
  checks: read

jobs:
  review:
    if: github.event.pull_request.draft == false
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0
      - uses: pgup-ai/jbot-review-action@v0 # moving v0 tag; pin a release tag for stability
        with:
          provider: ${{ vars.JBOT_REVIEW_PROVIDER || 'opencode' }}
          model: ${{ vars.JBOT_REVIEW_MODEL || '' }}
          opencode-api-key: ${{ secrets.OPENCODE_API_KEY }}
          deepseek-api-key: ${{ secrets.DEEPSEEK_API_KEY }}
          openai-api-key: ${{ secrets.OPENAI_API_KEY }}
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          openrouter-api-key: ${{ secrets.OPENROUTER_API_KEY }}
          nvidia-api-key: ${{ secrets.NVIDIA_API_KEY }}
          xai-api-key: ${{ secrets.XAI_API_KEY }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
          thread-resolution-token: ${{ secrets.JBOT_REVIEW_THREAD_RESOLUTION_TOKEN }}
```

**Step 2 — Add provider API keys as secrets.** In the repo: Settings → Secrets
and variables → Actions → New repository secret. Add the keys for the providers
you want to use, such as `OPENCODE_API_KEY`, `DEEPSEEK_API_KEY`,
`OPENROUTER_API_KEY`, `NVIDIA_API_KEY`, `XAI_API_KEY`, or `ANTHROPIC_API_KEY`.
Empty provider key inputs are ignored unless that provider is selected.
`opencode-go` uses the same `OPENCODE_API_KEY` as `opencode`.

**Secret exposure:** the example above passes multiple provider secrets so
`JBOT_REVIEW_PROVIDER` can switch providers without another YAML edit. For a
least-privilege setup, pass only the selected provider's key:

```yaml
with:
  provider: opencode
  model: ${{ vars.JBOT_REVIEW_MODEL || '' }}
  opencode-api-key: ${{ secrets.OPENCODE_API_KEY }}
  github-token: ${{ secrets.GITHUB_TOKEN }}
```

**Thread resolution token:** when jbot verifies a prior finding is fixed, it
posts an addressed reply and then attempts to resolve the GitHub review thread.
Some `GITHUB_TOKEN` integrations can post review comments but cannot run
GitHub's `resolveReviewThread` mutation. If you see `Resource not accessible by
integration` in the logs, add a secret such as
`JBOT_REVIEW_THREAD_RESOLUTION_TOKEN` with a PAT or GitHub App token that can
resolve PR review threads, then pass it through `thread-resolution-token`.

**Step 3 — (Optional) Add review guidelines.** Drop an `AGENTS.md`, `REVIEW.md`,
or files in `.pr-governance/` at the repo root. The agent reads these during
review.

**Step 4 — Open a PR.** The review runs automatically. To re-trigger, push a
new commit or close and reopen the PR.

**Migrating from `api-key`:** replace the old unified `api-key` input with the
matching provider-specific input, such as `opencode-api-key` for
`provider: opencode`. The unified input is not read by current `v0` builds.

### Testing locally before publishing

This repo's own `.github/workflows/jbot-review.yml` dogfoods branch-local action
changes before they are published to `pgup-ai/jbot-review-action@v0`. It builds
the branch image, uses the relative `./` action, and passes every provider key
input so `JBOT_REVIEW_PROVIDER` / `JBOT_REVIEW_MODEL` can switch providers
without editing the workflow.

```yaml
- uses: actions/checkout@v6
  with:
    fetch-depth: 0
    ref: ${{ github.event.pull_request.head.sha || format('refs/pull/{0}/head', inputs['pr-number']) }}
- uses: actions/setup-node@v6
  with:
    node-version: '20'
- run: npm ci
- run: npm run build
- run: docker build -t ghcr.io/pgup-ai/jbot-review:latest .
- uses: ./
  with:
    provider: ${{ inputs.provider || vars.JBOT_REVIEW_PROVIDER || 'opencode' }}
    model: ${{ inputs.model || vars.JBOT_REVIEW_MODEL || '' }}
    pr-number: ${{ github.event.pull_request.number || inputs['pr-number'] }}
    dry-run: ${{ inputs['dry-run'] || 'false' }}
    max-findings: ${{ inputs['max-findings'] || '0' }}
    min-severity: ${{ inputs['min-severity'] || 'nit' }}
    include-prior-comments: ${{ inputs['include-prior-comments'] || 'true' }}
    fail-on-error: ${{ inputs['fail-on-error'] || 'true' }}
    opencode-api-key: ${{ secrets.OPENCODE_API_KEY }}
    deepseek-api-key: ${{ secrets.DEEPSEEK_API_KEY }}
    openai-api-key: ${{ secrets.OPENAI_API_KEY }}
    anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
    openrouter-api-key: ${{ secrets.OPENROUTER_API_KEY }}
    nvidia-api-key: ${{ secrets.NVIDIA_API_KEY }}
    xai-api-key: ${{ secrets.XAI_API_KEY }}
    github-token: ${{ secrets.GITHUB_TOKEN }}
    thread-resolution-token: ${{ secrets.JBOT_REVIEW_THREAD_RESOLUTION_TOKEN }}
```

To replay the prompt context locally from fixtures without posting to GitHub:

```bash
npm run replay
npm run replay -- fixtures/replay
```

### Provider configuration (in-repo)

See [models.dev](https://models.dev/) for the full list of models and providers.

| `provider`    | Default model                       | Action key input     | Secret/env var       |
| ------------- | ----------------------------------- | -------------------- | -------------------- |
| `opencode`    | `opencode/deepseek-v4-flash-free`   | `opencode-api-key`   | `OPENCODE_API_KEY`   |
| `opencode-go` | `opencode-go/deepseek-v4-flash`     | `opencode-api-key`   | `OPENCODE_API_KEY`   |
| `deepseek`    | `deepseek/deepseek-v4-flash`        | `deepseek-api-key`   | `DEEPSEEK_API_KEY`   |
| `openai`      | `openai/gpt-5.4-nano`               | `openai-api-key`     | `OPENAI_API_KEY`     |
| `anthropic`   | `anthropic/claude-sonnet-4-6`       | `anthropic-api-key`  | `ANTHROPIC_API_KEY`  |
| `openrouter`  | `openrouter/openai/gpt-4o-mini`     | `openrouter-api-key` | `OPENROUTER_API_KEY` |
| `nvidia`      | `nvidia/nemotron-3-ultra-550b-a55b` | `nvidia-api-key`     | `NVIDIA_API_KEY`     |
| `xai`         | `xai/grok-4.3`                      | `xai-api-key`        | `XAI_API_KEY`        |

Set the `provider` and `model` inputs to override the defaults. For automatic
PR reviews without editing workflow YAML on every provider or model change,
define Actions configuration variables named `JBOT_REVIEW_PROVIDER` and
`JBOT_REVIEW_MODEL` at the repository or organization level and pass them
through the workflow. Leave `JBOT_REVIEW_PROVIDER` unset to use `opencode`, and
leave `JBOT_REVIEW_MODEL` unset to use the selected provider's default model:

```yaml
- uses: pgup-ai/jbot-review-action@v0
  with:
    provider: ${{ vars.JBOT_REVIEW_PROVIDER || 'opencode' }}
    model: ${{ vars.JBOT_REVIEW_MODEL || '' }}
    opencode-api-key: ${{ secrets.OPENCODE_API_KEY }}
    deepseek-api-key: ${{ secrets.DEEPSEEK_API_KEY }}
    openai-api-key: ${{ secrets.OPENAI_API_KEY }}
    anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
    openrouter-api-key: ${{ secrets.OPENROUTER_API_KEY }}
    nvidia-api-key: ${{ secrets.NVIDIA_API_KEY }}
    xai-api-key: ${{ secrets.XAI_API_KEY }}
    github-token: ${{ secrets.GITHUB_TOKEN }}
    thread-resolution-token: ${{ secrets.JBOT_REVIEW_THREAD_RESOLUTION_TOKEN }}
```

The action reads only the key matching the selected `provider`, so future
provider changes can be made through `JBOT_REVIEW_PROVIDER` without editing the
workflow YAML. It accepts provider and model from either action inputs or
environment variables: `provider` or `JBOT_REVIEW_PROVIDER` for the provider,
and `model` or `JBOT_REVIEW_MODEL` for the model. Provider API keys can also be
supplied through their standard env vars, such as `OPENROUTER_API_KEY` or
`NVIDIA_API_KEY`. This convenience pattern exposes every configured provider key
to the action runtime. For the smallest secret surface area, pass only the key
for the provider used by that workflow. If `model` is set, it is interpreted as
a model id for the selected `provider`. A matching `provider/model` prefix is
accepted and normalized, so `deepseek-v4-flash-free` and
`opencode/deepseek-v4-flash-free` are equivalent when `provider` is `opencode`.
Slash-containing provider catalog ids such as `moonshotai/kimi-k2.6` are passed
through as the model id for the selected provider.

For manual reruns, `workflow_dispatch` provider and model inputs can take
precedence over `JBOT_REVIEW_PROVIDER` and `JBOT_REVIEW_MODEL`; automatic
`pull_request` runs use the variable values.

### Input reference

| Input                     | Required | Default               | Description                                                  |
| ------------------------- | -------- | --------------------- | ------------------------------------------------------------ |
| `provider`                | No       | `opencode`            | LLM provider key; can come from `JBOT_REVIEW_PROVIDER`       |
| `model`                   | No       | Provider default      | Provider model id; can come from `JBOT_REVIEW_MODEL`         |
| `opencode-api-key`        | No       | —                     | Required when `provider=opencode` or `provider=opencode-go`  |
| `deepseek-api-key`        | No       | —                     | Required when `provider=deepseek`                            |
| `openai-api-key`          | No       | —                     | Required when `provider=openai`                              |
| `anthropic-api-key`       | No       | —                     | Required when `provider=anthropic`                           |
| `openrouter-api-key`      | No       | —                     | Required when `provider=openrouter`                          |
| `nvidia-api-key`          | No       | —                     | Required when `provider=nvidia`                              |
| `xai-api-key`             | No       | —                     | Required when `provider=xai`                                 |
| `github-token`            | Yes      | `${{ github.token }}` | Token to read PR and post review                             |
| `thread-resolution-token` | No       | —                     | Optional token used only to resolve addressed review threads |
| `pr-number`               | No       | —                     | PR number for manual `workflow_dispatch` reviews             |
| `dry-run`                 | No       | `false`               | Log review output without posting to GitHub                  |
| `max-findings`            | No       | `0`                   | Cap findings; `0` means no limit                             |
| `min-severity`            | No       | `nit`                 | Include `P0`, `P1`, `P2`, `P3`, or `nit`                     |
| `include-prior-comments`  | No       | `true`                | Include existing PR review comments in context               |
| `fail-on-error`           | No       | `true`                | Fail the workflow if the review cannot complete              |

### Review output

`jbot-review` always posts a GitHub `COMMENT` review, not an automatic approval
or request-changes review. The review body includes advisory merge guidance:

- `Needs changes before approval` when any `P0`, `P1`, or `P2` finding is present.
- `Mergeable with non-blocking comments` when only `P3` or `nit` findings are present.
- `Good to go from jbot-review` when no new findings are found.

## Hosted GitHub App

The review runs on infrastructure you control. Users install the App once and
get reviews on every repo automatically — no YAML, no secrets, no setup.

### How it works

1. You register a GitHub App and deploy this repo's Docker image to your
   infrastructure (Cloud Run, VPS, etc.).
2. When a user installs the App, GitHub sends `pull_request.opened` /
   `pull_request.synchronize` webhooks to your server.
3. The server verifies the webhook signature, exchanges the App's JWT for an
   installation token, clones the PR branch, and runs the same review engine
   as the in-repo workflow.
4. Findings are posted back via the installation-authenticated Octokit.

### For the App operator (you)

**1. Create the GitHub App.**

Go to [Settings → Developer settings → GitHub Apps → New GitHub App](https://github.com/settings/apps/new):

| Setting         | Value                                                       |
| --------------- | ----------------------------------------------------------- |
| GitHub App name | `jbot-review` (or anything)                                 |
| Homepage URL    | `https://github.com/pgup-ai/jbot-review`                    |
| Webhook URL     | `https://<your-deployed-url>/webhooks`                      |
| Webhook secret  | Generate a long random string (e.g. `openssl rand -hex 32`) |

Under **Repository permissions**:

- Pull requests: **Read & write**
- Contents: **Read-only**

Under **Subscribe to events**: check **Pull request**.

Under **Where can this GitHub App be installed**: choose **Any account** (public
install) or **Only this account** (personal / org-only).

Click **Create GitHub App**. Note the **App ID** (shown at the top). Scroll to
**Private keys** and click **Generate a private key** — save the `.pem` file.

**2. Install on your account.** In the App settings sidebar, click **Install App**,
pick your account, and choose **All repositories** or select specific repos.

**3. Configure the `.env` file.**

```bash
cp .env.example .env
```

| Variable                 | Source                                            |
| ------------------------ | ------------------------------------------------- |
| `GITHUB_APP_ID`          | App ID from step 1 (e.g. `123456`)                |
| `GITHUB_APP_PRIVATE_KEY` | Full contents of the `.pem` file from step 1      |
| `GITHUB_WEBHOOK_SECRET`  | The random string you set in step 1               |
| `PROVIDER`               | Provider key (defaults to `opencode`)             |
| Provider API keys        | Operator-managed API keys for supported providers |
| `MODEL`                  | Optional override (defaults to provider default)  |
| `PORT`                   | Optional (defaults to `3000`)                     |

The hosted App currently uses operator-managed provider keys from environment
variables. These are not per-user BYOK keys. For a multi-provider deployment,
set every provider key you want the operator account to support, then choose the
active provider with `PROVIDER` and optional `MODEL`. Future dashboard BYOK
should store encrypted per-user/per-installation keys in the dashboard database
and resolve them per review job, not through Fly/Cloud Run app secrets.

**4. Deploy.** Pick any provider from the [deployment guides](#deploying-the-hosted-app)
below. All follow the same pattern: build the Docker image, inject env vars,
expose port 3000, and point the App's webhook URL at the resulting public URL.

**5. Test locally before deploying.**

```bash
# Terminal 1: start the server
npm run dev

# Terminal 2: expose localhost to the internet
ngrok http 3000

# Set the App's webhook URL to https://xxxxx.ngrok.io/webhooks
# Open a PR in an installed repo — review runs on your machine.
```

### For the end user (repo owner who installs the App)

```
1. Go to https://github.com/apps/jbot-review → Install
2. Choose the account (personal or org)
3. Select repos (all or specific)
4. Done. Every PR on those repos gets reviewed automatically.
```

That's it. No YAML, no secrets, no workflow file. The review runs on the App
operator's infrastructure. The user can still add `AGENTS.md`, `REVIEW.md`, or
`.pr-governance/` files to their repo for project-specific review rules — those
are discovered during checkout.

### Env var reference (hosted App)

| Variable                 | Required    | Default          | Description                                |
| ------------------------ | ----------- | ---------------- | ------------------------------------------ |
| `GITHUB_APP_ID`          | Yes         | —                | Numeric App ID from GitHub                 |
| `GITHUB_APP_PRIVATE_KEY` | Yes         | —                | Contents of the `.pem` file                |
| `GITHUB_WEBHOOK_SECRET`  | Yes         | —                | Random string for signing                  |
| `PROVIDER`               | No          | `opencode`       | Provider key (see table below)             |
| `OPENCODE_API_KEY`       | Conditional | —                | Operator key used when PROVIDER=opencode   |
| `DEEPSEEK_API_KEY`       | Conditional | —                | Operator key used when PROVIDER=deepseek   |
| `OPENAI_API_KEY`         | Conditional | —                | Operator key used when PROVIDER=openai     |
| `ANTHROPIC_API_KEY`      | Conditional | —                | Operator key used when PROVIDER=anthropic  |
| `OPENROUTER_API_KEY`     | Conditional | —                | Operator key used when PROVIDER=openrouter |
| `NVIDIA_API_KEY`         | Conditional | —                | Operator key used when PROVIDER=nvidia     |
| `XAI_API_KEY`            | Conditional | —                | Operator key used when PROVIDER=xai        |
| `MODEL`                  | No          | Provider default | Provider model id, optionally prefixed     |
| `PORT`                   | No          | `3000`           | HTTP listen port                           |

### Provider configuration (hosted App)

Set `PROVIDER` and the matching operator API key in `.env`. You can set all
provider keys up front, but the current hosted server reads only the key matching
the selected `PROVIDER` at boot. The `MODEL` env var overrides the provider
default and may be either the raw provider model id or a matching
`provider/model` string:

```bash
PROVIDER=deepseek
OPENCODE_API_KEY=oc-...
DEEPSEEK_API_KEY=sk-...
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
OPENROUTER_API_KEY=sk-or-...
NVIDIA_API_KEY=nvapi-...
XAI_API_KEY=xai-...
MODEL=deepseek/deepseek-v4-flash
```

The server validates at boot that the selected provider and its key are
configured.

## Deploying the hosted App

The Dockerfile is vendor-agnostic — `FROM node:20-slim`, installs git + opencode,
exposes port 3000. Pick any provider below. All follow the same three steps:

1. Build + push the image (or build on the host)
2. Deploy with GitHub App secrets and the provider API keys the operator wants
   to support
3. Point your GitHub App's webhook URL at `https://<your-url>/webhooks`

### GCP Cloud Run

Scale-to-zero. Free tier: 2M requests/month, 360K vCPU-seconds. You pay ~$0 at
low volume, ~$0.01 per review at moderate volume. Cold starts are ~30s.

```bash
# 1. Prerequisites
gcloud auth login
gcloud config set project YOUR_PROJECT_ID

# 2. Build and push to Artifact Registry (or use Docker Hub below)
gcloud artifacts repositories create jbot-review --location=us-central1
gcloud builds submit --tag us-central1-docker.pkg.dev/YOUR_PROJECT_ID/jbot-review/jbot-review

# 3. Deploy
gcloud run deploy jbot-review \
  --image us-central1-docker.pkg.dev/YOUR_PROJECT_ID/jbot-review/jbot-review \
  --port 3000 \
  --cpu 2 \
  --memory 4Gi \
  --timeout 600 \
  --concurrency 1 \
  --set-env-vars GITHUB_APP_ID=123456 \
  --set-env-vars "GITHUB_APP_PRIVATE_KEY=$(cat your-app.pem)" \
  --set-env-vars GITHUB_WEBHOOK_SECRET=your-secret \
  --set-env-vars OPENCODE_API_KEY=oc-... \
  --set-env-vars DEEPSEEK_API_KEY=sk-... \
  --set-env-vars OPENAI_API_KEY=sk-... \
  --set-env-vars ANTHROPIC_API_KEY=sk-ant-... \
  --set-env-vars OPENROUTER_API_KEY=sk-or-... \
  --set-env-vars NVIDIA_API_KEY=nvapi-... \
  --set-env-vars XAI_API_KEY=xai-... \
  --allow-unauthenticated

# 4. The output gives you a https:// URL — use it as the webhook URL.
```

Or using Docker Hub instead of Artifact Registry:

```bash
docker build --platform linux/amd64 -t your-dockerhub/jbot-review .
docker push your-dockerhub/jbot-review

gcloud run deploy jbot-review \
  --image docker.io/your-dockerhub/jbot-review \
  --port 3000 \
  --cpu 2 --memory 4Gi --timeout 600 --concurrency 1 \
  --set-env-vars "GITHUB_APP_ID=...,GITHUB_APP_PRIVATE_KEY=...,..." \
  --allow-unauthenticated
```

### Fly.io

Scale-to-zero. Hobby plan ~$0/mo idle. Deploys from a Dockerfile in the repo —
no registry push needed.

```bash
# 1. Prerequisites
brew install flyctl    # or: curl -L https://fly.io/install.sh | sh
fly auth signup

# 2. Launch (Fly detects Dockerfile automatically)
fly launch --name jbot-review --region iad --now --no-deploy

# 3. Set secrets
fly secrets set \
  GITHUB_APP_ID=123456 \
  GITHUB_APP_PRIVATE_KEY="$(cat your-app.pem)" \
  GITHUB_WEBHOOK_SECRET=your-secret \
  OPENCODE_API_KEY=oc-... \
  DEEPSEEK_API_KEY=sk-... \
  OPENAI_API_KEY=sk-... \
  ANTHROPIC_API_KEY=sk-ant-... \
  OPENROUTER_API_KEY=sk-or-... \
  NVIDIA_API_KEY=nvapi-... \
  XAI_API_KEY=xai-...

# 4. Scale and deploy
fly scale vm shared-cpu-1x
fly scale memory 1024
fly deploy

# 5. Webhook URL: https://jbot-review.fly.dev/webhooks
```

To enable auto-stop (scale to zero when idle):

```toml
# fly.toml
[http_service]
  internal_port = 3000
  auto_stop_machines = true
  auto_start_machines = true
  min_machines_running = 0
```

### DigitalOcean App Platform

Managed platform. $5/mo for the smallest instance. No scale-to-zero, but
predictable pricing. Builds from source or Docker Hub.

```bash
# 1. Push to Docker Hub (or let App Platform build from Dockerfile)
docker build --platform linux/amd64 -t your-dockerhub/jbot-review .
docker push your-dockerhub/jbot-review

# 2. Create app via doctl or the web UI:
doctl apps create --spec app.yaml
```

```yaml
# app.yaml
name: jbot-review
region: nyc
services:
  - name: server
    dockerfile_path: Dockerfile
    http_port: 3000
    instance_size_slug: basic-xxs # 1 vCPU, 512 MB
    envs:
      - key: GITHUB_APP_ID
        value: '123456'
      - key: GITHUB_APP_PRIVATE_KEY
        value: "-----BEGIN RSA PRIVATE KEY-----\n..."
      - key: GITHUB_WEBHOOK_SECRET
        value: your-secret
      - key: OPENCODE_API_KEY
        value: oc-...
      - key: DEEPSEEK_API_KEY
        value: sk-...
      - key: OPENAI_API_KEY
        value: sk-...
      - key: ANTHROPIC_API_KEY
        value: sk-ant-...
      - key: OPENROUTER_API_KEY
        value: sk-or-...
      - key: NVIDIA_API_KEY
        value: nvapi-...
      - key: XAI_API_KEY
        value: xai-...
```

Then point the webhook at `https://jbot-review-xxxxx.ondigitalocean.app/webhooks`.

Or using the Docker Hub image directly (no source build):

```yaml
# app.yaml
services:
  - name: server
    image:
      registry: dockerhub
      repository: your-dockerhub/jbot-review
      tag: latest
    http_port: 3000
    instance_size_slug: basic-xxs
    envs: [...]
```

### Render

Managed platform. Free tier: 750 hours/month (one service), auto-sleeps after
15 min of inactivity. Cold starts ~30s.

```bash
# 1. Push to Docker Hub
docker build --platform linux/amd64 -t your-dockerhub/jbot-review .
docker push your-dockerhub/jbot-review

# 2. Create a Web Service in the Render dashboard:
#    - Image: docker.io/your-dockerhub/jbot-review
#    - Port: 3000
#    - Add env vars from .env.example

# 3. Or via render.yaml (BluePrint):
```

```yaml
# render.yaml
services:
  - type: web
    name: jbot-review
    runtime: image
    image:
      url: docker.io/your-dockerhub/jbot-review:latest
    plan: free # or starter ($7/mo)
    port: 3000
    envVars:
      - key: GITHUB_APP_ID
        value: '123456'
      - key: GITHUB_APP_PRIVATE_KEY
        value: |
          -----BEGIN RSA PRIVATE KEY-----
          ...
      - key: GITHUB_WEBHOOK_SECRET
        value: your-secret
      - key: OPENCODE_API_KEY
        value: oc-...
      - key: DEEPSEEK_API_KEY
        value: sk-...
      - key: OPENAI_API_KEY
        value: sk-...
      - key: ANTHROPIC_API_KEY
        value: sk-ant-...
      - key: OPENROUTER_API_KEY
        value: sk-or-...
      - key: NVIDIA_API_KEY
        value: nvapi-...
      - key: XAI_API_KEY
        value: xai-...
```

Webhook URL: `https://jbot-review.onrender.com/webhooks`.

### Vultr VPS

Bare VM. $6/mo for 1 vCPU / 1 GB (Cloud Compute) or $12/mo for 2 vCPU / 4 GB.
No cold starts, always running. Good for predictable low-volume usage.

```bash
# 1. SSH into your Vultr VM
ssh root@YOUR_VM_IP

# 2. Install Docker
curl -fsSL https://get.docker.com | sh

# 3. Build and run
git clone https://github.com/YOUR_USER/jbot-review.git
cd jbot-review
docker build -t jbot-review .
docker run -d \
  --name jbot-review \
  -p 3000:3000 \
  --restart always \
  --env-file .env \
  jbot-review

# 4. Open port 3000 in Vultr firewall
# 5. Webhook URL: http://YOUR_VM_IP:3000/webhooks
```

### Oracle Cloud Always Free

4 ARM vCPU, 24 GB RAM — permanently free. No billing unless you exceed the
10 TB outbound/month limit. Same as any VPS but more powerful.

```bash
# 1. Create an Ampere A1 instance (4 OCPU, 24 GB) via OCI Console
# 2. SSH in and follow the Vultr steps above:
ssh opc@YOUR_VM_IP
curl -fsSL https://get.docker.com | sh
git clone https://github.com/YOUR_USER/jbot-review.git
cd jbot-review
docker build -t jbot-review .
docker run -d --name jbot-review -p 3000:3000 --restart always --env-file .env jbot-review

# 3. In OCI Console: Networking → Virtual Cloud Networks → subnet → Security List
#    Add ingress rule: TCP port 3000 from 0.0.0.0/0
# 4. Webhook URL: http://YOUR_VM_IP:3000/webhooks
```

### Hetzner VPS

$4/mo CX22 (2 vCPU, 4 GB). Same Docker pattern as Vultr/Oracle. No scale-to-zero
but excellent price/performance.

```bash
# Same as Vultr/Oracle — SSH in, install Docker, clone, build, run:
ssh root@YOUR_VM_IP
curl -fsSL https://get.docker.com | sh
git clone https://github.com/YOUR_USER/jbot-review.git
cd jbot-review
docker build -t jbot-review .
docker run -d --name jbot-review -p 3000:3000 --restart always --env-file .env jbot-review
# Open port 3000 in Hetzner firewall. Webhook: http://YOUR_VM_IP:3000/webhooks
```

### Railway

Pay-per-use. Railway's Free plan currently starts with a 30-day trial and a
one-time credit grant, then provides a small monthly free credit for small apps.
The default Free plan resource shape is 1 vCPU / 0.5 GB RAM per service, which
is enough for a low-volume hosted App trial but may be tight for concurrent or
large-repo reviews. Builds from Docker Hub or directly from a GitHub repo.

```bash
# 1. Prerequisites
brew install railway    # or: npm i -g @railway/cli
railway login

# 2. Push to Docker Hub, then deploy
docker build --platform linux/amd64 -t your-dockerhub/jbot-review .
docker push your-dockerhub/jbot-review

railway init
railway service add --image docker.io/your-dockerhub/jbot-review
railway variables set \
  GITHUB_APP_ID=123456 \
  "GITHUB_APP_PRIVATE_KEY=$(cat your-app.pem)" \
  GITHUB_WEBHOOK_SECRET=your-secret \
  OPENCODE_API_KEY=oc-... \
  DEEPSEEK_API_KEY=sk-... \
  OPENAI_API_KEY=sk-... \
  ANTHROPIC_API_KEY=sk-ant-... \
  OPENROUTER_API_KEY=sk-or-... \
  NVIDIA_API_KEY=nvapi-... \
  XAI_API_KEY=xai-... \
  PORT=3000

railway up
# Webhook URL: https://jbot-review.up.railway.app/webhooks
```

### Koyeb

Free tier with scale-to-zero. Deploys from Docker Hub or GitHub container
registry.

```bash
# 1. Push to Docker Hub
docker build --platform linux/amd64 -t your-dockerhub/jbot-review .
docker push your-dockerhub/jbot-review

# 2. Create a Service in the Koyeb dashboard:
#    - Image: docker.io/your-dockerhub/jbot-review
#    - Port: 3000 → exposed as HTTP
#    - Instance type: nano (free)
#    - Scaling: min 0, max 1
#    - Add env vars from .env.example

# Or via CLI:
koyeb service create jbot-review \
  --docker docker.io/your-dockerhub/jbot-review:latest \
  --port 3000 \
  --instance-type nano \
  --scaling-min 0 --scaling-max 1 \
  --env GITHUB_APP_ID=123456 \
  --env "GITHUB_APP_PRIVATE_KEY=$(cat your-app.pem)" \
  --env GITHUB_WEBHOOK_SECRET=your-secret \
  --env OPENCODE_API_KEY=oc-... \
  --env DEEPSEEK_API_KEY=sk-... \
  --env OPENAI_API_KEY=sk-... \
  --env ANTHROPIC_API_KEY=sk-ant-... \
  --env OPENROUTER_API_KEY=sk-or-... \
  --env NVIDIA_API_KEY=nvapi-... \
  --env XAI_API_KEY=xai-...

# Webhook URL: https://jbot-review-<org>.koyeb.app/webhooks
```

### AWS App Runner

Managed container service with automatic scaling, but not scale-to-zero for a
running web service. App Runner keeps provisioned memory for the minimum
container instance and charges for it while the service is running. Deploys from
ECR or Docker Hub.

```bash
# 1. Push to ECR (or Docker Hub)
aws ecr create-repository --repository-name jbot-review
aws ecr get-login-password | docker login --username AWS --password-stdin $AWS_ACCOUNT.dkr.ecr.$REGION.amazonaws.com
docker build --platform linux/amd64 -t $AWS_ACCOUNT.dkr.ecr.$REGION.amazonaws.com/jbot-review .
docker push $AWS_ACCOUNT.dkr.ecr.$REGION.amazonaws.com/jbot-review

# 2. Create App Runner service (Console or CloudFormation):
#    - Source: ECR → select the image
#    - Port: 3000
#    - Add env vars from .env.example
#    - Auto-scaling: min 1, max 1

# Webhook URL: https://xxxxx.$REGION.awsapprunner.com/webhooks
```

## Provider cost comparison

| Provider                  | Idle cost                       | Per review (est.)         | Auto scale-to-zero  |
| ------------------------- | ------------------------------- | ------------------------- | ------------------- |
| Cloud Run (free tier)     | $0                              | ~$0.01                    | Yes                 |
| Cloudflare Containers     | $5/mo                           | Usage-based               | Yes                 |
| Fly.io (hobby)            | ~$0                             | ~$0.01                    | Yes                 |
| Render (free tier)        | $0                              | ~$0                       | Sleeps after 15 min |
| Railway (Free)            | $0 trial + small monthly credit | Usage-based beyond credit | Yes                 |
| Koyeb (free tier)         | $0                              | ~$0                       | Yes                 |
| AWS App Runner            | ~$5/mo                          | Usage-based               | No                  |
| Azure Container Apps      | $0                              | Usage-based               | Yes                 |
| Northflank Sandbox        | $0                              | $0                        | No                  |
| CloudCone VPS             | ~$1/mo                          | $0                        | No                  |
| Hetzner CX22              | $4/mo                           | $0                        | No                  |
| Vultr (1 vCPU)            | $6/mo                           | $0                        | No                  |
| DigitalOcean App Platform | $5/mo                           | $0                        | No                  |
| Oracle Free Tier          | $0                              | $0                        | No                  |

Prices are approximate and tier-dependent; check each provider's current limits
before choosing a host.

Cloudflare is a good fit if the app is split into a Worker/Queue control plane
with containerized review workers, unlike the simple Docker web service model of
Cloud Run, Fly.io, or Render. CloudCone is the cheapest VPS-style option here,
but it means self-managing the VM, deploys, process supervisor, TLS/reverse
proxy, and security updates.

## Project guidelines

Both modes automatically discover repo-level guidance from the checked-out workspace:

- `AGENTS.md` — conventions and rules
- `REVIEW.md` — review-specific instructions
- `.pr-governance/` — any files in this directory

These are injected into the prompt after the base instructions but before the
diff context, so the agent applies your rules when reviewing each change.

## Project structure

```
src/
  shared/
    runner.ts       # shared orchestration (both paths call this)
    opencode.ts     # opencode serve + SDK review
    github.ts       # list files, post review, verdict
    prompt.ts       # system prompt
    patch.ts        # diff line parser
    filter.ts       # noise filter
    types.ts        # shared types
  workflow/
    index.ts        # in-repo GitHub Action entry point
  app/
    server.ts       # HTTP server for hosted App
    app.ts          # webhook handler + triggers
    auth.ts         # GitHub App JWT → installation token
    clone.ts        # git clone for the hosted runner
    queue.ts        # in-memory job queue (MVP)
action.yml          # Docker action metadata for in-repo workflow
Dockerfile          # container image for hosted App
.env.example        # env vars for the App
.github/workflows/jbot-review.yml
```

## Why the `plan` agent

`plan` is OpenCode's built-in read-only agent: it can read, grep, and glob but
cannot edit files. Using it keeps the review safe and avoids non-interactive
permission prompts that hang a CI job. Agent selection is intentionally fixed for
CI reviews; there is no supported `AGENT` env override.

## Notes

- **Fork PRs** won't have the secret (GitHub withholds secrets from fork-triggered
  runs in Actions). The hosted App avoids this since secrets live on your infra.
- **OpenCode SDK**: this repo uses `@opencode-ai/sdk` 1.x and
  `client.session.prompt()`. If you bump the SDK, re-check the response shape in
  `opencode.ts`.
