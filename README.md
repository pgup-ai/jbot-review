<p align="center">
  <img src="docs/assets/social-preview.png" alt="J-Bot Review" />
</p>

# J-Bot Code Review

An agentic PR reviewer built on OpenCode. It runs as a GitHub Action: add one
workflow file and one secret, and every opened or updated pull request is reviewed
on your own GitHub Actions runner. The review core is `runner.ts` + `opencode.ts` +
`github.ts`.

## In-repo workflow

The review runs as a Docker container action inside the user's GitHub Actions
runner. Users reference the thin [`pgup-ai/jbot-review-action`](https://github.com/pgup-ai/jbot-review-action) repo (just an `action.yml`); this repo builds the image it pulls.

### How it works

1. The user drops a workflow file into `.github/workflows/` and adds an API key
   as a repo secret.
2. On `pull_request` events, GitHub Actions checks out their repo and runs
   the `jbot-review` Docker container action.
3. The action pulls the pre-built image from `ghcr.io/pgup-ai/jbot-review`,
   starts `opencode serve` inside the container, and drives a read-only `plan`
   agent over the SDK. The agent discovers repo guidelines (`AGENTS.md`,
   `REVIEW.md`, `.pr-governance/`, and compatible review-bot rule files) and
   explores the full repo with its own tools.
4. The agent receives the PR's exact base...head diff scope and returns
   structured findings as JSON; the wrapper validates line anchors against the
   diff, demotes low-confidence blocking findings, gates by severity, and posts
   one review with inline comments + a deterministic verdict. Two parallel
   read-only sessions run alongside the main review: one audits the diff
   against discovered repository guidelines rule-by-rule, and one verifies
   which prior jbot-review threads the branch has addressed.

### For the action developer (you)

This repo builds the Docker image. The separate
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

The Dockerfile uses `node:24-slim` and runs the bundled JS from `dist/`.
The `v0` action reference is a moving major-version tag; pin to an immutable
release tag if you need fully stable action behavior.

> **The Action is one of several build entrypoints.** `scripts/build.ts` also
> bundles `src/worker/` and `src/app/` (for the separately-deployed control plane),
> but the Action runs only `dist/workflow/index.js`, and those paths share no
> imports — so worker/server changes can't affect Action users.
>
> The standalone worker's mirrored control-plane payload carries models and
> keys, but no custom base URL, so it does not support `openai-compatible` yet.
> Native providers, including `kimi-for-coding`, work there unchanged.

### For the user (repo owner who wants reviews)

**Step 1 — Add the workflow file.** Copy the full example from the
[`pgup-ai/jbot-review-action`](https://github.com/pgup-ai/jbot-review-action/blob/main/examples/jbot-review.yml)
repo into `.github/workflows/jbot-review.yml`, or use this minimal version:

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
  issues: write # optional: lets jbot post its review-done 🚀 reaction
  checks: read

jobs:
  review:
    if: github.event.pull_request.draft == false
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      - uses: pgup-ai/jbot-review-action@v0 # moving v0 tag; pin a release tag for stability
        with:
          provider: ${{ vars.JBOT_REVIEW_PROVIDER || 'opencode' }}
          model: ${{ vars.JBOT_REVIEW_MODEL || '' }}
          aux-provider: ${{ vars.JBOT_AUX_PROVIDER || '' }}
          aux-model: ${{ vars.JBOT_REVIEW_AUX_MODEL || '' }}
          opencode-api-key: ${{ secrets.OPENCODE_API_KEY }}
          deepseek-api-key: ${{ secrets.DEEPSEEK_API_KEY }}
          openai-api-key: ${{ secrets.OPENAI_API_KEY }}
          openai-compatible-api-key: ${{ secrets.JBOT_OPENAI_COMPATIBLE_API_KEY }}
          openai-compatible-base-url: ${{ vars.JBOT_OPENAI_COMPATIBLE_BASE_URL }}
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          gemini-api-key: ${{ secrets.GEMINI_API_KEY }}
          openrouter-api-key: ${{ secrets.OPENROUTER_API_KEY }}
          nvidia-api-key: ${{ secrets.NVIDIA_API_KEY }}
          zai-api-key: ${{ secrets.ZAI_API_KEY }}
          kimi-api-key: ${{ secrets.KIMI_API_KEY }}
          xai-api-key: ${{ secrets.XAI_API_KEY }}
          fireworks-api-key: ${{ secrets.FIREWORKS_API_KEY }}
          mimo-api-key: ${{ secrets.MIMO_API_KEY }}
          devin-windsurf-api-key: ${{ secrets.DEVIN_WINDSURF_API_KEY }}
          commandcode-access-key: ${{ secrets.COMMANDCODE_ACCESS_KEY }}
          cursor-api-key: ${{ secrets.CURSOR_API_KEY }}
          qoder-token: ${{ secrets.QODER_PERSONAL_ACCESS_TOKEN }}
          codex-auth: ${{ secrets.CODEX_AUTH_JSON }}
          cline-auth: ${{ secrets.CLINE_AUTH_JSON }}
          grok-auth: ${{ secrets.GROK_AUTH_JSON }}
          kilo-auth: ${{ secrets.KILO_AUTH_CONTENT }}
          enable-context7: auto
          context7-api-key: ${{ secrets.CONTEXT7_API_KEY }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
          thread-resolution-token: ${{ secrets.JBOT_REVIEW_THREAD_RESOLUTION_TOKEN }}
```

The minimal version reviews every push. The full example also supports
**one-off reviews** — comment `/jbot [--provider=<id>] [--model=<id>]` on a PR
(repo owners/members/collaborators only) to re-run the review once with
overrides, e.g. a stronger model as a final sign-off. Semantics — fallbacks,
fork policy, `workflow_dispatch` parity — are documented in
[`pgup-ai/jbot-review-action`](https://github.com/pgup-ai/jbot-review-action#one-off-reviews-jbot).

**Step 2 — Add provider API keys as secrets.** In the repo: Settings → Secrets
and variables → Actions → New repository secret. Add the keys for the providers
you want to use, such as `OPENCODE_API_KEY`, `DEEPSEEK_API_KEY`, `OPENAI_API_KEY`,
`GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `NVIDIA_API_KEY`, `ZAI_API_KEY`, `KIMI_API_KEY`,
`XAI_API_KEY`, `FIREWORKS_API_KEY`, `MIMO_API_KEY`, `DEVIN_WINDSURF_API_KEY`,
`COMMANDCODE_ACCESS_KEY`, `CURSOR_API_KEY`, `QODER_PERSONAL_ACCESS_TOKEN`, `CODEX_AUTH_JSON`,
`CLINE_AUTH_JSON`, `GROK_AUTH_JSON`, `KILO_AUTH_CONTENT`, `ANTHROPIC_API_KEY`, or
`JBOT_OPENAI_COMPATIBLE_API_KEY`. Configure `JBOT_OPENAI_COMPATIBLE_BASE_URL`
as an Actions variable when using the generic `openai-compatible` provider.
Empty provider key inputs are ignored; if a cross-provider auxiliary model has
no key for the selected aux provider, it reuses the review provider API key.
`opencode-go` uses the same `OPENCODE_API_KEY` as `opencode`.

**CLI-backend credentials — where to get each one.** Unlike the model-provider keys
above, these authenticate with a local CLI login or a dashboard key. You paste the
**whole file** (Codex, Cline, Grok Build) or the **key value** (Cursor, Devin,
Command Code) — no digging a field out of a JSON.

| Backend          | Get the credential                                                                                                                                      | Secret (Action input)                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **Codex CLI**    | `codex login` (ChatGPT Plus/Pro) → paste the whole `~/.codex/auth.json`                                                                                 | `CODEX_AUTH_JSON` (`codex-auth`)                                 |
| **Cline**        | `cline auth` → paste the whole `~/.cline/data/settings/providers.json`                                                                                  | `CLINE_AUTH_JSON` (`cline-auth`)                                 |
| **Grok Build**   | `grok login --device-auth` → paste `~/.grok/auth.json`; alternatively create an xAI API key                                                             | `GROK_AUTH_JSON` (`grok-auth`), or `XAI_API_KEY` (`xai-api-key`) |
| **Cursor**       | Create a key at [cursor.com/dashboard/integrations](https://cursor.com/dashboard/integrations) → paste it (`crsr_…`)                                    | `CURSOR_API_KEY` (`cursor-api-key`)                              |
| **Qoder CLI**    | Create a Personal Access Token under [Qoder Integrations](https://qoder.com/account/integrations)                                                       | `QODER_PERSONAL_ACCESS_TOKEN` (`qoder-token`)                    |
| **Devin**        | `devin auth login` → copy `windsurf_api_key` (`devin-session-token$…`) from `~/.local/share/devin/credentials.toml` ([docs](https://docs.devin.ai/cli)) | `DEVIN_WINDSURF_API_KEY` (`devin-windsurf-api-key`)              |
| **Command Code** | Create an access key at [commandcode.ai](https://commandcode.ai/docs/quickstart) (`user_…`; the `apiKey` in `~/.commandcode/auth.json`) → paste it      | `COMMANDCODE_ACCESS_KEY` (`commandcode-access-key`)              |
| **Kilo**         | `kilo auth login` → paste the whole `~/.local/share/kilo/auth.json`                                                                                     | `KILO_AUTH_CONTENT` (`kilo-auth`)                                |

Each CLI backend runs **read-only** and only when it's the selected
`provider`/`aux-provider`. Cline and Command Code write their credential into an
isolated temporary `HOME`, Codex into a temporary `CODEX_HOME`, and Qoder carries
its PAT through a one-time SDK auth payload while using a temporary `HOME`; each is
removed after the run. Cursor reads its key straight from the env (no file); Devin writes
`~/.local/share/devin/credentials.toml` under the process `HOME`. Cline uses only
the auth token — the file's `model`/`reasoning` are stripped — and has two billing
modes sharing one secret: `cline` (pay-as-you-go) and `cline-pass` (Cline
subscription). Kilo reads its credential from the `KILO_AUTH_CONTENT` env var (no
file written) with an isolated temporary `HOME`/`XDG_DATA_HOME` per session,
removed after the run; it defaults to the free `kilo/kilo-auto/free` gateway
model.

Qoder can read and search the checkout but receives no shell or write-capable tool.
Its user/project settings, hooks, MCP servers, skills, memory, web access, and
subagents are disabled. The complete diff is embedded with the same 512 KiB
per-shard ceiling used by other shell-free backends; an oversized main review
fails before calling the model, while oversized auxiliary sessions fail open.

`grok` is an opt-in Grok Build CLI backend and is intentionally separate from
`xai`: existing `provider: xai` configurations continue using `XAI_API_KEY`
through the SDK engine unchanged. For `provider: grok`, account auth is preferred
when both credentials are configured; the API key is passed only when account
auth is absent, so an expired login cannot silently switch to paid API usage.
Grok Build runs headlessly with edits, shell,
MCP, web access, memory, and subagents disabled. It receives the budgeted review
prompt in an empty read-only temporary workspace, so repository Grok config,
plugins, and hooks cannot execute. To preserve full-diff coverage without checkout
access, jbot-review embeds up to 512 KiB per shard and refuses a main review (or
skips fail-open auxiliary sessions) if that still cannot carry the complete diff.
Sessions are serialized through one per-run temporary Grok home, removed after
the run. With account auth, this lets credential rotations persist without
concurrent writes. Whether a rotated refresh token from one ephemeral
GitHub-hosted run can be reused from the original `GROK_AUTH_JSON` secret on the
next run is not yet a documented xAI contract. Treat repeated hosted-run auth as
unresolved during dogfood; jbot-review never logs or exports the rotated
credential.
The CLI account's availability, quota, and acceptable-use terms remain controlled
by xAI; dogfood with `provider: grok`, `model: grok/default`, and conservative
concurrency before wider use.

Add `CONTEXT7_API_KEY` only if you want docs lookup for external API, SDK,
framework, CLI, cloud-service, or workflow changes.

**Secret exposure:** the example above passes multiple provider secrets so
`JBOT_REVIEW_PROVIDER` and `JBOT_AUX_PROVIDER` can switch providers without
another YAML edit. For a least-privilege setup, pass only the selected provider
keys:

```yaml
with:
  provider: opencode
  model: ${{ vars.JBOT_REVIEW_MODEL || '' }}
  aux-provider: openrouter
  aux-model: ${{ vars.JBOT_REVIEW_AUX_MODEL || '' }}
  opencode-api-key: ${{ secrets.OPENCODE_API_KEY }}
  openrouter-api-key: ${{ secrets.OPENROUTER_API_KEY }}
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
`.cursor/BUGBOT.md`, `.coderabbit.yaml`, `greptile.json`, or
`.pr-governance/README.md` at the repo root. The agent reads these during review.
Markdown docs referenced from those files are preloaded into the review context
(within the guidance byte budget); anything beyond the budget is listed as an
available path the agent can read on demand.

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
and `JBOT_AUX_PROVIDER` / `JBOT_REVIEW_AUX_MODEL` can switch auxiliary providers
without editing the workflow.

```yaml
- uses: actions/checkout@v7
  with:
    fetch-depth: 0
    ref: ${{ github.event.pull_request.head.sha || format('refs/pull/{0}/head', inputs['pr-number']) }}
- uses: actions/setup-node@v6
  with:
    node-version: '24'
- run: npm ci
- run: npm run build
- run: docker build -t ghcr.io/pgup-ai/jbot-review:latest .
- uses: ./
  with:
    provider: ${{ inputs.provider || vars.JBOT_REVIEW_PROVIDER || 'opencode' }}
    model: ${{ inputs.model || vars.JBOT_REVIEW_MODEL || '' }}
    aux-provider: ${{ vars.JBOT_AUX_PROVIDER || '' }}
    aux-model: ${{ vars.JBOT_REVIEW_AUX_MODEL || '' }}
    pr-number: ${{ github.event.pull_request.number || inputs['pr-number'] }}
    dry-run: ${{ inputs['dry-run'] || 'false' }}
    max-findings: ${{ inputs['max-findings'] || '0' }}
    min-severity: ${{ inputs['min-severity'] || 'nit' }}
    include-prior-comments: ${{ inputs['include-prior-comments'] || 'true' }}
    fail-on-error: ${{ inputs['fail-on-error'] || 'true' }}
    opencode-api-key: ${{ secrets.OPENCODE_API_KEY }}
    deepseek-api-key: ${{ secrets.DEEPSEEK_API_KEY }}
    openai-api-key: ${{ secrets.OPENAI_API_KEY }}
    openai-compatible-api-key: ${{ secrets.JBOT_OPENAI_COMPATIBLE_API_KEY }}
    openai-compatible-base-url: ${{ vars.JBOT_OPENAI_COMPATIBLE_BASE_URL }}
    anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
    gemini-api-key: ${{ secrets.GEMINI_API_KEY }}
    openrouter-api-key: ${{ secrets.OPENROUTER_API_KEY }}
    nvidia-api-key: ${{ secrets.NVIDIA_API_KEY }}
    zai-api-key: ${{ secrets.ZAI_API_KEY }}
    kimi-api-key: ${{ secrets.KIMI_API_KEY }}
    xai-api-key: ${{ secrets.XAI_API_KEY }}
    fireworks-api-key: ${{ secrets.FIREWORKS_API_KEY }}
    mimo-api-key: ${{ secrets.MIMO_API_KEY }}
    devin-windsurf-api-key: ${{ secrets.DEVIN_WINDSURF_API_KEY }}
    commandcode-access-key: ${{ secrets.COMMANDCODE_ACCESS_KEY }}
    cursor-api-key: ${{ secrets.CURSOR_API_KEY }}
    qoder-token: ${{ secrets.QODER_PERSONAL_ACCESS_TOKEN }}
    grok-auth: ${{ secrets.GROK_AUTH_JSON }}
    kilo-auth: ${{ secrets.KILO_AUTH_CONTENT }}
    enable-context7: auto
    context7-api-key: ${{ secrets.CONTEXT7_API_KEY }}
    github-token: ${{ secrets.GITHUB_TOKEN }}
    thread-resolution-token: ${{ secrets.JBOT_REVIEW_THREAD_RESOLUTION_TOKEN }}
```

### Review quality controls

Every run reviews the complete base...head diff (never just the latest
commit); repeats of findings already covered by prior jbot threads are
suppressed in code before posting. Several inputs tune the recall/precision/cost
balance:

**Posting behavior.** The first visible run on a PR always posts a review
(baseline), and any run that finds something posts. A clean re-run posts no
comment. The 🚀 reaction means **the PR has no open jbot findings** — it is
added only when a real review leaves zero new findings _and_ every prior
finding thread is resolved, and removed when a review starts. So 🚀-present
means "reviewed, all good"; 🚀-absent means a review is in flight or the PR
has open findings. Addressed-thread replies and resolution always run
regardless. A docs/diagram-only PR is skipped before any model call (see
`skip-doc-only`) and leaves the reaction unchanged (it isn't reviewed, so it
neither earns nor loses the 🚀). _Reactions are best-effort: if they don't
appear, grant the workflow `issues: write` (PR reactions use the issues API);
the review itself is unaffected._

| Input                     | Default                        | Effect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `review-passes`           | `1`                            | Total review passes (1–3). Passes beyond the first add focused recall lenses (cross-hunk interactions, then security/data-integrity) in parallel on the aux model; findings merge and dedupe. Raise to 2-3 for maximum recall.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `dynamic-fanout`          | `true`                         | Scale the recall-supplement fan-out (extra lens passes + the guideline-compliance pass) to the diff's risk and size: a small, low-risk change (≤3 files, ≤60 added lines, no security/data/API/infra path or build/CI tooling like `package.json`/`action.yml`/workflows, no dependency-manifest change, no large deletion) runs the general pass only and skips the guideline pass; everything else runs the full requested fan-out. The requested config is the ceiling — this only ever reduces it, and never gates the main full-diff review or `verify-findings`. Set `false` to force the full requested fan-out on every PR.                         |
| `verify-findings`         | `true`                         | Blocking (P0–P2) findings are adversarially re-checked in a dedicated session before posting: refuted findings are dropped, uncertain ones demoted to advisory.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `aux-model`               | unset                          | Model for the auxiliary sessions (lens passes, addressed-thread check, guideline compliance, verification). Resolves against `aux-provider`/`JBOT_AUX_PROVIDER` when set, otherwise the main provider. Lets the main review run on a stronger tier while supporting checks stay cheap and fast.                                                                                                                                                                                                                                                                                                                                                             |
| `aux-provider`            | main provider                  | Optional provider for `aux-model`; can come from `JBOT_AUX_PROVIDER`. If the aux provider's key input/env var is supplied, aux sessions use it; otherwise they reuse the review provider API key.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `review-shards`           | `1`                            | Parallel shards for the main review. `1` = no sharding, one full-diff session (default). `0` = auto from diff size, capped at 4. `N` = pin N shards. Sharding only speeds review up on providers that serve concurrent sessions; on free/throttled tiers the shards serialize on one key (see `max-concurrent-sessions`), so single-session is the better default. Either way the review covers the complete diff; raise it on paid concurrent tiers, or for very large PRs where smaller per-shard context helps depth.                                                                                                                                    |
| `time-budget-minutes`     | `30`                           | Wall-clock target (`0` = no budget). Finder sessions get the full budget (minus a 30s posting reserve) as their deadline; shard retries and verification use whatever remains, or are skipped (fail-open). An auxiliary session (lens, addressed-thread, guideline, verification) over its deadline is aborted and fails open — degrading only its own coverage, never the run. A main review shard that still fails after its retry aborts the run rather than posting partial coverage.                                                                                                                                                                   |
| `max-concurrent-sessions` | `3`                            | Max model sessions in flight (`0` = unlimited). Free/throttled tiers serialize one key's requests upstream — observed as a flash session queued 7+ minutes behind parallel shards. The capped default keeps each session's deadline measuring model time, not queue time; drop to `2` on tight free tiers, or set `0` on paid tiers with real concurrency.                                                                                                                                                                                                                                                                                                  |
| `model-options`           | `{"reasoningEffort":"medium"}` | JSON object of provider options for the main model, passed through opencode to the provider SDK. Medium balances depth and latency; set `{"reasoningEffort":"high"}` on paid heavy tiers for maximum depth, or pass `{}` to send no options (e.g. for providers that reject unknown keys).                                                                                                                                                                                                                                                                                                                                                                  |
| `prompt-cache`            | `true`                         | Enable opencode prompt caching (provider `setCacheKey`). Parallel shards and re-reviews of the same PR share a byte-identical prompt prefix, so caching cuts input-token cost on models that honor it; models marked unsupported by capability metadata omit the cache key entirely. Each session logs a `tokens: …` line with `cache(read=… write=…)` — `read > 0` on a later shard or re-review confirms a hit. Mostly matters on paid tiers.                                                                                                                                                                                                             |
| `skip-doc-only`           | `true`                         | Skip the full review (no model call) when the entire PR diff is documentation, prose, or diagram assets (`.md`, `.mdx`, `.markdown`, `.rst`, `.adoc`, `.txt`, `.pdf`, `.svg`, `.drawio`, `.dio`, `.excalidraw`, `.mmd`, `.puml`, `.plantuml`); the reaction is left unchanged (a docs push doesn't change the verdict). Evaluated on the **reviewable** file set (noise like lockfiles and patchless/binary files are excluded — the bot never reviews those anyway, so the skip never drops review coverage); any reviewable code/config file forces a full review. Set `false` to always review, e.g. for docs with embedded code samples you care about. |
| `review-telemetry`        | `true`                         | Write per-finding disposition + per-session token telemetry to the gitignored `.jbot-review/telemetry.jsonl` (uploaded as a CI artifact by the dogfood workflow). Near-zero overhead; `false` disables.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `evidence-quotes`         | `true`                         | Ask each finding for a verbatim quote of the changed line it flags. Grounds finding verification and lets a finding whose line anchor missed the diff be re-anchored to its quoted line instead of dropped. `false` restores the pre-evidence prompt byte-for-byte.                                                                                                                                                                                                                                                                                                                                                                                         |

**Heavy-model recipe** (deep reviews from GPT‑5.x / Opus-class models with
longer timeout headroom): set the main `model` to the heavy tier, then

```yaml
model: ${{ vars.JBOT_REVIEW_MODEL }} # heavy tier, e.g. openai/gpt-5.5
aux-provider: ${{ vars.JBOT_AUX_PROVIDER || '' }}
aux-model: ${{ vars.JBOT_REVIEW_AUX_MODEL }} # fast tier for lenses + verification
review-shards: '0' # opt into auto-sharding on a paid concurrent tier
max-concurrent-sessions: '0' # unlimited on a paid concurrent tier (default caps at 3)
# defaults already active: review-shards 1 (off), time-budget-minutes 30,
# model-options {"reasoningEffort":"medium"}; raise to high on paid heavy tiers.
```

On a paid tier with real session concurrency, sharding keeps each heavy session
small (one shard ≈ 24KB of diff), so reasoning time is bounded by the shard, not
the PR; a main shard that still fails after its retry aborts the run rather than
posting partial coverage (auxiliary sessions fail open and degrade only their
own coverage). On free/throttled tiers the shards serialize on one key, so the
default single session is both simpler and no slower — leave `review-shards` at
`1` there.

### Provider configuration (in-repo)

See the generated [model ID catalog](./MODEL_CATALOG.md) for every current
Models.dev ID and the model IDs exposed by each supported CLI. Refresh it with
`npm run models:update`; account-scoped CLI sections require those CLIs to be
authenticated locally. The generator uses the npm versions pinned in the
Docker image; Cursor comes from its vendor-installed binary, while Devin has no
enumerable catalog command and is documented as that explicit boundary.

**SDK engines.** Non-CLI providers run on one of two in-repo SDK engines,
chosen automatically per session role. The rule: a provider pi can also serve
routes to the in-process [pi SDK](https://pi.dev/docs/latest/sdk) first; the
opencode server serves the rest. pi's allowlist covers `anthropic`, `openai`,
`google`, `deepseek`, `xai`, `openrouter`,
`fireworks-ai`, `zai-coding-plan`, `xiaomi-token-plan-sgp`, `nvidia`, and the
`opencode`/`opencode-go` Zen gateways (which pi reaches over their HTTP
endpoint directly, not through the opencode server). `kimi-for-coding` and
`openai-compatible` stay on opencode. Set
`JBOT_SDK_ENGINE=opencode` to pin every SDK session to opencode — the one-line
rollback if pi misbehaves, and the path CLI backends' aux sessions still use.
The pi engine requires Node >= 22.19 (the published Docker image runs Node 24); on older runtimes it
disables itself and logs why. pi sessions run hermetically (no user-level pi
config, skills, or prompt templates are loaded), get no shell (pi ships no
sandbox, so read-only is enforced by withholding `bash` rather than by
filtering it — the diff is embedded in the prompt, and a read-only `git_diff`
tool serves any hunks past the embed budget), and manage provider prompt
caching natively, so `JBOT_PROMPT_CACHE` applies to opencode-served sessions
only.

Review metadata reports backend usage counters when they are available.
OpenCode-backed and Qoder sessions report token counters and cost from result
metadata; Devin CLI sessions also contribute usage when the ATIF export includes
token or cost records. Other CLI backends do not expose machine-readable
per-session usage today, so those sessions may be absent from the metadata block.
These counters are observability only: they do not identify API keys,
accounts, organizations, quota buckets, remaining quota, or reset times, so
jbot-review does not use them for smart key rotation.

| `provider`              | Default model                                              | Action key input                | Secret/env var                       |
| ----------------------- | ---------------------------------------------------------- | ------------------------------- | ------------------------------------ |
| `opencode`              | `opencode/deepseek-v4-flash-free`                          | `opencode-api-key`              | `OPENCODE_API_KEY`                   |
| `opencode-go`           | `opencode-go/deepseek-v4-flash`                            | `opencode-api-key`              | `OPENCODE_API_KEY`                   |
| `deepseek`              | `deepseek/deepseek-v4-flash`                               | `deepseek-api-key`              | `DEEPSEEK_API_KEY`                   |
| `openai`                | `openai/gpt-5.4-nano`                                      | `openai-api-key`                | `OPENAI_API_KEY`                     |
| `openai-compatible`     | required                                                   | `openai-compatible-api-key`     | `JBOT_OPENAI_COMPATIBLE_API_KEY`     |
| `anthropic`             | `anthropic/claude-sonnet-4-6`                              | `anthropic-api-key`             | `ANTHROPIC_API_KEY`                  |
| `google`                | `google/gemini-2.5-flash`                                  | `gemini-api-key`                | `GEMINI_API_KEY`                     |
| `openrouter`            | `openrouter/openai/gpt-4o-mini`                            | `openrouter-api-key`            | `OPENROUTER_API_KEY`                 |
| `nvidia`                | `nvidia/nemotron-3-ultra-550b-a55b`                        | `nvidia-api-key`                | `NVIDIA_API_KEY`                     |
| `zai-coding-plan`       | `zai-coding-plan/glm-5.2`                                  | `zai-api-key`                   | `ZAI_API_KEY`                        |
| `kimi-for-coding`       | `kimi-for-coding/k3`                                       | `kimi-api-key`                  | `KIMI_API_KEY`                       |
| `xai`                   | `xai/grok-4.3`                                             | `xai-api-key`                   | `XAI_API_KEY`                        |
| `fireworks-ai`          | `fireworks-ai/accounts/fireworks/models/deepseek-v4-flash` | `fireworks-api-key`             | `FIREWORKS_API_KEY`                  |
| `xiaomi-token-plan-sgp` | `xiaomi-token-plan-sgp/mimo-v2.5-pro`                      | `mimo-api-key`                  | `MIMO_API_KEY`                       |
| `devin`                 | `devin/default`                                            | `devin-windsurf-api-key`        | `DEVIN_WINDSURF_API_KEY`             |
| `commandcode`           | `commandcode/default`                                      | `commandcode-access-key`        | `COMMANDCODE_ACCESS_KEY`             |
| `cursor`                | `cursor/default`                                           | `cursor-api-key`                | `CURSOR_API_KEY`                     |
| `qoder`                 | `qoder/auto`                                               | `qoder-token`                   | `QODER_PERSONAL_ACCESS_TOKEN`        |
| `codex`                 | `codex/default`                                            | `codex-auth`                    | `CODEX_AUTH_JSON`                    |
| `cline`                 | `cline/default`                                            | `cline-auth`                    | `CLINE_AUTH_JSON`                    |
| `cline-pass`            | `cline-pass/default`                                       | `cline-auth`                    | `CLINE_AUTH_JSON`                    |
| `grok`                  | `grok/default`                                             | `grok-auth`, then `xai-api-key` | `GROK_AUTH_JSON`, then `XAI_API_KEY` |
| `kilo`                  | `kilo/kilo-auto/free`                                      | `kilo-auth`                     | `KILO_AUTH_CONTENT`                  |

Use `provider: zai-coding-plan` with `zai-api-key` / `ZAI_API_KEY` for the
Z.AI GLM Coding Plan subscription endpoint.
Use `provider: kimi-for-coding` with `kimi-api-key` / `KIMI_API_KEY` for the
native Models.dev Kimi Coding Plan provider. Its current default is Kimi K3.

```yaml
provider: kimi-for-coding
kimi-api-key: ${{ secrets.KIMI_API_KEY }}
```

For an arbitrary OpenAI-compatible endpoint, set all three explicit values:

```yaml
provider: openai-compatible
model: openai-compatible/my-served-model
openai-compatible-api-key: ${{ secrets.JBOT_OPENAI_COMPATIBLE_API_KEY }}
openai-compatible-base-url: ${{ vars.JBOT_OPENAI_COMPATIBLE_BASE_URL }}
```

These namespaced settings never fall back to `OPENAI_API_KEY` or
`OPENAI_BASE_URL`, so the direct `openai` provider remains isolated. The model
is required because a generic endpoint has no safe provider-wide default.
For local review or the webhook app, the equivalent environment is:

```dotenv
PROVIDER=openai-compatible
MODEL=openai-compatible/my-served-model
JBOT_OPENAI_COMPATIBLE_API_KEY=sk-example
JBOT_OPENAI_COMPATIBLE_BASE_URL=https://proxy.example/v1
```

J-Bot omits its `setCacheKey` option for both `kimi-for-coding` and
`openai-compatible`: the live catalog does not advertise it for Kimi, and a
generic endpoint may reject the extra request field.

Use `provider: google` with `gemini-api-key` / `GEMINI_API_KEY` for direct
Gemini API key auth.
Use `provider: devin` with `devin-windsurf-api-key` /
`DEVIN_WINDSURF_API_KEY` for the Devin CLI backend. The Docker image includes
the Devin CLI, but credentials are written only when the main or active
auxiliary provider is `devin`.
Use `provider: commandcode` with `commandcode-access-key` /
`COMMANDCODE_ACCESS_KEY` for the CommandCode CLI backend. The Docker image
includes the CommandCode CLI, but `.commandcode/auth.json` is written under an
isolated temporary HOME only when the main or active auxiliary provider is
`commandcode`, then removed after the run.
Use `provider: cursor` with `cursor-api-key` / `CURSOR_API_KEY` for the Cursor
CLI backend. The Docker image includes the Cursor CLI (`cursor-agent`), which
reads the key from the environment — no credential file — and runs read-only via
`--mode plan`.
Use `provider: qoder` with `qoder-token` /
`QODER_PERSONAL_ACCESS_TOKEN` for the Qoder CLI backend. It accepts `auto`,
`ultimate`, `performance`, `efficient`, and `lite` model tiers. Each session uses
an isolated temporary home and the Agent SDK's streaming protocol; project/user
settings, hooks, MCP, writes, shell, web access, and subagents are disabled.

Set the `provider` and `model` inputs to override the defaults. For automatic
PR reviews without editing workflow YAML on every provider or model change,
define Actions configuration variables named `JBOT_REVIEW_PROVIDER` and
`JBOT_REVIEW_MODEL` at the repository or organization level and pass them
through the workflow. Leave `JBOT_REVIEW_PROVIDER` unset to use `opencode`, and
leave `JBOT_REVIEW_MODEL` unset to use the selected provider's default model
(`openai-compatible` is the exception and requires it):

```yaml
- uses: pgup-ai/jbot-review-action@v0
  with:
    provider: ${{ vars.JBOT_REVIEW_PROVIDER || 'opencode' }}
    model: ${{ vars.JBOT_REVIEW_MODEL || '' }}
    aux-provider: ${{ vars.JBOT_AUX_PROVIDER || '' }}
    aux-model: ${{ vars.JBOT_REVIEW_AUX_MODEL || '' }}
    opencode-api-key: ${{ secrets.OPENCODE_API_KEY }}
    deepseek-api-key: ${{ secrets.DEEPSEEK_API_KEY }}
    openai-api-key: ${{ secrets.OPENAI_API_KEY }}
    openai-compatible-api-key: ${{ secrets.JBOT_OPENAI_COMPATIBLE_API_KEY }}
    openai-compatible-base-url: ${{ vars.JBOT_OPENAI_COMPATIBLE_BASE_URL }}
    anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
    gemini-api-key: ${{ secrets.GEMINI_API_KEY }}
    openrouter-api-key: ${{ secrets.OPENROUTER_API_KEY }}
    nvidia-api-key: ${{ secrets.NVIDIA_API_KEY }}
    zai-api-key: ${{ secrets.ZAI_API_KEY }}
    kimi-api-key: ${{ secrets.KIMI_API_KEY }}
    xai-api-key: ${{ secrets.XAI_API_KEY }}
    fireworks-api-key: ${{ secrets.FIREWORKS_API_KEY }}
    mimo-api-key: ${{ secrets.MIMO_API_KEY }}
    devin-windsurf-api-key: ${{ secrets.DEVIN_WINDSURF_API_KEY }}
    commandcode-access-key: ${{ secrets.COMMANDCODE_ACCESS_KEY }}
    cursor-api-key: ${{ secrets.CURSOR_API_KEY }}
    qoder-token: ${{ secrets.QODER_PERSONAL_ACCESS_TOKEN }}
    grok-auth: ${{ secrets.GROK_AUTH_JSON }}
    enable-context7: auto
    context7-api-key: ${{ secrets.CONTEXT7_API_KEY }}
    github-token: ${{ secrets.GITHUB_TOKEN }}
    thread-resolution-token: ${{ secrets.JBOT_REVIEW_THREAD_RESOLUTION_TOKEN }}
```

The action reads the key matching the selected `provider`. When `aux-model` uses
a different opencode-backed provider, the action uses the aux provider's key
input/env var if it is supplied; otherwise it reuses the review provider API key
for the aux provider. CLI backends cannot reuse opencode-provider keys, and
opencode-backed providers cannot reuse CLI backend keys such as
`DEVIN_WINDSURF_API_KEY` or `COMMANDCODE_ACCESS_KEY`, so mixed CLI/opencode-backed
main+aux configurations must pass both keys. Future provider changes can be made
through `JBOT_REVIEW_PROVIDER` and
`JBOT_AUX_PROVIDER` without editing the workflow YAML. It accepts provider and
model from either action inputs or environment variables: `provider` or
`JBOT_REVIEW_PROVIDER` for the main provider, `model` or `JBOT_REVIEW_MODEL` for
the main model, `aux-provider` or `JBOT_AUX_PROVIDER` for the auxiliary
provider, and `aux-model` or `JBOT_REVIEW_AUX_MODEL` for the auxiliary model.
Provider API keys can also be supplied through their standard env vars, such as
`GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `NVIDIA_API_KEY`, `ZAI_API_KEY`,
`KIMI_API_KEY`, `JBOT_OPENAI_COMPATIBLE_API_KEY`, or `FIREWORKS_API_KEY`. The
custom endpoint also reads `JBOT_OPENAI_COMPATIBLE_BASE_URL`. This convenience
pattern exposes every configured provider key to the action runtime.
When `openai-compatible` is the auxiliary provider, pass its namespaced key and
base URL alongside `aux-provider` / `aux-model`.
For the smallest secret surface area, pass only the review provider key, plus an
aux provider key only when it must be different.
If `model` is set, it is interpreted as a model id for the selected `provider`.
A matching `provider/model` prefix is accepted and normalized, so
`deepseek-v4-flash-free` and `opencode/deepseek-v4-flash-free` are equivalent
when `provider` is `opencode`. Slash-containing provider catalog ids such as
`moonshotai/kimi-k2.6` are passed through as the model id for the selected
provider.

For manual reruns, `workflow_dispatch` provider and model inputs can take
precedence over `JBOT_REVIEW_PROVIDER` and `JBOT_REVIEW_MODEL`; automatic
`pull_request` runs use the variable values.

### Context7 documentation lookup

Set `enable-context7: auto` and pass `context7-api-key` from
`secrets.CONTEXT7_API_KEY` to let the review agent verify current docs when the
PR changes external API, SDK, framework, CLI, cloud-service, or GitHub Actions
usage. In `auto` mode, Context7 is skipped for ordinary business-logic changes.

Context7 failures are non-blocking: if the MCP server cannot connect, rejects
auth, or rate-limits, the action logs a warning and continues the review without
documentation lookup.

### Input reference

| Input                        | Required | Default               | Description                                                                            |
| ---------------------------- | -------- | --------------------- | -------------------------------------------------------------------------------------- |
| `provider`                   | No       | `opencode`            | LLM provider key; can come from `JBOT_REVIEW_PROVIDER`                                 |
| `model`                      | No       | Provider default      | Provider model id; required for `openai-compatible`; can come from `JBOT_REVIEW_MODEL` |
| `aux-provider`               | No       | Main provider         | Auxiliary model provider; can come from `JBOT_AUX_PROVIDER`                            |
| `aux-model`                  | No       | Main model            | Auxiliary model id; can come from `JBOT_REVIEW_AUX_MODEL`                              |
| `opencode-api-key`           | No       | —                     | Used when `provider` or `aux-provider` is `opencode`/`opencode-go`                     |
| `deepseek-api-key`           | No       | —                     | Used when `provider` or `aux-provider` is `deepseek`                                   |
| `openai-api-key`             | No       | —                     | Used when `provider` or `aux-provider` is `openai`                                     |
| `openai-compatible-api-key`  | No       | —                     | Namespaced key for `openai-compatible`                                                 |
| `openai-compatible-base-url` | No       | —                     | Required endpoint URL for `openai-compatible`                                          |
| `anthropic-api-key`          | No       | —                     | Used when `provider` or `aux-provider` is `anthropic`                                  |
| `gemini-api-key`             | No       | —                     | Used when `provider` or `aux-provider` is `google`                                     |
| `openrouter-api-key`         | No       | —                     | Used when `provider` or `aux-provider` is `openrouter`                                 |
| `nvidia-api-key`             | No       | —                     | Used when `provider` or `aux-provider` is `nvidia`                                     |
| `zai-api-key`                | No       | —                     | Used when `provider` or `aux-provider` is `zai-coding-plan`                            |
| `kimi-api-key`               | No       | —                     | Used when `provider` or `aux-provider` is `kimi-for-coding`                            |
| `xai-api-key`                | No       | —                     | Used by `xai`, or by `grok` when `grok-auth` is empty                                  |
| `fireworks-api-key`          | No       | —                     | Used when `provider` or `aux-provider` is `fireworks-ai`                               |
| `devin-windsurf-api-key`     | No       | —                     | Used when `provider` or active `aux-provider` is `devin`                               |
| `commandcode-access-key`     | No       | —                     | Used when `provider` or active `aux-provider` is `commandcode`                         |
| `cursor-api-key`             | No       | —                     | Used when `provider` or active `aux-provider` is `cursor`                              |
| `qoder-token`                | No       | —                     | Used when `provider` or active `aux-provider` is `qoder`                               |
| `codex-auth`                 | No       | —                     | Used when `provider` or active `aux-provider` is `codex`                               |
| `cline-auth`                 | No       | —                     | Used when `provider` or active `aux-provider` is `cline` / `cline-pass`                |
| `grok-auth`                  | No       | —                     | Grok account auth; preferred over `xai-api-key` when `grok` is selected                |
| `kilo-auth`                  | No       | —                     | Used when `provider` or active `aux-provider` is `kilo`                                |
| `enable-context7`            | No       | `auto`                | Use Context7 MCP for external contract changes; `auto`, `true`, or `false`             |
| `context7-api-key`           | No       | —                     | Optional Context7 key for reliable CI docs lookup                                      |
| `github-token`               | Yes      | `${{ github.token }}` | Token to read PR and post review                                                       |
| `thread-resolution-token`    | No       | —                     | Optional token used only to resolve addressed review threads                           |
| `pr-number`                  | No       | —                     | PR number for manual `workflow_dispatch` reviews                                       |
| `dry-run`                    | No       | `false`               | Log review output without posting to GitHub                                            |
| `max-findings`               | No       | `0`                   | Cap findings; `0` means no limit                                                       |
| `min-severity`               | No       | `nit`                 | Include `P0`, `P1`, `P2`, `P3`, or `nit`                                               |
| `include-prior-comments`     | No       | `true`                | Include existing PR review comments in context                                         |
| `enable-guideline-pass`      | No       | `true`                | Run a dedicated guideline-compliance session when repo guidelines exist                |
| `fail-on-error`              | No       | `true`                | Fail the workflow if the review cannot complete                                        |

### Review output

`jbot-review` always posts a GitHub `COMMENT` review, not an automatic approval
or request-changes review. The review body includes advisory merge guidance:

- `Needs changes before approval` when any `P0`, `P1`, or `P2` finding is present.
- `Mergeable with non-blocking comments` when only `P3` or `nit` findings are present.
- `Good to go from jbot-review` when no new findings are found.

## Local review

Review the current branch before pushing — no PR, no GitHub token, no GitHub
API call, no `git fetch`:

```bash
npm run review:local
```

- **Diff scope:** merge-base of the branch and `origin/HEAD` (falls back to
  `origin/main`; override with `JBOT_LOCAL_BASE=<ref>`) → the **working
  tree** — uncommitted changes are reviewed; untracked files are listed but
  not reviewed. On a clean tree this equals `base...HEAD`; with no changes it
  prints "nothing to review" and exits 0.
- **Auth:** only the model provider credential — `PROVIDER` plus its key env
  var (same keys as [Provider configuration](#provider-configuration-in-repo);
  full list in `src/shared/config.ts`), plus the namespaced base URL for
  `openai-compatible`. A `.env` in the repo root is loaded by this command only.
  No GitHub credential is read, and nothing is posted anywhere — dry-run is
  enforced in code.
- **Output:** findings print to the terminal; set `JBOT_LOCAL_REPORT=true` to
  also write `.jbot-review/last-run.md` (gitignored).
- **Knobs:** the same env knobs as the hosted app apply — `JBOT_REVIEW_PASSES`,
  `JBOT_VERIFY_FINDINGS`, `JBOT_TIME_BUDGET_MINUTES`, `JBOT_REVIEW_SHARDS`,
  `JBOT_DYNAMIC_FANOUT`, `JBOT_MODEL_OPTIONS`, `JBOT_PROMPT_CACHE`,
  `JBOT_SKIP_DOC_ONLY`, `JBOT_MAX_CONCURRENT_SESSIONS`, `JBOT_REVIEW_TELEMETRY`,
  `JBOT_EVIDENCE_QUOTES`, `JBOT_REVIEW_AUX_MODEL` (+ `JBOT_AUX_PROVIDER`),
  `JBOT_SDK_ENGINE` (see
  [Provider configuration](#provider-configuration-in-repo)). The
  opencode server uses a free ephemeral port automatically;
  `JBOT_OPENCODE_PORT` pins one instead.

## Project guidelines

The action automatically discovers repo-level guidance from the checked-out workspace:

- `AGENTS.md` — conventions and rules
- `REVIEW.md` — review-specific instructions
- `TECHNICAL_STANDARDS.md`, `ARCHITECTURE.md` — engineering and architecture standards
- `CLAUDE.md`, `CONTRIBUTING.md`, `.cursorrules`, `.windsurfrules`
- `.cursor/BUGBOT.md` and `.cursor/rules/*.{md,mdc}` — Cursor/Bugbot rules
- `.coderabbit.yaml`, `.coderabbit.yml`, `greptile.json`
- `.pr-governance/README.md` — governance index and rules

These are injected into the prompt after the base instructions but before the
diff context, so the agent applies your rules when reviewing each change.
Markdown docs referenced from `.pr-governance/README.md` are preloaded (within
the guidance budget) because a governance index points at review rules by
definition; docs referenced from other guidance files are deduplicated and
listed as available paths, read on demand. When any guidelines are discovered,
a dedicated guideline-compliance session audits the diff rule-by-rule in
parallel with the main review (disable with `enable-guideline-pass: false`).
For changed files, J-Bot also checks ancestor directories for scoped review files
such as `REVIEW.md`, `AGENTS.md`, `.cursor/BUGBOT.md`, and `.cursor/rules/`.

## Built-in review playbooks

J-Bot also injects a compact set of built-in review playbooks into each review.
These are bundled prompt checklists, not external skills loaded at runtime, so
reviews stay deterministic and bounded.

- `code-review-core` always runs: correctness, side effects, compatibility,
  tests, security, performance, and maintainability.
- `contract-api` is selected for API, schema, descriptor, config, package,
  workflow, and documented-behavior changes.
- `backend-data` is selected for database, migration, repository, query,
  transaction, idempotency, aggregation, and data-integrity changes.
- `frontend-workflow` is selected for React/UI/client workflow changes.
- `external-integration` is selected for SDK/API clients, webhooks, auth,
  GitHub Actions, workflow, package, and provider/version changes.
- `infra-ops` is selected for IaC, container, Kubernetes/Helm, and
  deployment-config changes.

The playbooks narrow attention, not scope: every selected reviewer still covers
the complete PR diff and must report only concrete, code-grounded findings.

## Project structure

```
src/
  shared/
    runner.ts       # shared orchestration (all entrypoints call this)
    opencode.ts     # opencode serve + SDK review
    github.ts       # list files, post review, verdict
    prompt.ts       # system prompt
    patch.ts        # diff line parser
    filter.ts       # noise filter
    types.ts        # shared types
  workflow/
    index.ts        # in-repo GitHub Action entry point
  app/
    server.ts       # HTTP webhook/API server
    app.ts          # webhook handler + triggers
    auth.ts         # GitHub App JWT → installation token
    clone.ts        # git clone for the review runner
    queue.ts        # in-memory job queue (MVP)
action.yml          # Docker action metadata for in-repo workflow
Dockerfile          # container image
.env.example        # env vars for the server
.github/workflows/jbot-review.yml
```

## Why the `plan` agent

`plan` is OpenCode's built-in read-only agent: it can read, grep, and glob but
cannot edit files. Using it keeps the review safe and avoids non-interactive
permission prompts that hang a CI job. Agent selection is intentionally fixed for
CI reviews; there is no supported `AGENT` env override.

## Notes

- **Fork PRs** won't have the secret (GitHub withholds secrets from fork-triggered
  runs in Actions).
- **OpenCode SDK**: this repo uses `@opencode-ai/sdk` 1.x and
  `client.session.prompt()`. If you bump the SDK, re-check the response shape in
  `opencode.ts`.
