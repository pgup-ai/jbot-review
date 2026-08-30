# Arena model comparison — design

Date: 2026-08-29
Status: approved in discussion; three spec-review iterations completed; awaiting user review
Scope: one comparison feature across `jbot-review` and a dedicated arena repository

## Problem

`review:compare` can run several models over one local diff, but it is sequential
and ephemeral. It does not provide isolated GitHub-hosted runners, a durable
side-by-side record, or a shareable place to inspect every model's review.

The goal is a lightweight, qualitative arena for free or otherwise configured
models. A maintainer names a public target PR and a list of models in a comment
on a long-lived arena PR. Every model reviews the same frozen diff on its own
runner, and all results return to the arena PR.

This is an observational comparison, not a quality benchmark. Finding count and
cross-model agreement do not establish correctness.

## Goals

- Trigger a comparison from a maintainer-gated `/compare` comment on an arena
  PR.
- Resolve one public GitHub PR to immutable base and head SHAs before fan-out.
- Run one fully qualified model per GitHub Actions matrix worker, without model
  fallback or cross-model suppression.
- Use the existing J-Bot review pipeline and preinstalled provider SDKs/CLIs.
- Post one comparison table plus one logical full report per model, normally in
  one flat arena comment and split only when GitHub's body limit requires it.
- Preserve structured results and telemetry as workflow artifacts.
- Keep target repositories untouched and give review workers no GitHub write
  credential.

## Non-goals

- Precision, recall, winner selection, or promotion of a default model. Those
  remain the labelled corpus and adjudication workflow's job.
- Repetitions or statistical ranking in v1. A new command is the manual rerun.
- Inline comments on the target PR or arena PR.
- Private target repositories.
- Model discovery, free-tier detection, dynamic SDK/CLI installation, or
  provider-account provisioning.
- Full production PR context. V1 includes the target title/body and commit diff,
  but excludes prior comments, review threads, linked issues, and checks so each
  model starts from the same neutral context.
- Running target builds, tests, hooks, package installers, or committed
  OpenCode configuration.

## Ownership boundary

The feature has two small surfaces with one versioned contract:

| owner | responsibility |
| --- | --- |
| `jbot-review` | Bundle the existing local driver into the existing image and expose stable frozen-PR input plus structured output. Review behavior and provider tooling remain here. |
| arena repository | Parse `/compare`, resolve the target PR, fan out workers, collect artifacts, and publish arena comments. It contains no review logic. |

The concrete arena repository name is operational configuration, not part of
the interface. This document calls it the **arena repository**.

## Command contract

Only the first line is parsed:

```text
/compare https://github.com/OWNER/REPO/pull/123 --models=provider/model-a,provider/model-b
```

The command job accepts the command only when:

- the event is a newly created comment on a PR in the arena repository;
- the author association is `OWNER`, `MEMBER`, or `COLLABORATOR`;
- the URL is an exact public `github.com/<owner>/<repo>/pull/<positive integer>`
  URL with no credentials, query, fragment, or alternate host;
- `--models` contains 1–8 unique, fully qualified model IDs matching the grammar
  below.

One model reference is 3–512 characters and matches:

```text
<provider>/<model-id>

provider := [a-z0-9][a-z0-9._-]{0,63}
model-id := segment ("/" segment)*
segment  := [A-Za-z0-9._:-]+
```

This admits nested provider model IDs and `:free`-style suffixes while rejecting
whitespace, commas inside one model, shell metacharacters, leading/trailing
slashes, and empty path segments. After this syntax check, J-Bot's existing
`resolveModelSelection` and provider lookup remain authoritative for whether the
provider/model can run. Artifact names use the stable model index plus a SHA-256
digest, never the model string.

Unknown flags, prose after the command, malformed targets, duplicate models, and
an empty list are rejected by the arena. J-Bot's normal model selection rejects
unknown providers and missing or expired credentials as per-model failures,
never as a fallback to another model.

