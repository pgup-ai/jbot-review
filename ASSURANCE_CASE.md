# jbot-review — security assurance case

What this document is: the threats we designed against, the mitigations in
code (with pointers), and the residual risks we accept knowingly. It is a
claims-with-evidence document, not a certification. The enforcement invariants
behind it live in `AGENTS.md` (invariants 2, 8, 11) and are exercised by the
test suite.

## System and trust model

jbot-review runs LLM "review sessions" over a checked-out pull-request
workspace and posts diff-anchored review comments. Three entry points share
one pipeline: the GitHub Action (`src/workflow/`), the webhook App
(`src/app/`), and local dry-run (`src/local/`).

Assets: provider API credentials, GitHub tokens, the reviewed source tree,
and the integrity of what gets posted to the PR.

Untrusted inputs: the PR's diff and metadata (author-controlled), model
output (treated as data, never as instructions to the pipeline), and — in the
remote-ACP topology — the network between gateway and companion.

## Threats and mitigations

### T1 — A model session mutates the reviewed workspace

Read-only is enforced in three independent layers for every opencode session
(AGENTS.md invariant 8): the `plan` agent, config-level
`permission.edit/external_directory: deny` (`src/shared/opencode.ts`), and
per-prompt `tools: { write/edit/patch: false }`. The pi SDK engine exposes a
no-shell toolset with a read-only `git_diff` tool (`src/shared/pi.ts`), and
ACP CLI sessions run behind `@symma/protocol`'s client-side permission floor,
which rejects mutating tool kinds regardless of what the agent requests.

### T2 — A model session abuses bash

Bash stays available to opencode sessions for `git diff`/`log`/`grep`. The
bash pattern denylist (git commit/push/checkout/reset/clean, `rm`, …) is an
ACCIDENT filter that mitigates common model-driven git mutations and is
documented in-code as "NOT a security boundary" (`src/shared/opencode.ts`) —
it is not a shell-write guarantee. The boundary is the blast radius: sessions
run in a throwaway CI checkout or, in local mode, an isolated worktree —
never the operator's live tree — and workspace writes through the session's
own tools are denied by T1's permission layers.

### T3 — Prompt injection via PR content steers the posted review

Model output enters through a strict JSON contract with schema validation
(`src/shared/opencode.ts`), and every trust decision — confidence gating,
dedupe, prior-thread suppression, verdict application, severity filtering —
is enforced in code, not prompts (`src/shared/filter.ts`, AGENTS.md
invariant 2). Inline anchors are validated against the exact GitHub
merge-base patch (`src/shared/patch.ts`), so a finding cannot be steered to
annotate code outside the diff. Prior-run recognition uses hidden markers
(`src/shared/github.ts`), never text claims.

### T4 — Fork PRs executing with privileges

The dogfood workflow refuses `/jbot` comment-triggered runs on fork-head PRs
because it builds the reviewer from the checked-out head
(`.github/workflows/jbot-review.yml`). For consumers of the published Action,
this claim is scoped to the supported `pull_request`-event path with GitHub's
default read-only fork-PR token: the caller's workflow controls the actual
permissions, and invoking the action from `pull_request_target` or with
widened `permissions` grants is outside this assurance.

### T5 — Credential or content leakage through telemetry

This assurance is scoped to the persisted telemetry JSONL: run/coverage rows
store typed failure classes only — raw error text (which can embed URLs,
tokens, or key material) is classified and discarded before anything is
persisted (`src/shared/telemetry.ts`). Finding rows carry paths, line
numbers, severities, and boolean flags — no finding titles or bodies, and no
prompt or response content. Process LOGS are a separate surface: they may
echo raw provider error messages, and their retention is governed by the
hosting CI/runtime, not by this repository.

### T6 — Compromised gateway or companion (remote ACP topology)

Compromise means shutdown, not mitigation (AGENTS.md invariant 11): a
compromised peer is shut down and its tokens rotated; runtime components do
not attempt to keep operating across it. In-band integrity machinery attests
only downward in the trust chain — a viewer served by the gateway can never
audit the gateway. The post-incident audit path is offline:
`scripts/verify-journal.ts` over copied journals with companion-sourced keys.

### T7 — Forged shard-cache entries

Cached shard results are review output a run will trust without a model
session, so the cache must never be readable from author-controlled paths: it
is OFF by default and activates only when an operator configures a directory
(`shardCachePath` / `JBOT_SHARD_CACHE_DIR`) that must live outside the
reviewed checkout (`src/shared/runner.ts`). Entries are content-addressed
over the shard's full prompt payload (head SHA, model, assembled context,
guidelines, prompt options) and shape-validated on read
(`src/shared/shard-cache.ts`); an unrecognized entry is a cache miss.

### T8 — Supply chain

Dependencies are deliberately minimal ("no new dependencies without clear
need", AGENTS.md) and pinned by `package-lock.json` (`npm ci`). The shipped
image is built in CI from the repository source (`.github/workflows/build.yml`
rebuilds `dist/` before the Docker `COPY`), not from artifacts checked into
the repo.

## Residual risks (accepted, documented)

- The bash denylist is advisory (see T2); enforcement rests on workspace
  isolation and the write-deny layers, not on command filtering.
- Read-only enforcement for opencode sessions relies on opencode honoring its
  own permission config; the three layers exist so a regression in one is
  caught by another, but all three live in the same process.
- Telemetry JSONL includes file paths and line numbers — code metadata a repo
  owner already shares with their provider by requesting review, but not
  scrubbed further.
- Release artifacts are not signed; consumers pin the image by registry tag.

## Reporting

Report vulnerabilities via GitHub private vulnerability reporting on this
repository rather than public issues.
