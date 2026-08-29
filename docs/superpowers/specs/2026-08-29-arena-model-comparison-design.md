# Arena model comparison — design

Date: 2026-08-29
Status: approved in discussion; awaiting spec review
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
- Post one comparison table plus one complete, flat arena comment per model.
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
- `--models` contains 1–8 unique, fully qualified model IDs using J-Bot's
  existing model-character rules; and
- every provider prefix is configured in the arena's committed provider map.

Unknown flags, prose after the command, malformed targets, unconfigured
providers, duplicate models, and an empty list are rejected before a provider
credential is exposed. A missing or expired credential is a per-model setup
failure, never a fallback to another model.

The command supplies models only. All other review knobs come from the pinned
arena workflow or repository variables and are recorded in the result. V1 uses
one review pass and one repetition per model. A one-element model pool ensures
main and auxiliary sessions use the same model.

## Frozen target contract

The prepare job reads the public target PR through the GitHub API and writes one
validated `target.json` artifact containing:

- canonical PR URL, owner, repository, and PR number;
- title and body;
- base repository, ref, and SHA;
- head repository, ref, and SHA; and
- command comment ID and requested model order.

All matrix workers consume that artifact. They clone the head repository at the
exact head SHA, fetch the base SHA from the base repository, and fetch enough
history to compute their merge base. This supports fork PRs and prevents a push
during the run from giving different models different diffs.

Before review, each worker verifies:

- `HEAD` equals `target.json.headSha`;
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

The image's default app-server entrypoint remains unchanged. Arena workers pull
an image tagged with the full J-Bot commit SHA, record the resolved image digest,
and override the entrypoint to run `node /app/dist/local/index.js`.

The local driver gains two optional, arena-safe inputs while preserving today's
interactive local behavior:

- `--pr-context <target.json>` uses the validated owner/repo/number/title/body
  and requires the checked-out `HEAD` to match its frozen head SHA. It uses the
  frozen base SHA and never loads target comments or checks.
- `--output <result.json>` writes a stable, one-model result envelope. The
  existing benchmark-only output environment remains backward compatible but
  is not the arena interface.

The result envelope contains:

- schema version and terminal status (`completed`, `skipped`, or `failed`);
- target identity and frozen SHAs;
- J-Bot commit/image digest, model, resolved provider/options, and review knobs;
- review-only elapsed time;
- summary and every final retained finding, including complete bodies;
- session/token/cache telemetry and cost when supplied by the backend; and
- a bounded failure class/message when review did not complete.

Provider-reported dollar cost is labelled actual, configured inference is
labelled estimated, and absence remains unavailable. Zero must not imply free.

The target checkout is mounted read-only; the result directory is the only
writable mount. The reviewed repository's `.env`, project OpenCode config, and
global operator config never load. Current session credential scrubbing and
read-only permission layers remain unchanged.

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
command + prepare  -- target.json + requested model manifest
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
- Emit model entries in requested order with a stable index and sanitized
  artifact name. Model strings never become shell code or paths directly.

### Matrix workers

- `strategy.fail-fast: false` so one unavailable free model does not cancel the
  rest.
- One model and one provider credential per worker. Workers receive no GitHub
  write token.
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
2. One model comment containing that model's full summary and every finding
   body. Finding locations link to the frozen target head SHA. They are not
   inline review anchors.

GitHub body limits are handled by splitting a model report only on whole-finding
boundaries. Part headers preserve model and run identity. The complete Markdown
and JSON remain downloadable artifacts even when a report is split.

Dedicated markers avoid J-Bot's production review markers:

```text
<!-- jbot-compare:run=<run-id>:attempt=<n>:summary -->
<!-- jbot-compare:run=<run-id>:attempt=<n>:model=<hash>:part=<n> -->
```

Publishing is idempotent within one run attempt: retrying the publisher updates
matching marker comments instead of duplicating them. A workflow rerun is a new
attempt/sample, and a new `/compare` comment is a new comparison; both append to
arena history.

Artifacts and model output are untrusted data. The publisher parses the JSON
schema and calls the GitHub API directly; it never evaluates result text or
interpolates it into shell or workflow syntax.

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
| Publisher partially posts | Marker-based retry updates/finishes the same attempt. |

## Security

- Only trusted default-branch arena workflow code receives secrets.
- Only public target PRs are accepted in v1.
- The command is maintainer-gated and the model count is capped.
- Provider credentials are spend-capped and rotatable. Only the selected
  provider credential enters each worker.
- The committed provider map includes only officially supported automation
  routes whose service terms permit this use; a model being open source,
  catalogued, or advertised as free is not sufficient authorization.
- Workers have no arena write credential; the publisher has no provider key.
- Target code is never built, tested, installed, sourced, or used as workflow
  code. The ephemeral container and read-only mount are the mutation boundary;
  J-Bot's shell command filter remains an accident guard, not a sandbox.
- Reviewed-repo OpenCode config and ambient global config remain disabled, and
  credential-shaped environment variables remain withheld from model-session
  children.
- The publisher treats every artifact field as untrusted text.

## Testing

### `jbot-review`

- Build test proves `dist/local/index.js` is emitted and runs without `tsx`.
- Local argument tests cover `--pr-context` and `--output`, including duplicate,
  missing, malformed, and mismatched-head inputs.
- Pure result-envelope tests cover completed, skipped, and classified-failure
  output plus cost provenance.
- Existing local-workspace and `review:compare` tests remain green, proving the
  default local path is unchanged.
- Docker smoke test invokes the bundled local entrypoint against a fixture
  checkout and verifies required provider binaries remain available.

### Arena repository

- Command-parser tests cover authorization-independent grammar, exact PR URLs,
  model dedupe/caps, and unsafe characters.
- Target-resolution fixtures cover same-repo and fork PR metadata.
- Publisher tests cover deterministic model order, severity/token tables,
  target-SHA links, whole-finding splitting, markers, retry updates, failed and
  missing artifacts, and untrusted Markdown text.
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

1. Land the J-Bot image contract: bundled local entrypoint, frozen PR context,
   structured output, tests, and a full-SHA image tag.
2. Create/configure the dedicated arena repository with provider mapping,
   spend-capped credentials, the workflow, parser/publisher tests, and one
   long-lived arena PR.
3. Run the two-model smoke comparison and verify the published image digest,
   frozen target SHAs, deterministic comments, artifacts, and zero target-side
   mutations.

The arena remains explicitly experimental. Any future move from observational
comparison to model selection requires repetitions plus labelled/adjudicated
quality evidence through the existing corpus rather than expanding this spec.