The command supplies models only. All other review knobs come from the pinned
arena workflow or repository variables and are recorded in the result. V1 uses
one review pass and one repetition per model. A one-element model pool ensures
main and auxiliary sessions use the same model.

## Frozen comparison contract

The prepare job reads the public target PR through the GitHub API and writes one
validated `comparison.json`. These TypeScript shapes define the version-1 wire
contract; strings are UTF-8, integer fields are non-negative unless stated, and
SHAs are lowercase 40-character hexadecimal strings:

```ts
interface ComparisonManifestV1 {
  schemaVersion: 1;
  comparisonId: string; // "<arena-owner>/<arena-repo>:pr-<n>:comment-<comment-id>"
  arena: {
    repository: string; // owner/repo
    prNumber: number;
    commandCommentId: number;
    workflowRunId: number;
    runAttempt: number;
  };
  target: {
    url: string;
    owner: string;
    repository: string;
    prNumber: number;
    title: string;
    body: string; // GitHub null normalizes to ""
    base: { repository: string; cloneUrl: string; ref: string; sha: string };
    head: { repository: string; cloneUrl: string; ref: string; sha: string };
  };
  jbot: {
    commitSha: string;
    imageRef: string; // full-commit tag, never latest
    imageDigest: string; // sha256:<64 lowercase hex>; resolved once in prepare
  };
  reviewConfig: {
    enhancedContext: true;
    dryRun: true;
    autoApprove: false;
    maxFindings: 0;
    minSeverity: "nit";
    includePriorComments: false;
    context7Mode: "auto" | "always" | "off";
    guidelinePass: boolean;
    shardCache: false;
    scrubSessionEnv: true;
    auxModelMode: "same-as-main";
    sdkEngine: "auto" | "opencode";
    reviewPasses: number;
    verifyFindings: boolean;
    timeBudgetMinutes: number;
    reviewShards: number;
    dynamicFanout: boolean;
    modelOptions: Record<string, unknown> | null;
    promptCache: boolean;
    skipDocOnly: boolean;
    maxConcurrentSessions: number;
    reviewTelemetry: true;
    evidenceQuotes: boolean;
    contextTrim: boolean;
    embeddedFirstPrompt: boolean;
    guidelineWiden: "auto" | "full";
    verifierSlimContext: boolean;
    verifyOverlapGrace: boolean;
  };
  models: Array<{
    index: number; // zero-based, contiguous, requested order
    model: string;
    provider: string;
    artifactName: string; // "model-<index>-<sha256(model)>"
  }>;
}
```

The prepare job resolves every workflow/repository-variable knob into
`reviewConfig`; workers never re-read mutable repository variables. V1 fixes
enhanced context and dry-run on; posting, prior-comment loading, and shard cache
off; auxiliary sessions to the main model; and the SDK engine to `auto` unless
the arena workflow explicitly freezes `opencode`. The remaining defaults match
today's local path: one pass, auto shards (`reviewShards: 0`), 30-minute budget,
concurrency 3, minimum severity `nit`, unlimited findings, and
verification/guideline-pass/fan-out/cache/doc-only-skip/telemetry/evidence/
embedded-first on. Context trim, slim verifier, and overlap grace are off;
guideline widening and Context7 are `auto`. `modelOptions: null` means the
pinned J-Bot revision resolves its provider default; each result records the
resolved options.

Consumers accept only `schemaVersion: 1`. An unknown version fails before model
use in a worker and becomes `invalid-output` in the publisher. Within version 1,
unknown fields may be ignored; missing, mistyped, or inconsistent required
fields are rejected. A schema change lands producer and consumer support before
the pinned arena image/config advances.

All matrix workers consume the manifest. They clone the head repository at the
exact head SHA, fetch the base SHA from the base repository, and fetch enough
history to compute their merge base. This supports fork PRs and prevents a push
during the run from giving different models different diffs.

Before review, each worker verifies:

- `HEAD` equals `comparison.json.target.head.sha`;
- the base object exists locally;
- the worktree is clean; and
- the merge base can be computed.

