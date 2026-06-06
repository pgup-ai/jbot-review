# jbot-review

An agentic PR reviewer built on OpenCode. Two deployment modes, one review engine:

| Mode | Trigger | Runs on | Repo config needed |
|---|---|---|---|
| **In-repo workflow** | PR opened/synced | User's GitHub Actions runner | One YAML file + one secret |
| **Hosted GitHub App** | Webhook from GitHub | Your infrastructure (Cloud Run, VPS, etc.) | Install once, zero repo config |

The review core (`runner.ts` + `opencode.ts` + `github.ts`) is shared between both.

## In-repo workflow

The review runs as a GitHub Actions workflow inside the user's repository. The
user provides an API key; GitHub provides the free compute (unlimited on public
repos, 2000 min/month free on private repos).

### How it works

1. The user drops a workflow file into `.github/workflows/` and adds an API key
   as a repo secret.
2. On `pull_request` events, GitHub Actions checks out their repo and runs the
   `jbot-review` composite action.
3. The action installs `opencode`, starts `opencode serve`, and drives a
   read-only `plan` agent over the SDK. The agent discovers repo guidelines
   (`AGENTS.md`, `REVIEW.md`, `.pr-governance/`) and explores the full repo
   with its own tools.
4. The agent returns structured findings as JSON; the wrapper validates,
   gates, and posts one review with inline comments + a deterministic verdict.

### For the action developer (you)

You own the `jbot-review` repo. To make it usable as an action:

```bash
# 1. Commit package-lock.json (the action uses npm ci)
git add package-lock.json
git commit -m "Add package-lock.json"

# 2. Tag a release
git tag v1 -m "Initial release"
git push origin v1
```

Users reference the action as `jingbof/jbot-review@v1`. If you vendor it
directly in their repo (for testing), they use `./` relative path instead.

The action is a composite action defined in `action.yml` at the repo root.
It runs `src/workflow/index.ts` which reads inputs, resolves the provider,
and calls the shared `runPrReview()` in `src/shared/runner.ts`.

### For the user (repo owner who wants reviews)

**Step 1 — Add the workflow file.** Copy this into `.github/workflows/jbot-review.yml`:

```yaml
name: jbot-review
on:
  pull_request:
    types: [opened, reopened, ready_for_review, synchronize]

concurrency:
  group: jbot-review-${{ github.event.pull_request.number }}
  cancel-in-progress: true

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    if: github.event.pull_request.draft == false
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: jingbof/jbot-review@v1
        with:
          api-key: ${{ secrets.OPENCODE_API_KEY }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

**Step 2 — Add the API key as a secret.** In the repo: Settings → Secrets and
variables → Actions → New repository secret. Name it to match the provider:

| Provider | Secret name |
|---|---|
| opencode | `OPENCODE_API_KEY` |
| deepseek | `DEEPSEEK_API_KEY` |
| openai | `OPENAI_API_KEY` |
| anthropic | `ANTHROPIC_API_KEY` |
| openrouter | `OPENROUTER_API_KEY` |

**Step 3 — (Optional) Add review guidelines.** Drop an `AGENTS.md`, `REVIEW.md`,
or files in `.pr-governance/` at the repo root. The agent reads these during
review.

**Step 4 — Open a PR.** The review runs automatically. To re-trigger, push a
new commit or close and reopen the PR.

### Testing locally before publishing

To test the action in the same repo before tagging a release:

```yaml
# Use the relative path instead of jingbof/jbot-review@v1:
- uses: ./
  with:
    api-key: ${{ secrets.OPENCODE_API_KEY }}
    github-token: ${{ secrets.GITHUB_TOKEN }}
```

### Provider configuration (in-repo)

See [models.dev](https://models.dev/) for the full list of models and providers.

| `provider` | Default model | Key env var |
|---|---|---|
| `opencode` | `opencode/deepseek-v4-flash-free` | `OPENCODE_API_KEY` |
| `deepseek` | `deepseek/deepseek-v4-flash` | `DEEPSEEK_API_KEY` |
| `openai` | `openai/gpt-4o-mini` | `OPENAI_API_KEY` |
| `anthropic` | `anthropic/claude-sonnet-4-20250514` | `ANTHROPIC_API_KEY` |
| `openrouter` | `openrouter/openai/gpt-4o-mini` | `OPENROUTER_API_KEY` |

Set the `model` input to override the default. The `api-key` input is always
required; OpenCode handles routing to the right provider at runtime:

```yaml
- uses: jingbof/jbot-review@v1
  with:
    provider: deepseek
    api-key: ${{ secrets.DEEPSEEK_API_KEY }}
    model: deepseek/deepseek-v4-flash      # optional override
    github-token: ${{ secrets.GITHUB_TOKEN }}
```

### Input reference

| Input | Required | Default | Description |
|---|---|---|---|
| `provider` | No | `opencode` | LLM provider key (see table above) |
| `model` | No | Provider default | Override as `provider/model` |
| `api-key` | Yes | — | API key for the selected provider |
| `github-token` | Yes | `${{ github.token }}` | Token to read PR and post review |

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

| Setting | Value |
|---|---|
| GitHub App name | `jbot-review` (or anything) |
| Homepage URL | `https://github.com/jingbof/jbot-review` |
| Webhook URL | `https://<your-deployed-url>/webhooks` |
| Webhook secret | Generate a long random string (e.g. `openssl rand -hex 32`) |

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