The review diff is merge-base-to-head. No branch name is used as a mutable right
side after preparation. The publisher re-reads the target PR head and marks the
summary as a historical snapshot if it advanced during the comparison.

## J-Bot image contract

The existing Docker image already installs the supported provider SDKs and
CLIs. V1 does not install tooling dynamically.

`scripts/build.ts` adds one bundle:

```text
src/local/index.ts -> dist/local/index.js
```

The image's default app-server entrypoint remains unchanged. During prepare, the
arena resolves the full-commit tag to one registry digest and records both in
`comparison.json`. Every worker pulls by `repository@sha256:digest`, verifies
the local image has that digest, and overrides the entrypoint to run
`node /app/dist/local/index.js`. Workers never resolve the tag independently.

The local driver gains two optional, arena-safe inputs while preserving today's
interactive local behavior:

- `--pr-context <comparison.json>` uses the validated owner/repo/number/title/body
  and requires the checked-out `HEAD` to match its frozen head SHA. It uses the
  frozen base SHA and never loads target comments or checks.
- `--output <result.json>` writes the review-owned fields of the stable,
  one-model result envelope. The worker wrapper adds setup/job/image provenance
  and can synthesize the same envelope when failure occurs before J-Bot starts.
  The existing benchmark-only output environment remains backward compatible
  but is not the arena interface.

```ts
type ArenaResultStatus = "completed" | "skipped" | "failed";
type ArenaFailureClass =
  | "checkout"
  | "image"
  | "credential"
  | "timeout"
  | "provider"
  | "parse"
  | "runner-exit"
  | "signal"
  | "invalid-output"
  | "missing-artifact"
  | "unknown";
type JbotArenaFailureClass = "timeout" | "provider" | "parse" | "unknown";

interface ArenaFindingV1 {
  path: string;
  line: number; // integer >= 0; zero is file-level
  severity: "P0" | "P1" | "P2" | "P3" | "nit";
  kind?: "bug" | "security" | "performance" | "maintainability" |
    "architecture" | "test" | "docs" | "investigate";
  confidence?: "high" | "medium" | "low";
  title: string;
  body: string;
  evidence?: string;
}

interface ArenaUsageMetricV1 {
  value: number | null;
  reportingSessions: number;
}

interface ArenaUsageV1 {
  sessions: number;
  inputTokens: ArenaUsageMetricV1;
  outputTokens: ArenaUsageMetricV1;
  reasoningTokens: ArenaUsageMetricV1;
  cacheReadTokens: ArenaUsageMetricV1;
  cost: {
    usd: number | null;
    source: "provider" | "configured-estimate" | "mixed" | "unavailable";
    reportingSessions: number;
  };
}

interface ArenaResultV1 {
  schemaVersion: 1;
  comparisonId: string;
  modelIndex: number;
  model: string;
  provider: string;
  status: ArenaResultStatus;
  provenance: {
    targetBaseSha: string;
    targetHeadSha: string;
    jbotCommitSha: string;
    imageRef: string;
    imageDigest: string;
    backend: string | null;
    sdkEngine: string | null;
    workflowRunId: number;
    runAttempt: number;
    reviewConfig: ComparisonManifestV1["reviewConfig"];
    resolvedModelOptions: Record<string, unknown> | null;
  };
  timing: {
    reviewMs: number | null;
    workerMs: number;
  };
  usage: ArenaUsageV1;
  review: { summary: string; findings: ArenaFindingV1[] } | null;
  failure: { class: ArenaFailureClass; message: string } | null;
}

interface JbotArenaOutputV1 {
  schemaVersion: 1;
  status: ArenaResultStatus;
  backend: string | null;
  sdkEngine: string | null;
  resolvedModelOptions: Record<string, unknown> | null;
  reviewMs: number | null;
  usage: ArenaUsageV1;
  review: ArenaResultV1["review"];
  failure: { class: JbotArenaFailureClass; message: string } | null;
}
```

`completed` requires `review` and `failure: null`; `skipped` requires both
`review: null` and `failure: null`; `failed` requires `review: null` and a
non-null `failure`. A failure message is credential-scrubbed, newline-collapsed,
and capped at 512 UTF-8 bytes. The publisher synthesizes `missing-artifact`;
workers use the other classes. `backend`, `sdkEngine`, and
`resolvedModelOptions` remain `null` when the run ends before J-Bot resolves
them; null means unavailable, not an implicit default.

The J-Bot process owns `JbotArenaOutputV1`: terminal review status, resolved
backend/options, review-only time, telemetry aggregates, and review content. The
worker wrapper validates that output and constructs `ArenaResultV1` by copying
manifest identity/config/image fields and adding total worker time. For
checkout, image, or credential failures before J-Bot starts, the wrapper emits
zero sessions, null metric values, null resolved backend/options, and its own
classified failure. J-Bot owns only timeout/provider/parse/unknown failures it
catches and serializes. The wrapper owns checkout/image/credential and invalid
output before launch, plus external-watchdog timeout, signal, abrupt
`runner-exit`, and unknown wrapper failures after launch; those states are
synthesized from the child-process outcome because the J-Bot process cannot
serialize them. The publisher alone owns `missing-artifact`.

Each token metric is summed independently across sessions that report it;
`value` is null only when none do. A metric is complete exactly when its
`reportingSessions` equals `sessions`, so partial input reporting cannot be
mistaken for complete output/cache reporting. For each session,
provider-reported cost wins when present; otherwise a configured estimate is
used when available; otherwise that session reports no cost. Aggregate cost
sums those selected per-session values. Its source is `provider` or
`configured-estimate` when all reporting sessions use that source, `mixed` when
both sources contribute, and `unavailable` with `usd: null` only when none
report cost. Completeness is again `reportingSessions === sessions`. Raw
`telemetry.jsonl` is a sibling artifact for deeper analysis but is not part of
the publisher wire contract.

Provider-reported dollar cost is labelled actual, configured inference is
labelled estimated, and absence remains unavailable. Zero must not imply free.

The worker mounts the target checkout at `/workspace:ro`, the manifest at
`/run/jbot-comparison/comparison.json:ro`, and an empty host artifact directory
at `/out:rw`; `/out` is the only writable host mount. It runs the container with
`--workdir /workspace`, `--pr-context /run/jbot-comparison/comparison.json`, and
`--output /out/jbot-output.json`. In arena mode, J-Bot requires an absolute
output path outside the reviewed workspace and writes raw telemetry to the
fixed sibling `/out/telemetry.jsonl`; the wrapper writes the validated merged
`/out/result.json` after the container exits. Interactive local mode keeps its
existing launch-directory `.jbot-review` behavior.

The reviewed repository's `.env`, project OpenCode config, and global operator
config never load. Current session credential scrubbing and read-only permission
layers remain unchanged.

## Workflow and data flow

The arena repository owns `.github/workflows/jbot-compare.yml` on its default
branch. `issue_comment` workflows run trusted default-branch workflow code; the
arena PR head is data only and is never checked out or executed.

The workflow starts with `permissions: {}`. Jobs add only what they use:

- command: narrow PR-comment reaction permission, if the accepted-command
  reaction is enabled;
- prepare and workers: public read/package access only;
- publisher: arena issue-comment write permission; and
- no GitHub token is passed into the review container.

```text
arena /compare comment
        |
        v
command + prepare  -- comparison.json
        |
        v
matrix worker[model]  -- result.json artifact, no posting token
        |
        v
publisher (always)  -- comparison comment + one full comment per model
```

### Command and prepare

- Use least privilege. The command job may react to an accepted comment; it has
  no provider credentials.
- Resolve and validate the target before producing the matrix.
- Emit the frozen `comparison.json`, including resolved configuration and model
  entries in requested order. Model strings never become shell code or paths
  directly.