| Variable | Source |
|---|---|
| `GITHUB_APP_ID` | App ID from step 1 (e.g. `123456`) |
| `GITHUB_APP_PRIVATE_KEY` | Full contents of the `.pem` file from step 1 |
| `GITHUB_WEBHOOK_SECRET` | The random string you set in step 1 |
| `PROVIDER` | Provider key (defaults to `opencode`) |
| `OPENCODE_API_KEY` | Your OpenCode API key (or the key for your chosen provider) |
| `MODEL` | Optional override (defaults to provider default) |
| `PORT` | Optional (defaults to `3000`) |

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

| Variable | Required | Default | Description |
|---|---|---|---|
| `GITHUB_APP_ID` | Yes | — | Numeric App ID from GitHub |
| `GITHUB_APP_PRIVATE_KEY` | Yes | — | Contents of the `.pem` file |
| `GITHUB_WEBHOOK_SECRET` | Yes | — | Random string for signing |
| `PROVIDER` | No | `opencode` | Provider key (see table below) |
| `OPENCODE_API_KEY` | Conditional | — | Required when PROVIDER=opencode |
| `DEEPSEEK_API_KEY` | Conditional | — | Required when PROVIDER=deepseek |
| `OPENAI_API_KEY` | Conditional | — | Required when PROVIDER=openai |
| `ANTHROPIC_API_KEY` | Conditional | — | Required when PROVIDER=anthropic |
| `OPENROUTER_API_KEY` | Conditional | — | Required when PROVIDER=openrouter |
| `MODEL` | No | Provider default | Override as `provider/model` |
| `PORT` | No | `3000` | HTTP listen port |

### Provider configuration (hosted App)

Set `PROVIDER` and the matching API key in `.env`. The `MODEL` env var overrides
the provider default:

```bash
PROVIDER=deepseek
DEEPSEEK_API_KEY=sk-...
MODEL=deepseek/deepseek-v4-flash
```

The server validates at boot that both the provider and its key are configured.

## Deploying the hosted App

The Dockerfile is vendor-agnostic — `FROM node:20-slim`, installs git + opencode,
exposes port 3000. Pick any provider below. All follow the same three steps:

1. Build + push the image (or build on the host)
2. Deploy with env vars from `.env.example`
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
  OPENCODE_API_KEY=oc-...

# 4. Scale and deploy
fly scale cpu performance --cpu-kind performance --cpus 2
fly scale memory 4096
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
    instance_size_slug: basic-xxs    # 1 vCPU, 512 MB
    envs:
      - key: GITHUB_APP_ID
        value: "123456"
      - key: GITHUB_APP_PRIVATE_KEY
        value: "-----BEGIN RSA PRIVATE KEY-----\n..."
      - key: GITHUB_WEBHOOK_SECRET
        value: your-secret
      - key: OPENCODE_API_KEY
        value: oc-...
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
    plan: free            # or starter ($7/mo)
    port: 3000
    envVars:
      - key: GITHUB_APP_ID
        value: "123456"
      - key: GITHUB_APP_PRIVATE_KEY
        value: |
          -----BEGIN RSA PRIVATE KEY-----
          ...
      - key: GITHUB_WEBHOOK_SECRET
        value: your-secret
      - key: OPENCODE_API_KEY
        value: oc-...
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

Pay-per-use, scales to zero on the $5 starter plan. Builds from Docker Hub or
directly from a GitHub repo.

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
  PORT=3000

railway up
# Webhook URL: https://jbot-review.up.railway.app/webhooks
```

### Koyeb

Free tier with scale-to-zero. Deploys from Docker Hub or GitHub container
registry. No cold-start penalty on the nano instance.

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
  --env OPENCODE_API_KEY=oc-...

# Webhook URL: https://jbot-review-<org>.koyeb.app/webhooks
```

### AWS App Runner

Pay-per-request, scales to zero. Minimum 1 instance-warm config available for
faster starts. Deploys from ECR or Docker Hub.

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
#    - Auto-scaling: min 0, max 1

# Webhook URL: https://xxxxx.$REGION.awsapprunner.com/webhooks
```

## Provider cost comparison

| Provider | Idle cost | Per review (est.) | Auto scale-to-zero |
|---|---|---|---|
| Cloud Run (free tier) | $0 | ~$0.01 | Yes |
| Fly.io (hobby) | ~$0 | ~$0.01 | Yes |
| Render (free tier) | $0 | ~$0 | Sleeps after 15 min |
| Railway (starter) | ~$0 | ~$0.01 | Yes |
| Koyeb (free tier) | $0 | ~$0 | Yes |
| AWS App Runner | ~$0 | ~$0.02 | Yes |
| Hetzner CX22 | $4/mo | $0 | No |
| Vultr (1 vCPU) | $6/mo | $0 | No |
| DigitalOcean App Platform | $5/mo | $0 | No |
| Oracle Free Tier | $0 | $0 | No |

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
    index.ts        # in-repo workflow entry point
  app/
    server.ts       # HTTP server for hosted App
    app.ts          # webhook handler + triggers
    auth.ts         # GitHub App JWT → installation token
    clone.ts        # git clone for the hosted runner
    queue.ts        # in-memory job queue (MVP)
action.yml          # composite action for in-repo workflow
Dockerfile          # container image for hosted App
.env.example        # env vars for the App
.github/workflows/jbot-review.yml
```

## Why the `plan` agent

`plan` is OpenCode's built-in read-only agent: it can read, grep, and glob but
cannot edit files. Using it keeps the review safe and avoids non-interactive
permission prompts that hang a CI job. Override with the `AGENT` env var.

## Notes

- **Fork PRs** won't have the secret (GitHub withholds secrets from fork-triggered
  runs in Actions). The hosted App avoids this since secrets live on your infra.
- **SDK pinned at `@opencode-ai/sdk` 0.4.x**: `session.chat` returns the assistant
  message; parts are fetched via `session.message`. If you bump the SDK, re-check
  that shape in `opencode.ts`.