### Matrix workers

- `strategy.fail-fast: false` so one unavailable free model does not cancel the
  rest.
- One model per worker. The trusted image receives the configured provider auth
  environment and resolves the selected model through J-Bot's normal path.
  Workers receive no GitHub write token.
- Pull the same pinned J-Bot image and review the same frozen target.
- Measure setup/job time separately from J-Bot review time.
- Upload a result artifact even for a classified failure. The requested-model
  manifest lets the publisher represent a missing artifact as a runner loss.

The workflow allows matrix workers within one comparison to run concurrently.
Workflow-level concurrency is keyed to the arena PR with
`cancel-in-progress: false` and `queue: max`: it never cancels an active
comparison and preserves later commands instead of leaving half-published runs.
Parallel free-tier requests may throttle at the provider, so the summary labels
latency as observed under concurrent load.

### Publisher

The publisher runs with `if: always()`, downloads artifacts outside any target
checkout, validates each result against the requested-model manifest, and sorts
by requested model order. It has arena comment permission but no provider
credential.

It posts ordinary PR conversation comments to the arena PR from
`github.event.issue.number`:

1. One comparison comment with target/J-Bot provenance and a table of status,
   review time, total job time, finding counts by severity, token/cache usage,
   and cost provenance.
2. One logical model report containing that model's full summary and every
   finding body. It is normally one comment. Finding locations link to the
   frozen target head SHA. They are not inline review anchors.

Each logical model report normally occupies one comment. The renderer budgets
at most 60 KiB of UTF-8 content including its marker/header. It packs whole
summary/finding blocks first; if one block alone exceeds the budget, it splits
at newline boundaries and finally at a UTF-8-safe byte boundary. Continuations
repeat the model/finding identity, so no summary or finding text is lost. Part
headers preserve model and comparison identity. Complete raw Markdown, JSON,
and telemetry remain downloadable artifacts.

Dedicated markers avoid J-Bot's production review markers:

```text
<!-- jbot-compare:comment=<command-comment-id>:summary -->
<!-- jbot-compare:comment=<command-comment-id>:model=<hash>:part=<n> -->
```

The publisher emits the marker as the exact first line and matches only that
line, so model text cannot impersonate ownership. It paginates every arena PR
conversation comment before publishing. For each desired marker, the lowest-ID
bot-authored match is canonical and is updated in place; any additional
bot-authored matches are duplicates. After all desired comments are upserted,
the publisher deletes duplicate matches and model parts whose part number now
exceeds the rendered part count. A cleanup failure fails the publisher so the
same operation can be retried. It never edits or deletes another author's
comment.

Publishing is therefore idempotent for the command comment: retrying or
rerunning the workflow updates/finishes the same comparison comments without
leaving stale report parts. Workflow run/attempt remain displayed provenance,
not comment identity. A fresh sample requires a new `/compare` command, which
appends a new comparison to arena history.

Artifacts, target metadata, paths, provider errors, and model output are
untrusted data. Only publisher-generated labels, validated enums, and numbers
become Markdown structure. Every untrusted prose field is rendered verbatim
inside an adaptive fenced-code block whose delimiter is longer than any run of
backticks in the field; mentions, issue references, links, HTML, and remote
images are therefore inert. Target file links are publisher-generated from the
validated repository/head SHA plus a percent-encoded relative path and integer
line. The publisher never evaluates artifact text or interpolates it into shell
or workflow syntax. Raw model Markdown remains available only in artifacts.

## Failure behavior

| failure | result |
| --- | --- |
| Invalid command, unauthorized actor, non-public/missing target | Reject before fan-out; no provider use. |
| Target advances after preparation | Finish the frozen comparison and mark it historical. |
| Checkout, merge-base, image, or credential setup fails | Per-model failed row/comment with classified reason. |
| Main review session fails or times out | Model fails; never report partial findings as a completed review. |
| Auxiliary session fails | Existing J-Bot fail-open behavior applies and telemetry discloses it. |
| Review has no reviewable files | Distinct `skipped` status, not success-with-zero-findings or failure. |
| Worker disappears without an artifact | Publisher synthesizes a missing-artifact failure from the manifest. |
| Publisher partially posts | Paginated marker-based retry updates/finishes the same comparison, then removes duplicate and surplus bot-owned parts. |

## Security

- Only trusted default-branch arena workflow code receives secrets.
- Only public target PRs are accepted in v1.
- The command is maintainer-gated and the model count is capped.
- Provider credentials are spend-capped and rotatable. J-Bot selects the
  credential for the requested model and withholds credential-shaped variables
  from model-session children.
- Workers have no arena write credential; the publisher has no provider key.
- Target code is never built, tested, installed, sourced, or used as workflow
  code. The ephemeral container and read-only mount are the mutation boundary;
  J-Bot's shell command filter remains an accident guard, not a sandbox.
- Reviewed-repo OpenCode config and ambient global config remain disabled, and
  credential-shaped environment variables remain withheld from model-session
  children.
- The publisher treats every artifact field as untrusted text.
- Rendered comments neutralize mentions, issue cross-references, raw links,
  HTML, and remote images; only validated publisher-built target links remain
  active.

## Testing

### `jbot-review`

- Build test proves `dist/local/index.js` is emitted and runs without `tsx`.
- Local argument tests cover `--pr-context` and `--output`, including duplicate,
  missing, malformed, and mismatched-head inputs.
- Pure result-envelope tests cover completed, skipped, and classified-failure
  output plus cost provenance. Wrapper tests cover pre-launch failures, caught
  J-Bot failures, external watchdog timeout, signal, and abrupt child exit.
- Existing local-workspace and `review:compare` tests remain green, proving the
  default local path is unchanged.
- Docker smoke test invokes the bundled local entrypoint against a fixture
  checkout and verifies required provider binaries remain available.

### Arena repository

- Command-parser tests cover authorization-independent grammar, exact PR URLs,
  model dedupe/caps, and unsafe characters.
- Target-resolution fixtures cover same-repo and fork PR metadata.
- Publisher tests cover deterministic model order, severity/token tables,
  target-SHA links, whole-finding and oversized-single-block splitting, markers,
  paginated discovery, duplicate/surplus cleanup, retry/rerun updates, failed
  and missing artifacts, and adversarial Markdown/mentions/links/images.
- Workflow lint validates permissions, `fail-fast: false`, `if: always()`, and
  unique artifact names.
- One manual end-to-end smoke comparison uses two configured low-cost/free
  models on a public PR after the workflow is merged to the arena default
  branch. It verifies comments, artifacts, SHA provenance, and that the target
  repo/PR remains untouched.

The implementation changes an opt-in local/arena surface, not the default
review prompt or finding disposition. No formal quality-corpus run is required;
the implementation PR records that skip rationale.

## Rollout

1. Land J-Bot's versioned `JbotArenaOutputV1`, telemetry aggregation, arena
   output-directory contract, and focused tests without changing local defaults.
2. Land frozen PR-context input plus the bundled local image entrypoint, publish
   its full-SHA tag, and verify the registry digest.
3. In the arena repository, land the command parser, target/image resolver, and
   provider-agnostic `ComparisonManifestV1` fixtures.
4. Land the isolated matrix worker, wrapper-owned failure synthesis, artifact
   upload, and fixture-image tests.
5. Land the safe renderer/publisher, pagination/idempotence cleanup, and comment
   tests.
6. Wire the jobs in `jbot-compare.yml`, configure spend-capped credentials and
   the long-lived arena PR, then run the two-model smoke comparison. Verify the
   published image digest, frozen target SHAs, deterministic comments,
   artifacts, and zero target-side mutations.

The arena remains explicitly experimental. Any future move from observational
comparison to model selection requires repetitions plus labelled/adjudicated
quality evidence through the existing corpus rather than expanding this spec.
