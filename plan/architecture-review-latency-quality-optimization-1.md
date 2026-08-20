---
goal: Make J-Bot the highest-quality, lowest-latency AI code reviewer when compared on the same LLM model
version: 1.0
date_created: 2026-08-19
last_updated: 2026-08-19
owner: J-Bot maintainers
status: 'Planned'
tags: [architecture, performance, latency, quality, evaluation, agentic-review, inference]
---

# Introduction

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

This plan defines an evidence-gated optimization program for J-Bot's complete review path: context assembly, embedded diff handling, repository exploration, sharding, auxiliary sessions, verification, caching, structured output, provider execution, CI packaging, and optional self-hosted inference. The objective is to improve quality-adjusted speed on the same model, not to obtain misleading latency wins by changing models, narrowing the reviewed diff, suppressing difficult findings, or weakening verification.

The repository already has several useful foundations: full-diff sharding, a cache-stable prompt prefix, provider prompt-cache controls, exact-content same-head shard reuse, dynamic auxiliary fan-out, finding-level disposition telemetry, evidence quotes, verifier priority, npm caching, a context-trimming A/B arm, and a deterministic exported-symbol blast-radius manifest. This plan extends and measures those mechanisms before introducing additional complexity.

Live incident case `INC-001` anchors the large-diff failure work: integral-xyz/fms PR #3563 at head `be6a37bd83004deef3a777f59b8fccd3e21e1b5f` contained 41 files, 1,280 additions, 332 deletions, and 160,489 GitHub patch characters. Depot workflow `4trvzg549n`, job `r2cp9c819t`, resolved `review-shards=1`, selected the tool-less `commandcode/deepseek/deepseek-v4-flash` main backend, assembled 216,850 bytes of context against the 81,920-byte soft cap, and delivered a 233,342-character prompt. The first attempt ended with CommandCode exit 7 (`The API server encountered an error`) after consuming approximately 20 minutes of the run window; the same model/backend/prompt retried with 588 seconds remaining and hit J-Bot's internal retry timeout. The PR had merged at 21:26:31Z, and remaining-budget arithmetic places retry startup after the merge, making the final retry avoidable with pre-retry PR-state validation. The action then correctly refused to post one auxiliary-lens finding without successful main-shard coverage. This was not a demonstrated tool-turn-ceiling failure: CommandCode skills and tools were disabled, no max-turn error appeared, and J-Bot—not Depot's job timeout—returned exit 1 under its 30-minute budget.

Priority and impact notation used below:

- **P0**: prerequisite or correctness protection; complete before latency policy changes.
- **P1**: expected high impact on quality-adjusted latency or critical-path duration.
- **P2**: useful optimization whose value depends on measurement or backend support.
- **P3**: research track; do not put on the default path without a successful experiment.
- **Latency H/M/L**: expected wall-clock effect on applicable runs.
- **Quality +/0/-**: expected positive, neutral, or potentially negative review-quality effect.
- **Effort S/M/L/XL**: relative implementation and validation effort.

Program-level targets:

- Reduce median end-to-end review time by at least 30% and p95 by at least 20% on the fixed-model benchmark before self-hosted inference work is required.
- Reduce duplicate diff reads and equivalent repeated searches by at least 80% on tool-capable backends.
- Preserve 100% seeded P0/P1 recall and remain within 2 percentage points of baseline severity-weighted recall and precision for P2 findings.
- Keep full-diff coverage, anchoring validity, read-only enforcement, prior-thread behavior, and auxiliary fail-open behavior unchanged.
- Report results separately by backend, model, reasoning level, change-risk tier, diff-size bucket, first review versus re-review, and cache state.

## 1. Requirements & Constraints

- **REQ-001**: Every run must cover the complete merge-base-relative base...head diff, either in one session or as the union of shards; optimization must never introduce delta-only review scope.
- **REQ-002**: A benchmark comparison must hold the main model identifier, model revision when knowable, reasoning configuration, temperature/sampling configuration, prompt contract, PR corpus, and finding acceptance rules constant unless the tested variable explicitly changes one of them.
- **REQ-003**: The primary objective function must be quality-adjusted latency, reported as wall-clock time and provider cost per retained valid finding, with clean-review latency reported separately.
- **REQ-004**: Every optimization must have a control arm, treatment arm, predefined success threshold, rollback rule, and enough telemetry to explain the observed change.
- **REQ-005**: Tool-driven recovery of truncated or omitted diff hunks must remain available even when ordinary adjacent-repository exploration is budgeted.
- **REQ-006**: Repository exploration must be tied to changed code, a concrete review hypothesis, a candidate finding, or recovery of missing diff coverage.
- **REQ-007**: Turn count must not be used as the sole exploration budget because backend turn semantics differ and tool-less backends can consume turns without repository exploration.
- **REQ-008**: All prompt fragments, deterministic retrieval blocks, tool outputs, and persisted telemetry records must have explicit byte or count bounds.
- **REQ-009**: Main-shard failure must remain fatal after the existing retry/cache paths because partial main coverage violates the full-diff invariant.
- **REQ-010**: Lens, guideline, addressed-comment, change-summary, and verification failures must remain fail-open and must not remove findings solely because an auxiliary mechanism failed.
- **REQ-011**: Only changed code may receive inline findings; file-level and line-zero behavior must continue through the existing filter and anchoring pipeline.
- **REQ-012**: Resolved prior threads must never suppress a re-detected regression.
- **REQ-013**: Every backend must preserve its existing three-layer or backend-equivalent read-only safety floor; latency work must not enable write, edit, patch, unsafe shell, external-directory, subagent, network, or repository-provided customization surfaces.
- **REQ-014**: Prompt assembly order must remain base instructions, guidelines, PR context, optional lens, evidence instruction when enabled, and output reminder last.
- **REQ-015**: Trust-boundary decisions such as severity filtering, confidence gating, deduplication, prior-thread suppression, exploration accounting, and hard budget enforcement must live in code rather than prompt text alone.
- **REQ-016**: `src/shared/runner.ts` must remain orchestration-only; new scoring, policy, budgeting, accounting, and scheduling decisions must be pure modules with focused unit tests.
- **REQ-017**: New persistent caches must live outside the reviewed checkout, must be content-addressed, must be safe against PR-controlled cache poisoning, and must fail open on read/write errors.
- **REQ-018**: Telemetry must never persist raw provider errors, secrets, repository source, tool output contents, PR prose, or human reply text; persist only bounded metadata, hashes, classifications, counts, durations, and byte sizes.
- **REQ-019**: A self-hosted runtime may be called the same-model comparison only when it uses the same published weights and materially equivalent precision, context, tokenizer, sampling, and reasoning configuration; quantized or distilled variants require a separate comparison label.
- **REQ-020**: No new dependency may be added until a standard-library, git, or existing-SDK implementation has been attempted and documented as insufficient.
- **PER-001**: Record end-to-end, context assembly, queue, prefill/TTFT when exposed, decode, tool execution, JSON repair, auxiliary grace, verification, posting, teardown, and CI setup durations separately.
- **PER-002**: Record prompt bytes, estimated prompt tokens when available, input/output/reasoning/cache tokens, cache writes/reads, tool calls, tool-output bytes, unique files, unique searches, duplicate reads, repeated searches, turns, retries, repairs, and cancellations per session.
- **PER-003**: Assign each session one risk tier and one exploration mode so benchmark results can distinguish fully embedded review from omitted-hunk recovery.
- **QLT-001**: The quality suite must include seeded defects, historical accepted findings, historical rejected/noise findings, clean diffs, cross-file contract breaks, security/data/concurrency changes, frontend workflows, infrastructure changes, tests, docs, generated/noise files, large single files, and broad multi-package diffs.
- **QLT-002**: Score severity-weighted recall, precision, false-positive rate on clean changes, duplicate rate, actionable-trigger completeness, anchor success, evidence support, and human disposition outcomes.
- **QLT-003**: Any treatment that misses one seeded P0/P1 defect must fail regardless of its latency improvement.
- **QLT-004**: Any treatment with more than a 2 percentage-point precision or severity-weighted-recall regression must remain experimental unless a larger adjudicated sample demonstrates non-inferiority.
- **CON-001**: Provider APIs may hide server-side TTFT, cache, batching, and speculative-decoding details; unavailable metrics must be marked unavailable rather than inferred.
- **CON-002**: Some CLI/ACP backends do not expose interceptable per-tool hooks; enforcement may therefore vary by backend, but the policy and telemetry schema must remain common.
- **CON-003**: Free or throttled providers may serialize concurrent requests upstream; shard-count decisions must use measured concurrency benefit rather than assuming parallel execution.
- **CON-004**: Current `COMMANDCODE_MAX_TURNS=1000` and `GROK_MAX_TURNS=1000` are compatibility ceilings, not latency budgets; do not lower them as part of exploration optimization because those routes are tool-less.
- **CON-005**: SGLang runtime features such as RadixAttention, cache-aware routing, continuous batching, speculative decoding, and prefill/decode disaggregation apply only to self-hosted or controlled inference, not arbitrary third-party APIs.
- **GUD-001**: Ship the smallest reversible experiment first; graduate behavior only from benchmark evidence.
- **GUD-002**: Prefer deterministic preprocessing and cacheable retrieval over spending model turns rediscovering information already available to the runner.
- **GUD-003**: Prefer byte, path, and tool-output budgets over arbitrary global turn limits; use a soft finish signal before an absolute timeout.
- **GUD-004**: Report median, p90, p95, maximum, confidence intervals, sample size, cache state, and failure/cancellation counts; never report only a mean.
- **GUD-005**: Separate application-level wins available to every provider from inference-runtime wins available only under self-hosting.
- **PAT-001**: Reuse `createTelemetryRecorder` and add typed row kinds rather than creating an unrelated telemetry sink.
- **PAT-002**: Reuse `buildBlastRadiusBlock` and its best-effort/fail-open pattern for deterministic adjacent-context retrieval.
- **PAT-003**: Reuse `shardFilesForReview` full-union behavior and exact-content cache fingerprinting; evolve the cost function without weakening coverage.
- **PAT-004**: Reuse the existing `SINGLE_SHOT_TOOLS` pattern when a task can be completed entirely from embedded context.
- **PAT-005**: Put all new model-facing instructions in `src/shared/prompt.ts` and assert only load-bearing structure and phrases in `test/prompt.test.ts`.

## 2. Implementation Steps

### Implementation Phase 0 — Freeze the benchmark contract and current baseline

- GOAL-001: Establish a reproducible baseline and decision framework before modifying exploration or scheduling behavior.

| Task     | Priority / Impact / Effort    | Description                                                                                                                                                                                                                                                                                                                | Dependencies                 | Completed | Date |
| -------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | --------- | ---- |
| TASK-001 | P0 / Latency 0, Quality + / S | Add `docs/superpowers/specs/2026-08-19-review-speed-quality-scorecard.md`. Define the fixed-model comparison contract, metric formulas, risk buckets, cache-state labels, treatment naming, non-inferiority thresholds from QLT-003/004, and the exact rule that a model/reasoning/config change is a separate experiment. | None                         |           |      |
| TASK-002 | P0 / Latency 0, Quality + / M | Create `scripts/review-benchmark.ts` and an `npm run benchmark:review` script. The runner must accept a manifest, run control and treatment with isolated temp homes/worktrees, capture exit status and telemetry, and write one JSON summary plus per-case JSONL without posting to GitHub.                               | TASK-001                     |           |      |
| TASK-003 | P0 / Latency 0, Quality + / M | Create `test/fixtures/review-benchmark/manifest.json` with schema version, case id, repository/ref or fixture path, base/head identifiers, risk tier, expected findings, expected-clean flag, and allowed alternative anchors. Keep secrets and proprietary source out of committed fixtures.                              | TASK-001                     |           |      |
| TASK-004 | P0 / Latency 0, Quality + / M | Add a deterministic scorer in `src/shared/benchmark-score.ts` with tests in `test/benchmark-score.test.ts`. Compute severity-weighted recall, precision, clean false-positive rate, anchor rate, duplicate rate, median/p90/p95 latency, cost per retained finding, and bootstrap confidence intervals using a fixed seed. | TASK-001                     |           |      |
| TASK-005 | P0 / Latency 0, Quality + / S | Record the current main-branch baseline for at least 30 representative cases and at least three repetitions for stochastic provider runs. Store only summarized results under `docs/superpowers/benchmarks/`; store raw proprietary artifacts outside git and record their content hashes.                                 | TASK-002, TASK-003, TASK-004 |           |      |
| TASK-006 | P0 / Latency 0, Quality + / S | Add a benchmark comparability check that rejects a comparison when model, revision, engine, reasoning effort, sampling options, prompt version, or corpus hash differs outside the declared treatment variable.                                                                                                            | TASK-002                     |           |      |
| TASK-007 | P1 / Latency M, Quality 0 / S | Re-measure the current dogfood and consumer critical paths using successful, uncached first reviews, cached same-head re-reviews, and cancellation chains. Update `docs/superpowers/audits/2026-08-06-wall-clock-latency-audit.md` with a dated appendix instead of overwriting its historical measurements.               | TASK-005                     |           |      |
| TASK-008 | P0 / Latency 0, Quality + / S | Add a plan gate: no default behavior change from later phases may merge without a benchmark report that references the treatment commit, corpus hash, model/config tuple, sample size, quality result, latency result, and rollback flag. Document the gate in the scorecard.                                              | TASK-001                     |           |      |

Completion criteria for Phase 0:

- The same command can reproduce a control/treatment comparison from a manifest.
- A deliberately mismatched model or reasoning configuration is rejected as incomparable.
- The baseline report includes every program-level metric and separates first-run, re-review, cache-hit, backend, risk, and diff-size cohorts.

### Implementation Phase 1 — Add phase, turn, and tool observability

- GOAL-002: Explain where every material second and token is spent before enforcing exploration limits.

| Task     | Priority / Impact / Effort    | Description                                                                                                                                                                                                                                                                                                                                              | Dependencies              | Completed | Date       |
| -------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | --------- | ---------- |
| TASK-009 | P0 / Latency 0, Quality + / M | Extend `src/shared/telemetry.ts` with `PhaseTelemetryRow`, `ToolTelemetryRow`, and `ExplorationTelemetryRow`. Include session, backend, phase/tool class, duration, input/output byte counts, unique-path/query hash counts, duplicate flag, turn count when exposed, exploration mode, budget tier, and stop reason. Persist no source or command text. | TASK-001                  | Yes       | 2026-08-19 |
| TASK-010 | P0 / Latency 0, Quality + / S | Add `src/shared/tool-telemetry.ts` as a pure bounded accumulator. Normalize tool classes to `diff-recovery`, `file-read`, `search`, `list`, `external-docs`, and `other-readonly`; derive duplicate reads and equivalent repeated searches from salted per-run hashes.                                                                                   | TASK-009                  | Yes       | 2026-08-19 |
| TASK-011 | P0 / Latency 0, Quality + / S | Instrument `src/shared/runner.ts` phase boundaries for context assembly, main queue, main execution, auxiliary queue/execution, grace wait, filtering, verification, posting, and teardown. Route all writes through `TelemetryRecorder`; keep failure reporting generic.                                                                                | TASK-009                  | Yes       | 2026-08-19 |
| TASK-012 | P1 / Latency 0, Quality + / M | Instrument custom Pi tools in `src/shared/pi.ts` at execution boundaries. Record requested tool class, success/failure class, output bytes before/after cap, duration, duplicate status, and whether `git_diff` was whole-diff or path-scoped.                                                                                                           | TASK-010                  | Yes       | 2026-08-19 |
| TASK-013 | P1 / Latency 0, Quality + / M | Inspect OpenCode session events in `src/shared/opencode.ts` and record tool start/end events when the installed SDK exposes them. If individual calls are unavailable, record session-level tool-message counts and mark enforcement capability `observe-only`. Add SDK-contract tests using fixtures, not a live provider.                              | TASK-010                  | Yes       | 2026-08-19 |
| TASK-014 | P1 / Latency 0, Quality + / M | Extend `src/shared/qoder.ts` to persist `result.num_turns` and any SDK-exposed tool events into the common schema. Do not set `maxTurns` in this task.                                                                                                                                                                                                   | TASK-009                  | Yes       | 2026-08-19 |
| TASK-015 | P1 / Latency 0, Quality + / M | Parse bounded tool/turn metadata from `src/shared/dim.ts` event streams when present. Record `unavailable` explicitly when dimcode does not emit the required event instead of estimating it from token counts.                                                                                                                                          | TASK-009                  | Yes       | 2026-08-19 |
| TASK-016 | P1 / Latency 0, Quality + / L | Add capability adapters for ACP-backed routes in `src/shared/acp.ts` and `src/shared/acp-remote.ts`. Record tool events already visible through protocol frames; classify backends as `enforceable`, `observable`, or `opaque`. Preserve protocol read-only permissions.                                                                                 | TASK-010                  | Yes       | 2026-08-19 |
| TASK-017 | P2 / Latency 0, Quality + / M | Add best-effort turn and phase accounting for the remaining CLI backends in `src/shared/commandcode.ts`, `src/shared/grok.ts`, `src/shared/cline.ts`, `src/shared/devin-cli.ts`, and `src/shared/poolside.ts`. Do not infer tool calls for routes whose tools are disabled.                                                                              | TASK-009                  | Yes       | 2026-08-19 |
| TASK-018 | P0 / Latency 0, Quality + / M | Add telemetry tests in `test/telemetry.test.ts`, `test/pi.test.ts`, `test/opencode.test.ts`, `test/qoder.test.ts`, `test/dim.test.ts`, and `test/acp-backend.test.ts`. Assert bounded records, no raw source/query/error persistence, duplicate detection, missing-metric handling, and complete terminal phase rows on success/failure/timeout.         | TASK-009 through TASK-017 | Yes       | 2026-08-19 |
| TASK-019 | P1 / Latency L, Quality + / S | Extend `scripts/finding-dispositions.ts` or add `scripts/review-performance.ts` to aggregate p50/p90/p95 phase time, tool bytes, duplicate-read rate, turn count, cache use, retry/repair rate, and retained findings by cohort. Refuse rate claims below the documented minimum sample.                                                                 | TASK-009                  | Yes       | 2026-08-19 |

Completion criteria for Phase 1:

- At least Pi, OpenCode, Qoder, dim, and ACP routes have an explicit capability classification.
- A run's total measured phases reconcile to within 5% or 2 seconds of action elapsed time, whichever is larger.
- Telemetry can quantify the fraction of tool calls and bytes that reproduced already embedded diff content.

### Implementation Phase 2 — Build the quality corpus and adjudication loop

- GOAL-003: Make latency experiments safe by detecting subtle recall and precision regressions.

| Task     | Priority / Impact / Effort    | Description                                                                                                                                                                                                                                                                                      | Dependencies       | Completed | Date       |
| -------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------ | --------- | ---------- |
| TASK-020 | P0 / Latency 0, Quality + / L | Build an initial corpus of at least 100 cases across small/medium/large/very-large diffs and all QLT-001 categories. Use synthetic or redistributable fixtures in git; reference private cases by immutable external hash in the local manifest.                                                 | TASK-003           | Yes       | 2026-08-19 |
| TASK-021 | P0 / Latency 0, Quality + / M | Seed each defect case with exact trigger, expected severity range, valid file/line alternatives, required cross-file evidence, and disallowed false-positive interpretations. Keep multiple acceptable findings where wording can differ.                                                        | TASK-020           | Yes       | 2026-08-19 |
| TASK-022 | P0 / Latency 0, Quality + / M | Add clean counterfactuals by fixing each seeded defect while preserving surrounding diff size and style. Use them to distinguish true recall from generic suspiciousness.                                                                                                                        | TASK-020           | Yes       | 2026-08-19 |
| TASK-023 | P1 / Latency 0, Quality + / M | Import historical J-Bot findings with clear human outcomes from existing telemetry: addressed/resolved/positive reaction as positive candidates, negative/confused reaction as negative candidates, and neutral replies as adjudication-required. Never infer valence from reply presence alone. | TASK-020           | Yes       | 2026-08-19 |
| TASK-024 | P1 / Latency 0, Quality + / M | Add blind adjudication files that omit treatment identity. Require two independent labels for ambiguous cases and record disagreement separately; do not tune prompts to individual benchmark wording.                                                                                           | TASK-021, TASK-023 | Yes       | 2026-08-19 |
| TASK-025 | P1 / Latency 0, Quality + / S | Define release subsets: `smoke` for every PR, `core` for optimization branches, and `full` for default-policy changes. The full subset must contain every P0/P1 case and all large-diff/tool-exploration cases.                                                                                  | TASK-020           | Yes       | 2026-08-19 |
| TASK-026 | P1 / Latency 0, Quality + / M | Add variance characterization: run the unchanged control three to five times on a stochastic provider and calculate natural finding and latency variance. Use this to prevent treating ordinary randomness as an optimization effect.                                                            | TASK-002, TASK-020 | Yes       | 2026-08-19 |
| TASK-027 | P2 / Latency 0, Quality + / M | Add competitor adapters that normalize findings from other tools into the benchmark schema without changing their prompts or postprocessing. Compare only adapters configured to the identical model endpoint and reasoning settings.                                                            | TASK-004, TASK-020 | Yes       | 2026-08-19 |

Completion criteria for Phase 2:

- Every default-policy experiment can be scored against both defect and clean counterfactual cases.
- The suite catches a deliberately removed cross-file caller check and a deliberately injected generic false positive.
- Competitor results, if used, disclose model/config mismatches and are excluded from same-model rankings when mismatched.

### Implementation Phase 3 — Make the prompt embedded-first and coverage-aware

- GOAL-004: Stop paying to rediscover embedded diff content while preserving necessary adjacent-code review.

| Task     | Priority / Impact / Effort    | Description                                                                                                                                                                                                                                                                                                                               | Dependencies                 | Completed           | Date       |
| -------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ------------------- | ---------- |
| TASK-028 | P1 / Latency H, Quality + / S | Update `REVIEW_PROMPT` in `src/shared/prompt.ts` so fully embedded hunks are authoritative and already read. Explicitly prohibit rerunning `git diff` or rereading changed code solely to reproduce embedded content.                                                                                                                     | TASK-005, TASK-009           | Yes                 | 2026-08-20 |
| TASK-029 | P1 / Latency H, Quality + / S | Add one canonical repository-exploration policy in `src/shared/prompt.ts`: tools are for omitted/truncated hunk recovery, direct caller/callee/contract/test checks tied to a changed symbol, or evidence confirmation for a candidate finding. Remove or reconcile wording that describes all embedded hunks as merely a starting point. | TASK-028                     | Yes                 | 2026-08-20 |
| TASK-030 | P1 / Latency M, Quality + / S | Add a stop condition: after all changed hunks are covered and material uncertainties are resolved, produce the final JSON rather than exploring for completeness alone. Require one dependency hop by default and a concrete trigger before expanding farther.                                                                            | TASK-029                     | Yes                 | 2026-08-20 |
| TASK-031 | P1 / Latency M, Quality + / S | Update `PI_REVIEW_SYSTEM_PROMPT` so `git_diff` is used only for omitted/truncated coverage recovery, not automatically whenever later instructions mention diff inspection. Keep path-scoped diff retrieval as the preferred recovery form.                                                                                               | TASK-029                     | Yes                 | 2026-08-20 |
| TASK-032 | P1 / Latency M, Quality + / S | Preserve `NO_TOOLS_REVIEW_DIRECTIVE` behavior byte-for-byte for tool-less backends except for changes required to prevent contradictory instructions. Add a regression snapshot proving tool-less routes still review only embedded context.                                                                                              | TASK-029                     | Yes                 | 2026-08-20 |
| TASK-033 | P1 / Latency M, Quality + / S | Require the model to consult the existing `Changed symbol usage` manifest before issuing a broad search. Permit a broader search only when the manifest is absent, explicitly incomplete, or evidence identifies a missing relation.                                                                                                      | TASK-029                     | Yes                 | 2026-08-20 |
| TASK-034 | P0 / Latency 0, Quality + / S | Extend `test/prompt.test.ts` with structural assertions for authoritative embedded hunks, recovery exceptions, one-hop adjacency, concrete-hypothesis tool use, stop condition, output-reminder-last order, and no duplicate rule statements.                                                                                             | TASK-028 through TASK-033    | Yes                 | 2026-08-20 |
| TASK-035 | P1 / Latency H, Quality 0 / S | Run a prompt-only A/B with all code-side enforcement disabled. Graduate the prompt change only if duplicate diff-read bytes fall at least 50%, p50 main-session latency improves at least 10%, and QLT-003/004 pass.                                                                                                                      | TASK-034, TASK-019, TASK-025 | Yes (not graduated) | 2026-08-20 |

Completion criteria for Phase 3:

**Phase status:** Experimental; the treatment did not pass TASK-035's
graduation gates. See
`plan/review-prompt-embedded-first-phase3-ab.md`.

- The prompt states exactly one exploration policy and does not simultaneously require redundant diff rereads.
- Tool-less backends remain functional and read-only.
- The prompt-only arm passes the predefined quality gates before any hard budget is introduced.

### Implementation Phase 4 — Add enforceable exploration budgets and soft stopping

- GOAL-005: Bound model-controlled repository work using risk- and coverage-aware resource budgets rather than a blunt global turn cap.

| Task     | Priority / Impact / Effort    | Description                                                                                                                                                                                                                                                                                                                                | Dependencies              | Completed | Date |
| -------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------- | --------- | ---- |
| TASK-036 | P0 / Latency M, Quality + / M | Add pure `src/shared/exploration-policy.ts` and `test/exploration-policy.test.ts`. Define `ExplorationMode` (`embedded`, `coverage-recovery`, `single-shot`), `ExplorationTier` (`minimal`, `standard`, `elevated`), and limits for ordinary calls, tool-output bytes, unique adjacent files, repeat reads/searches, and dependency depth. | TASK-009, TASK-035        |           |      |
| TASK-037 | P1 / Latency H, Quality 0 / S | Set initial experimental defaults: minimal = 4 ordinary calls/64 KiB/3 adjacent files; standard = 8/128 KiB/6; elevated = 16/256 KiB/12. Treat these as A/B constants, not public configuration, until Phase 4 graduation.                                                                                                                 | TASK-036                  |           |      |
| TASK-038 | P0 / Latency 0, Quality + / M | Carry `DiffHunksBlockResult.truncatedFiles` and `omittedFiles` into each `ShardPlan`. Enter `coverage-recovery` when either list is non-empty; otherwise enter `embedded`. Add a pure assertion that every omitted/truncated reviewable file has a permitted recovery path.                                                                | TASK-036                  |           |      |
| TASK-039 | P0 / Latency 0, Quality + / M | Exempt only path-scoped diff recovery for the named omitted/truncated files from the ordinary-call budget. Cap each recovery response, record completion per file, reject recovery requests for unrelated paths, and switch to the normal tier after all named coverage gaps have been accessed.                                           | TASK-038                  |           |      |
| TASK-040 | P1 / Latency H, Quality 0 / M | Enforce counters in Pi's custom `read_file` and `git_diff` wrappers. On soft exhaustion, return a bounded tool result instructing the session to finish from current evidence; allow the final assistant response. On an attempted hard violation after soft stop, refuse that tool call without failing the session.                      | TASK-036, TASK-039        |           |      |
| TASK-041 | P1 / Latency H, Quality 0 / L | Add equivalent enforcement to ACP routes at the protocol/tool boundary when the capability matrix marks them enforceable. Keep permission denial distinct from budget exhaustion in telemetry.                                                                                                                                             | TASK-016, TASK-036        |           |      |
| TASK-042 | P1 / Latency M, Quality 0 / M | Add enforcement to OpenCode only if SDK/session hooks can deny or replace an individual tool result. If the installed SDK is observe-only, use prompt policy plus timeout and mark the backend `observe-only`; do not claim enforcement.                                                                                                   | TASK-013, TASK-036        |           |      |
| TASK-043 | P1 / Latency M, Quality 0 / M | Add Qoder enforcement only through a documented SDK hook proven by a focused contract test. Do not set `maxTurns` until successful-run turn distributions exist.                                                                                                                                                                           | TASK-014, TASK-036        |           |      |
| TASK-044 | P2 / Latency M, Quality 0 / S | For opaque CLI routes such as dim, inject the common prompt policy and retain the absolute timeout. Record that byte/path enforcement is unavailable rather than lowering a global turn ceiling.                                                                                                                                           | TASK-015, TASK-036        |           |      |
| TASK-045 | P1 / Latency M, Quality 0 / S | After at least 30 successful sessions per backend/risk tier, calculate the p90 and p99 useful-turn distributions where a useful turn precedes a retained finding or resolves coverage. Add a backend-specific soft finish threshold at p90 and retain timeout/p99 only as a runaway guard.                                                 | TASK-019, TASK-036        |           |      |
| TASK-046 | P0 / Latency 0, Quality + / M | Add tests for budget exhaustion, coverage exemption, transition out of recovery, repeated reads, equivalent searches, soft finish, opaque backend behavior, failure classes, and full-diff coverage under every tier.                                                                                                                      | TASK-038 through TASK-045 |           |      |
| TASK-047 | P1 / Latency H, Quality 0 / S | Run three arms: prompt-only, prompt plus standard budget, and prompt plus risk-adaptive budget. Graduate enforcement only if QLT-003/004 pass and either p50 latency improves 15% or tool-output tokens fall 25% without worsening p95.                                                                                                    | TASK-046                  |           |      |

Completion criteria for Phase 4:

- Coverage-recovery reads cannot be starved by an ordinary exploration budget.
- Enforceable backends stop redundant work without terminating the final response.
- Opaque backends are honestly labeled and remain bounded by prompt policy and wall-clock timeout.

### Implementation Phase 5 — Replace model discovery turns with deterministic adjacency context

- GOAL-006: Move predictable caller/test/contract discovery into parallel, cacheable preprocessing.

| Task     | Priority / Impact / Effort    | Description                                                                                                                                                                                                                                                                                             | Dependencies              | Completed | Date |
| -------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | --------- | ---- |
| TASK-048 | P1 / Latency H, Quality + / M | Extend `src/shared/blast-radius.ts` to return typed manifest entries in addition to rendered text: symbol, declaration file, changed/removed status, unchanged reference files, truncation count, and retrieval failure class. Preserve existing rendered output through an adapter.                    | TASK-035                  |           |      |
| TASK-049 | P1 / Latency M, Quality + / M | Detect changed exported declarations, removed/renamed exports, named re-exports, export-star changes, and patchless uncertainty using existing diff parsing. Keep language-light git/regex extraction first; do not add a parser dependency in this task.                                               | TASK-048                  |           |      |
| TASK-050 | P1 / Latency H, Quality + / M | Add `src/shared/adjacency-context.ts` to select bounded snippets from direct unchanged callers, interfaces/contracts, and likely tests. Use line-oriented git/read operations outside model sessions, run independent retrievals concurrently, and cap total and per-entry bytes with omission notices. | TASK-048                  |           |      |
| TASK-051 | P1 / Latency M, Quality + / M | Rank adjacency entries by changed-symbol match, risk path, removed/narrowed contract, unchanged production caller, matching test stem, and distance. Put pure ranking in `src/shared/adjacency-context.ts`; do not add logic to `runner.ts`.                                                            | TASK-050                  |           |      |
| TASK-052 | P2 / Latency M, Quality + / M | Add deterministic test mapping: same stem, same directory, import/reference hit, and repository test conventions. Include only bounded candidates and explicitly state omitted candidate counts.                                                                                                        | TASK-050                  |           |      |
| TASK-053 | P2 / Latency M, Quality + / M | Add contract mapping for changed schemas, endpoint descriptors, config keys, action inputs, environment variables, database migrations, and generated-client boundaries using existing path taxonomy plus exact identifier searches. Keep unsupported languages fail-open to no extra block.            | TASK-050                  |           |      |
| TASK-054 | P1 / Latency M, Quality + / S | Inject the deterministic adjacency block after core PR context but before any lens addendum. Update prompt instructions to treat snippets as starting evidence while permitting a targeted read when the snippet is insufficient.                                                                       | TASK-050, TASK-029        |           |      |
| TASK-055 | P1 / Latency M, Quality 0 / S | Cache adjacency manifests by repository tree id, diff fingerprint, extractor version, and budget version outside the checkout. Reuse the shard-cache poisoning guard and fail-open behavior; never cache model findings in this cache.                                                                  | TASK-048                  |           |      |
| TASK-056 | P0 / Latency 0, Quality + / M | Add `test/adjacency-context.test.ts` and extend `test/blast-radius.test.ts` for removed exports, multiple callers, tests, contracts, snippets, ordering, omissions, byte caps, hostile identifiers, git failures, and unchanged output compatibility.                                                   | TASK-048 through TASK-055 |           |      |
| TASK-057 | P1 / Latency H, Quality + / S | Benchmark manifest-only versus manifest-plus-snippets. Graduate snippets only if cross-file recall improves or remains non-inferior while targeted search/read turns fall at least 30%; otherwise keep the cheaper filename manifest.                                                                   | TASK-056                  |           |      |

Completion criteria for Phase 5:

- Direct unchanged callers for supported exported-symbol changes are supplied without a model search turn.
- Every deterministic block is bounded, omission-aware, cacheable, and fail-open.
- The chosen treatment reduces agentic discovery without diluting the core diff signal.

### Implementation Phase 6 — Optimize context composition and prefix reuse

- GOAL-007: Reduce prefill and repeated-context cost while keeping the complete review signal.

| Task     | Priority / Impact / Effort    | Description                                                                                                                                                                                                                                                                                                | Dependencies              | Completed | Date |
| -------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | --------- | ---- |
| TASK-058 | P0 / Latency 0, Quality + / S | Add token estimates and actual provider input/cache tokens to the existing byte budget report. Keep bytes as the hard safety budget; use tokens only for performance analysis because tokenizer availability varies.                                                                                       | TASK-009                  |           |      |
| TASK-059 | P1 / Latency M, Quality 0 / M | Run the existing `JBOT_CONTEXT_TRIM` arm against the full corpus. Report which supplementary blocks were dropped, tool work induced by each drop, cache effects, and quality changes. Do not enable it from latency alone.                                                                                 | TASK-005, TASK-019        |           |      |
| TASK-060 | P1 / Latency M, Quality + / M | Audit `REVIEW_PROMPT` for semantic duplication. Remove only rules stated more than once, preserve prompt-order invariants, and prove structural requirements in `test/prompt.test.ts`. Benchmark prompt bytes, reasoning tokens, and quality after each deletion group.                                    | TASK-035                  |           |      |
| TASK-061 | P1 / Latency M, Quality 0 / M | Reorder only variable prompt blocks that do not violate invariant #5 so all shard/lens sessions maximize a byte-identical prefix. Extend `test/runner.test.ts` to calculate shared-prefix bytes and fail on regressions above an explicit tolerance.                                                       | TASK-058                  |           |      |
| TASK-062 | P1 / Latency M, Quality 0 / S | Add cache-effectiveness telemetry: eligible sessions, cache-key enabled, cache read/write tokens, shared-prefix bytes, hit/miss/unknown status, and avoided-input estimate. Separate provider prompt cache from local shard-result cache.                                                                  | TASK-009, TASK-061        |           |      |
| TASK-063 | P2 / Latency M, Quality + / M | Test risk-aware guideline selection and tighter relevance budgets in `src/shared/review-context.ts`. Never truncate away scoped guidance that applies to a changed file; drop unrelated or lower-relevance guidance first and disclose omissions.                                                          | TASK-025, TASK-058        |           |      |
| TASK-064 | P2 / Latency M, Quality + / M | Test compact diff rendering that removes transport-only redundancy while retaining every changed line, hunk header, file identity, and anchoring line number. Reject any format that makes evidence quotes or line anchoring less reliable.                                                                | TASK-025                  |           |      |
| TASK-065 | P2 / Latency L, Quality 0 / S | Separate context contracts by session type: main/lens receives complete review context, verifier receives only required diff/evidence/finding context, addressed check receives prior threads plus relevant diff, and changes-since receives delta metadata. Prove no session gets unrelated large blocks. | TASK-058                  |           |      |
| TASK-066 | P0 / Latency 0, Quality + / M | Add regression tests for hard fragment budgets, assembled cap warnings, prefix identity, output reminder position, full changed-line preservation, scoped guideline retention, and omission disclosures.                                                                                                   | TASK-058 through TASK-065 |           |      |

Completion criteria for Phase 6:

- Every context reduction has an adjudicated quality result.
- Cache-eligible sessions report whether cache reuse actually occurred.
- No context optimization hides a changed line or an applicable scoped rule.

### Implementation Phase 7 — Replace byte-only sharding with predicted critical-path cost

- GOAL-008: Balance shards by expected session cost and provider concurrency rather than patch bytes alone.

| Task     | Priority / Impact / Effort    | Description                                                                                                                                                                                                                                                                                     | Dependencies              | Completed | Date |
| -------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | --------- | ---- |
| TASK-067 | P1 / Latency H, Quality + / M | Add pure `src/shared/review-cost.ts` and `test/review-cost.test.ts`. Define features from patch bytes, added/removed lines, file count, risk score, changed-symbol count, adjacency count, truncated/patchless state, language/file type, guideline bytes, and historical backend coefficients. | TASK-005, TASK-009        |           |      |
| TASK-068 | P1 / Latency H, Quality 0 / M | Extend `shardFilesForReview` in `src/shared/diff-context.ts` to accept an injected cost function while retaining byte cost as the default/control. Use largest-processing-time-first assignment and preserve every file in exactly one shard.                                                   | TASK-067                  |           |      |
| TASK-069 | P1 / Latency M, Quality + / M | Replace directory-wide affinity as the sole relation with a bounded affinity graph that prioritizes implementation/test pairs, changed-symbol edges, schema/consumer pairs, and locale variants. Split oversized clusters exactly as today when balance requires it.                            | TASK-048, TASK-068        |           |      |
| TASK-070 | P1 / Latency H, Quality 0 / M | Add a backend capacity profile: measured concurrent speedup, provider queue behavior, prompt-cache support, rate-limit rate, and max useful shards. Auto shard count must minimize predicted maximum shard duration plus queue overhead, bounded by `DEFAULT_MAX_REVIEW_SHARDS`.                | TASK-019, TASK-067        |           |      |
| TASK-071 | P2 / Latency M, Quality 0 / S | Start predicted-longest shards first when session slots are constrained. Preserve deterministic tie-breaking and high priority for main/verification.                                                                                                                                           | TASK-067                  |           |      |
| TASK-072 | P2 / Latency M, Quality + / M | Test a risk floor that prevents all high-risk files from landing in one shard when equivalent affinity permits distribution. Do not separate a contract from its only known consumer solely to equalize risk.                                                                                   | TASK-069                  |           |      |
| TASK-073 | P2 / Latency M, Quality 0 / M | Fit coefficients from telemetry using an offline script with train/validation split and regularization or a simple robust linear model. Store versioned coefficients and fall back to byte cost when sample size or prediction error fails the documented gate.                                 | TASK-067                  |           |      |
| TASK-074 | P0 / Latency 0, Quality + / M | Extend `test/diff-context.test.ts`, `test/runner.test.ts`, and `test/session-concurrency.test.ts` for complete union coverage, no duplicate files, affinity, deterministic order, provider cap, patchless files, oversized single files, explicit shard pins, and byte-cost fallback.           | TASK-068 through TASK-073 |           |      |
| TASK-075 | P1 / Latency H, Quality 0 / S | Graduate predicted sharding only if p95 slowest-shard duration improves at least 15% on medium/large diffs and main failure/rate-limit rate does not increase. Keep single-session default for provider cohorts with no measured parallel speedup.                                              | TASK-074                  |           |      |

Completion criteria for Phase 7:

- Shard planning predicts critical-path duration better than patch bytes on held-out runs.
- Full-diff union and anchoring invariants remain mechanically tested.
- Auto sharding responds to actual provider concurrency rather than a global assumption.

### Implementation Phase 8 — Remove avoidable orchestration tail latency

- GOAL-009: Make end-to-end wall time approach the slowest necessary main/verification path rather than the sum of avoidable tails.

| Task     | Priority / Impact / Effort    | Description                                                                                                                                                                                                                                                                                        | Dependencies              | Completed | Date |
| -------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | --------- | ---- |
| TASK-076 | P1 / Latency H, Quality 0 / M | Add cancellation plumbing to `ReviewBackend` operations and `settleWithinGrace`. When a fail-open auxiliary result is abandoned at grace expiry, abort the underlying session, release its slot, record `aborted-after-grace`, and prevent process-exit linger.                                    | TASK-009                  |           |      |
| TASK-077 | P1 / Latency H, Quality 0 / S | Implement Phase 8 cancellation first for Pi using its existing best-effort abort path and active-session registry. Add tests proving no post-review token row arrives from an abandoned session and teardown finishes promptly.                                                                    | TASK-076                  |           |      |
| TASK-078 | P1 / Latency M, Quality 0 / L | Implement cancellation for OpenCode, Qoder, ACP, and child-process CLIs where their current lifecycle exposes a safe abort/kill. Preserve temp-home cleanup and classify unsupported routes explicitly.                                                                                            | TASK-076                  |           |      |
| TASK-079 | P1 / Latency H, Quality 0 / M | Prototype post-main verification overlapping only the remaining auxiliary settle grace. Snapshot settled findings after main, verify that snapshot concurrently, merge late findings under existing fail-open semantics, and record `late-unverified` counts. Keep this behind an experiment flag. | TASK-009, TASK-025        |           |      |
| TASK-080 | P0 / Latency 0, Quality + / S | Reject the overlap treatment automatically if any late unverified P0/P1 finding appears, if late-unverified blocking findings exceed 0.5% of runs, or if precision is worse than the serial verifier within QLT-004.                                                                               | TASK-079                  |           |      |
| TASK-081 | P1 / Latency M, Quality 0 / S | Retain verification's current high session priority and add queue-duration telemetry/assertions so later refactors cannot place verification behind recall supplements.                                                                                                                            | TASK-011                  |           |      |
| TASK-082 | P1 / Latency M, Quality + / S | Re-evaluate dynamic fan-out thresholds with telemetry. Keep full main review and verification fixed; change only lens/guideline counts when marginal retained findings per second are below the documented threshold.                                                                              | TASK-019, TASK-025        |           |      |
| TASK-083 | P2 / Latency M, Quality 0 / S | Separate auxiliary provider/model configuration experiments from same-model product benchmarks. Measure paid-fast versus free-throttled auxiliary paths by cost, tail latency, and retained unique findings; never attribute this win to same-model algorithmic improvement.                       | TASK-019                  |           |      |
| TASK-084 | P1 / Latency L, Quality 0 / S | Parallelize independent pre-session GitHub fetches in `src/shared/runner.ts` after identifying dependency edges. Preserve rate-limit behavior and deterministic context ordering; benchmark because prior measurements put the maximum gain in seconds.                                            | TASK-011                  |           |      |
| TASK-085 | P0 / Latency 0, Quality + / M | Extend `test/runner.test.ts` and backend tests for cancellation, grace expiry, slot release, late findings, serial fallback, verification priority, error classification, and no posting before main completion.                                                                                   | TASK-076 through TASK-084 |           |      |

Completion criteria for Phase 8:

- Abandoned auxiliary sessions no longer hold the process or a concurrency slot.
- Any verification overlap remains explicitly measurable and automatically reversible.
- Main completion and full filtering still precede final GitHub publication.

### Implementation Phase 9 — Reduce output and repair overhead with structured generation

- GOAL-010: Produce valid, concise review JSON with fewer decode tokens and fewer repair turns.

| Task     | Priority / Impact / Effort    | Description                                                                                                                                                                                                                                                                                         | Dependencies              | Completed | Date |
| -------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | --------- | ---- |
| TASK-086 | P1 / Latency M, Quality + / M | Add a backend capability field for native JSON schema/constrained output, plain JSON instruction, and unsupported. Detect support from current installed SDK/provider configuration rather than model-name guesses.                                                                                 | TASK-013 through TASK-017 |           |      |
| TASK-087 | P1 / Latency M, Quality + / M | Define one canonical JSON Schema from `ReviewResult`, `Finding`, verdict, addressed-check, and change-summary contracts. Keep concrete examples in prompts; use the schema only on backends that support constrained decoding.                                                                      | TASK-086                  |           |      |
| TASK-088 | P1 / Latency M, Quality + / M | Route supported OpenCode/Pi/provider requests through constrained structured output while preserving `parseReview` sanitation. Treat schema rejection as a provider capability failure and retry through the existing plain-JSON path once.                                                         | TASK-087                  |           |      |
| TASK-089 | P1 / Latency M, Quality + / S | Add response-size budgets for summaries, titles, bodies, evidence, and total findings. Enforce caps in code after parse; do not truncate away required trigger/fix semantics. Continue using `maxFindings` only after quality filtering.                                                            | TASK-087                  |           |      |
| TASK-090 | P2 / Latency M, Quality 0 / M | Experiment with findings-first output and deterministic shard-summary merging. Compare current model-written summaries against concise per-shard summaries and a deterministic changed-file synopsis; keep the current format unless decode/time improves without user-visible summary degradation. | TASK-025                  |           |      |
| TASK-091 | P1 / Latency M, Quality + / S | Record parse success, repair invocation, repair duration/tokens, schema fallback, and recovered result. Set a release target of less than 1% repair rate for constrained-capable backends.                                                                                                          | TASK-009, TASK-088        |           |      |
| TASK-092 | P0 / Latency 0, Quality + / M | Extend parse/repair/backend tests with extra keys, missing keys, unicode, large findings, malformed streams, schema fallback, no-tool verification, and exact compatibility for unsupported backends.                                                                                               | TASK-087 through TASK-091 |           |      |

Completion criteria for Phase 9:

- Structured-capable backends materially reduce repair rate and do not lose valid findings.
- Unsupported backends continue through the existing parser/repair contract.
- Output caps cannot silently turn an actionable finding into an incomplete one.

### Implementation Phase 10 — Improve safe reuse and cache locality

- GOAL-011: Avoid rebilling identical work without reusing stale analysis across behaviorally different diffs.

| Task     | Priority / Impact / Effort    | Description                                                                                                                                                                                                                                             | Dependencies                 | Completed | Date |
| -------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | --------- | ---- |
| TASK-093 | P1 / Latency H, Quality 0 / S | Audit same-head shard-cache hit rate, restore/save duration, miss reasons, entry size, and eviction. Add hit/miss reason telemetry and an offline cache-inspection command that never prints findings/source.                                           | TASK-009                     |           |      |
| TASK-094 | P1 / Latency H, Quality 0 / S | Verify consumer workflows persist `${RUNNER_TEMP}/jbot-shard-cache` with stable PR/head keys. Dogfood already restores/saves; document required consumer wiring without changing the stable `uses:`/`with:` contract.                                   | TASK-093                     |           |      |
| TASK-095 | P1 / Latency M, Quality 0 / S | Increment `FINGERPRINT_VERSION` whenever prompt, policy, evidence, model options, exploration budget, adjacency context, or structured-output configuration changes result comparability. Add a test listing every fingerprint input.                   | TASK-036, TASK-050, TASK-087 |           |      |
| TASK-096 | P1 / Latency M, Quality 0 / M | Add caches for deterministic guideline discovery, changed-symbol extraction, adjacency search results, and diff parsing keyed by immutable tree/diff/version identifiers. Keep each cache bounded and outside the checkout.                             | TASK-050, TASK-055           |           |      |
| TASK-097 | P2 / Latency M, Quality 0 / M | Investigate cross-head reuse only for deterministic preprocessing whose input hashes are identical. Do not reuse model findings across heads in this phase; interactions elsewhere in the PR can invalidate an unchanged shard.                         | TASK-096                     |           |      |
| TASK-098 | P2 / Latency M, Quality 0 / M | Add cache-aware session ordering: among equally urgent sessions, prefer those sharing the longest stable prefix only when doing so does not delay verification or increase predicted critical path. Apply only when the provider reports cache support. | TASK-062, TASK-070           |           |      |
| TASK-099 | P0 / Latency 0, Quality + / M | Add poisoning, symlink, corruption, version mismatch, partial write, cross-repo, cross-model, cross-policy, and concurrent-writer tests to `test/shard-cache.test.ts` and new deterministic-cache tests.                                                | TASK-093 through TASK-098    |           |      |

Completion criteria for Phase 10:

- Identical eligible work produces measurable cache hits, not merely enabled cache flags.
- No model finding is reused across a changed head.
- Corrupt, stale, or workspace-controlled cache entries degrade to misses.

### Implementation Phase 11 — Tune reasoning and escalation on the same model

- GOAL-012: Reduce reasoning/decode time using controlled same-model configurations and risk-based escalation.

| Task     | Priority / Impact / Effort         | Description                                                                                                                                                                                                                                                                 | Dependencies              | Completed | Date |
| -------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | --------- | ---- |
| TASK-100 | P1 / Latency H, Quality - risk / S | Run fixed-model A/B tests for supported reasoning levels (`medium` versus `low`, then `low` versus `minimal`) using identical prompts and corpus. Report reasoning tokens, main duration, recall, precision, and variance separately.                                       | TASK-025, TASK-058        |           |      |
| TASK-101 | P1 / Latency H, Quality + / M      | Test risk-based reasoning: elevated effort for security/data/API/concurrency/large-deletion shards and lower effort for low-risk/test/docs/config shards, using the same model weights. Keep all shards fully reviewed.                                                     | TASK-067, TASK-100        |           |      |
| TASK-102 | P2 / Latency M, Quality + / M      | Test escalation on uncertainty: begin at the graduated lower effort, then rerun only a shard that reports incomplete coverage, ambiguous high-risk contracts, parse failure, or a low-confidence blocking candidate. Do not use absence of findings alone as a skip signal. | TASK-100                  |           |      |
| TASK-103 | P2 / Latency M, Quality + / M      | Test adaptive verification effort based on finding severity and evidence completeness while retaining verification for all blocking findings. Use a single batched verifier call unless data shows batching harms verdict quality.                                          | TASK-100                  |           |      |
| TASK-104 | P0 / Latency 0, Quality + / S      | Add model-option fingerprinting and telemetry so reasoning arms cannot alias in local/provider caches or be reported as the same configuration accidentally.                                                                                                                | TASK-095, TASK-100        |           |      |
| TASK-105 | P1 / Latency H, Quality 0 / S      | Graduate a lower-effort or adaptive arm only when QLT-003/004 pass across the full corpus and at least three real-PR canaries. Otherwise keep it as an operator experiment.                                                                                                 | TASK-100 through TASK-104 |           |      |

Completion criteria for Phase 11:

- Reasoning savings are measured separately from prompt/tool/sharding savings.
- Same-model claims include exact reasoning configuration.
- Escalation never converts a clean first pass into evidence that full coverage occurred when it did not.

### Implementation Phase 12 — Remove CI and packaging overhead outside inference

- GOAL-013: Reduce fixed setup and cancellation waste without conflating it with model speed.

| Task     | Priority / Impact / Effort    | Description                                                                                                                                                                                                                                         | Dependencies              | Completed | Date |
| -------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | --------- | ---- |
| TASK-106 | P1 / Latency H, Quality 0 / L | Design an in-process execution path for Pi/SDK-only routing that avoids building/loading the full CLI image in dogfood. Determine routing before execution, preserve action inputs/env/GitHub semantics, and keep the Docker path for CLI backends. | TASK-007                  |           |      |
| TASK-107 | P1 / Latency M, Quality 0 / L | Build and publish a slim SDK-only image variant for consumer runs that do not require bundled CLIs. Select it through an upstream action-owned mechanism; do not require consumer-side wrappers or break the stable `uses:`/`with:` contract.       | TASK-106                  |           |      |
| TASK-108 | P1 / Latency M, Quality 0 / M | Compare composite/node execution, slim image, and full image for cold pull, warm pull, startup, isolation, fork behavior, credential exposure, and backend coverage. Choose the lowest-latency path that preserves the required isolation boundary. | TASK-106, TASK-107        |           |      |
| TASK-109 | P2 / Latency L, Quality 0 / S | Retain `setup-node` npm caching and measure `npm ci`/build before further work. Optimize only when setup remains more than 5% of p50 end-to-end time after inference improvements.                                                                  | TASK-007                  |           |      |
| TASK-110 | P1 / Latency M, Quality 0 / S | Quantify cancelled-run waste from `cancel-in-progress`. Ensure cancellation propagates to model sessions and cache writes; retain freshest-head semantics. Report avoided provider tokens after cancellation plumbing.                              | TASK-076                  |           |      |
| TASK-111 | P2 / Latency L, Quality 0 / S | Parallelize independent action setup steps only where GitHub Actions semantics permit it and measurement shows benefit. Do not reduce checkout history below what merge-base diffing requires.                                                      | TASK-007                  |           |      |
| TASK-112 | P0 / Latency 0, Quality + / M | Validate node/slim/full routes with `npm test`, typecheck, lint, build, local dry-run, fork-safe auth checks, exact action inputs, same-head cache, and one live dogfood review per route.                                                          | TASK-106 through TASK-111 |           |      |

Completion criteria for Phase 12:

- Fixed setup time is reported separately from review inference.
- SDK-only runs avoid unused CLI payload without removing the CLI route.
- No consumer contract or fork security behavior changes unintentionally.

### Implementation Phase 13 — Evaluate SGLang and controlled inference

- GOAL-014: Determine whether self-hosted inference can provide a second performance tier after application-level optimizations are exhausted.

| Task     | Priority / Impact / Effort                   | Description                                                                                                                                                                                                                                                                                                       | Dependencies              | Completed | Date |
| -------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | --------- | ---- |
| TASK-113 | P3 / Latency H potential, Quality 0 / M      | Create `docs/superpowers/specs/2026-08-19-sglang-review-serving-evaluation.md`. Define required model weights/license, tokenizer, context length, precision, hardware, concurrency, availability, security, cost, and same-model comparability.                                                                   | TASK-005                  |           |      |
| TASK-114 | P3 / Latency H potential, Quality 0 / L      | Stand up an isolated SGLang OpenAI-compatible endpoint for one benchmark model and route it through the existing `openai-compatible` provider. Do not add a bespoke review backend until API incompatibility is proven.                                                                                           | TASK-113                  |           |      |
| TASK-115 | P3 / Latency H potential, Quality 0 / M      | Benchmark baseline SGLang with RadixAttention enabled versus disabled using shared-prefix shard/lens traffic. Report TTFT, input throughput, decode throughput, cache-hit tokens, GPU memory, queue time, and end-to-end review metrics.                                                                          | TASK-114, TASK-061        |           |      |
| TASK-116 | P3 / Latency H potential, Quality 0 / M      | Benchmark cache-aware scheduling policies, including longest-prefix-match and coding-agent-oriented depth-first weighting where supported. Compare against FCFS under balanced and overloaded queues; retain verification priority at the application layer.                                                      | TASK-115                  |           |      |
| TASK-117 | P3 / Latency M potential, Quality + / M      | Enable constrained JSON output through SGLang's supported structured-output mechanism and compare schema adherence, repair rate, decode speed, and finding quality against unconstrained output.                                                                                                                  | TASK-087, TASK-114        |           |      |
| TASK-118 | P3 / Latency H potential, Quality - risk / L | Evaluate speculative decoding with a compatible draft model. Require token acceptance, TTFT/decode gains, memory/cost accounting, and full quality non-inferiority; classify this as same-target-model but different runtime configuration.                                                                       | TASK-114                  |           |      |
| TASK-119 | P3 / Latency H potential, Quality 0 / XL     | Evaluate prefill/decode disaggregation only after single-node profiling shows prefill or decode resource imbalance at production concurrency. Compare disaggregated versus colocated workers including network transfer, tail latency, failure domains, and operating cost.                                       | TASK-115                  |           |      |
| TASK-120 | P3 / Latency H potential, Quality 0 / L      | Evaluate continuous batching and cache-aware routing across multiple workers. Route to prefix-local workers only while load is balanced; fall back to shortest queue under imbalance. Measure single-review latency and fleet throughput separately.                                                              | TASK-115                  |           |      |
| TASK-121 | P3 / Latency M potential, Quality - risk / M | Evaluate tensor parallelism, data parallelism, hierarchical cache, quantization, and chunked/large-context prefill as separate arms. Quantized runs must never be labeled identical-model precision and must pass the complete quality suite.                                                                     | TASK-114                  |           |      |
| TASK-122 | P3 / Latency 0, Quality + / L                | Add production requirements: authentication, TLS, tenant isolation, request size caps, read-only review data retention, GPU health, overload control, timeout propagation, compromise shutdown, metrics, traces, canary routing, rollback, and cost allocation.                                                   | TASK-113                  |           |      |
| TASK-123 | P3 / Latency H potential, Quality 0 / S      | Adopt self-hosting only if it beats the best third-party same-model arm by at least 20% p50 and p95 end-to-end latency or 30% throughput at equal latency, passes QLT-003/004, and has an acceptable total cost and reliability result. Otherwise archive the benchmark and keep application-level optimizations. | TASK-115 through TASK-122 |           |      |

Completion criteria for Phase 13:

- SGLang results separate application, runtime, hardware, concurrency, and cache effects.
- Same-model claims are auditable from weights and inference configuration.
- No self-hosted endpoint reaches production without security, reliability, and rollback controls.

### Implementation Phase 14 — Add adaptive policy selection and safe rollout

- GOAL-015: Turn successful experiments into bounded, explainable defaults that adapt to diff and backend shape.

| Task     | Priority / Impact / Effort    | Description                                                                                                                                                                                                                                    | Dependencies                                                                             | Completed | Date |
| -------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | --------- | ---- |
| TASK-124 | P1 / Latency H, Quality + / M | Add pure `src/shared/review-plan.ts` that selects exploration tier, adjacency budget, shard count, reasoning effort, fan-out, and cache policy from change shape plus backend capabilities. Emit a machine-readable reason for every decision. | TASK-035, TASK-047, TASK-057, TASK-066, TASK-075, TASK-085, TASK-092, TASK-099, TASK-105 |           |      |
| TASK-125 | P0 / Latency 0, Quality + / S | Keep conservative fallbacks: unknown backend capability, patchless file, failed classifier, unseen risk shape, or insufficient telemetry selects full exploration/fan-out and default reasoning rather than the fastest tier.                  | TASK-124                                                                                 |           |      |
| TASK-126 | P1 / Latency 0, Quality + / S | Add internal experiment flags and deterministic cohort assignment by repository/PR/head hash. Never expose unstable knobs as public action inputs until a treatment graduates.                                                                 | TASK-124                                                                                 |           |      |
| TASK-127 | P1 / Latency 0, Quality + / M | Add shadow mode: compute the proposed review plan and predicted savings without applying it. Compare prediction to actual baseline for at least 30 runs before enabling behavior.                                                              | TASK-124                                                                                 |           |      |
| TASK-128 | P1 / Latency 0, Quality + / S | Roll out 5%, 25%, 50%, and 100% with automatic rollback if P0/P1 miss, precision/recall gate failure, timeout/failure increase over 2 percentage points, or p95 regression over 10% occurs.                                                    | TASK-126, TASK-127                                                                       |           |      |
| TASK-129 | P1 / Latency 0, Quality + / S | Emit one concise plan line per run: policy version, risk tier, exploration mode/budget, shard plan, reasoning arm, fan-out, cache eligibility, and experiment cohort. Do not expose internal source or secrets.                                | TASK-124                                                                                 |           |      |
| TASK-130 | P0 / Latency 0, Quality + / M | Add exhaustive policy tests for known/unknown shapes, boundary sizes, sensitive paths, patchless diffs, first review/re-review, provider concurrency, tool-less backends, omitted hunks, and deterministic cohort assignment.                  | TASK-124 through TASK-129                                                                |           |      |

Completion criteria for Phase 14:

- Every adaptive decision is deterministic, logged, versioned, testable, and conservatively fail-open.
- A rollback can restore the prior policy without changing prompt/cache identities accidentally.
- Public configuration remains small and stable.

### Implementation Phase 15 — Competitive tracking and continuous optimization

- GOAL-016: Maintain a durable quality-speed lead rather than a one-time benchmark win.

| Task     | Priority / Impact / Effort    | Description                                                                                                                                                                                                                                         | Dependencies       | Completed | Date |
| -------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | --------- | ---- |
| TASK-131 | P1 / Latency 0, Quality + / M | Publish an internal weekly scorecard by model/backend/risk/size with quality-adjusted latency, p95, provider cost, valid findings, clean false positives, cache effectiveness, duplicate exploration, repair rate, and failures.                    | TASK-019, TASK-025 |           |      |
| TASK-132 | P1 / Latency 0, Quality + / M | Add regression alerts for prompt/context growth, cache-prefix shrinkage, tool-byte growth, duplicate reads, turn growth, reasoning-token growth, verifier tail, repair rate, and quality metrics. Use rolling baselines with minimum sample guards. | TASK-131           |           |      |
| TASK-133 | P1 / Latency 0, Quality + / M | Sample missed/late/human-rejected findings monthly and add adjudicated counterexamples to the corpus. Never train or tune directly from unresolved reply presence or raw private code without authorization.                                        | TASK-023, TASK-131 |           |      |
| TASK-134 | P2 / Latency M, Quality + / M | Refit review-cost and adaptive-policy coefficients only when held-out prediction error improves materially. Version every coefficient set and retain the previous set for rollback.                                                                 | TASK-073, TASK-124 |           |      |
| TASK-135 | P2 / Latency 0, Quality + / M | Run same-model competitor comparisons quarterly using the frozen corpus and identical endpoint configuration. Report unavailable controls and product-level differences such as context retrieval separately from model quality.                    | TASK-027           |           |      |
| TASK-136 | P1 / Latency 0, Quality + / S | Maintain a decision log in `docs/superpowers/benchmarks/decisions.md` containing experiment, hypothesis, evidence, result, graduation/rejection, policy version, and follow-up date.                                                                | TASK-005           |           |      |
| TASK-137 | P1 / Latency 0, Quality + / S | Define a quarterly deletion pass: remove flags, adapters, telemetry fields, caches, and policy branches for rejected experiments after their evidence is archived. Keep the production surface smaller than the experimental surface.               | TASK-136           |           |      |

Completion criteria for Phase 15:

- Quality-speed regressions are visible before they become the new baseline.
- Benchmark cases evolve from verified misses and false positives rather than anecdote.
- Rejected experimentation code does not accumulate indefinitely.

### Implementation Phase 16 — High-risk research backlog

- GOAL-017: Track potentially valuable ideas without putting them on the default path prematurely.

| Task     | Priority / Impact / Effort                    | Description                                                                                                                                                                                                                                                                                                                 | Dependencies              | Completed | Date |
| -------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | --------- | ---- |
| TASK-138 | P3 / Latency H potential, Quality - risk / L  | Explore hierarchical review: cheap per-file anomaly extraction followed by a full-diff synthesis session on the same model. Reject if the extraction layer becomes a recall gate or if the synthesis lacks complete diff access.                                                                                            | TASK-020 through TASK-025 |           |      |
| TASK-139 | P3 / Latency H potential, Quality - risk / L  | Explore candidate-first review where deterministic/static signals propose areas and the model verifies them. Keep the ordinary full-diff main pass until evidence proves candidate generation does not create recall holes.                                                                                                 | TASK-020 through TASK-025 |           |      |
| TASK-140 | P3 / Latency M potential, Quality + / XL      | Explore language-aware dependency graphs with a parser or language server only after git/regex adjacency misses are quantified. Require sandboxing, startup-cost measurement, multi-language coverage, and a dependency justification.                                                                                      | TASK-057                  |           |      |
| TASK-141 | P3 / Latency M potential, Quality - risk / M  | Explore semantic compression of unchanged adjacent code. The compressed representation must carry provenance and permit targeted source retrieval; never semantically summarize changed diff lines.                                                                                                                         | TASK-050                  |           |      |
| TASK-142 | P3 / Latency H potential, Quality - risk / M  | Explore early clean-exit signals only for deterministically skippable classes such as existing docs-only logic. Do not stop a code review because the model has not found a bug yet.                                                                                                                                        | TASK-020 through TASK-025 |           |      |
| TASK-143 | P3 / Latency M potential, Quality + / M       | Explore verifier partitioning by independent finding groups when a single verifier request becomes the tail. Retain one-call batching as control and include provider concurrency/rate-limit effects.                                                                                                                       | TASK-091                  |           |      |
| TASK-144 | P3 / Latency H potential, Quality - risk / XL | Explore hunk-level sharding for a single oversized file only under a separate design that proves complete hunk union, shared file-level context, cross-hunk interactions, deterministic anchoring, and no duplicate findings. Do not alter the current file-exactly-once invariant without an explicit governance revision. | TASK-075                  |           |      |
| TASK-145 | P3 / Latency M potential, Quality + / M       | Explore retrieval-result distillation across turns: deterministic wrappers return the smallest caller/test snippet that answers the query instead of full files. Preserve an escape hatch for a bounded larger read when evidence is incomplete.                                                                            | TASK-050, TASK-040        |           |      |

Completion criteria for Phase 16:

- Each research item has a written hypothesis, bounded prototype, benchmark result, and explicit adopt/reject decision.
- No research item changes default review scope or safety before its prerequisite design and quality gate pass.

### Implementation Phase 17 — Close PR #3563's oversized single-shard failure class

- GOAL-018: Convert incident `INC-001` into a reproducible regression case and prevent one oversized tool-less request plus same-route retry from consuming the complete review budget.

| Task     | Priority / Impact / Effort          | Description                                                                                                                                                                                                                                                                                                                                                                                                                                             | Dependencies                        | Completed | Date |
| -------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | --------- | ---- |
| TASK-146 | P0 / Latency 0, Quality + / S       | Add an immutable private benchmark manifest entry for integral-xyz/fms PR #3563 head `be6a37bd83004deef3a777f59b8fccd3e21e1b5f`. Record the 41-file/160,489-patch-character shape, expected full-diff coverage, known historical findings, failed workflow/job ids, and permitted local reproduction method without committing proprietary source.                                                                                                      | TASK-002 through TASK-005           |           |      |
| TASK-147 | P0 / Latency 0, Quality + / S       | Add a preflight classification for every `ShardPlan`: backend tool capability, prompt bytes, embedded-diff bytes, assembled soft-cap ratio, predicted duration, and whether the plan was explicitly pinned or auto-selected. Emit a warning when a single tool-less shard exceeds either the assembled soft cap or the backend's measured successful-prompt envelope.                                                                                   | TASK-009, TASK-036, TASK-067        |           |      |
| TASK-148 | P1 / Latency H, Quality + / M       | Add a backend-aware auto-sharding experiment for tool-less main backends. When `reviewShards=0`, calculate shard count from delivered prompt cost rather than generic diff bytes; each shard must embed its complete assigned patch subset because tools remain unavailable. Preserve every changed file in exactly one shard and the existing clamp/union checks.                                                                                      | TASK-068 through TASK-075, TASK-147 |           |      |
| TASK-149 | P1 / Latency H, Quality + / S       | Add an operator/configuration canary that compares the current `JBOT_REVIEW_SHARDS=1` behavior with `JBOT_REVIEW_SHARDS=0` on the PR #3563 fixture for CommandCode and one tool-capable backend. Report slowest-shard time, aggregate tokens/cost, provider concurrency, finding recall, and whether the treatment remains within the 30-minute budget. Do not change the consumer variable by default until the result passes QLT-003/004.             | TASK-146, TASK-148                  |           |      |
| TASK-150 | P1 / Latency M, Quality + / M       | Replace retry-on-any-error with a pure failure-classified retry policy. Provider/API exit errors, rate limits, parse failures, timeouts, and local configuration failures must have separate decisions. Retry the same route only when the failure class is plausibly transient and the predicted prompt duration fits the remaining budget; never spend the entire remainder repeating an unchanged oversized request without a positive fit decision. | TASK-009, TASK-067                  |           |      |
| TASK-151 | P1 / Latency H, Quality + / L       | Prototype failure-adaptive resharding: after an oversized single main shard fails and enough deadline remains, split only that failed shard into smaller complete file shards, run them under the existing main-session priority/concurrency cap, and accept the retry only when their union exactly equals the failed shard's file set. Preserve the original backend/model for the same-model arm.                                                    | TASK-068, TASK-075, TASK-150        |           |      |
| TASK-152 | P2 / Latency M, Quality 0 / M       | Add model-pool failover as a separate product-reliability arm. On a provider/API failure, select the next configured pool entry for the retry only when same-model benchmarking is not active; fingerprint and report the changed model/backend explicitly so the result is never counted as a same-model optimization.                                                                                                                                 | TASK-006, TASK-150                  |           |      |
| TASK-153 | P0 / Latency 0, Quality + / M       | Extend `test/runner.test.ts`, `test/diff-context.test.ts`, backend tests, and the full benchmark with `INC-001`: one-shard provider error followed by insufficient remaining budget, successful adaptive reshard, exact file union, failed subshard behavior, model-pool failover labeling, and no posting of auxiliary-only partial coverage.                                                                                                          | TASK-146 through TASK-152           |           |      |
| TASK-154 | P1 / Latency H, Quality + / S       | Graduate an incident fix only when the fixed-model PR #3563 reproduction completes within 30 minutes in all required repetitions, preserves every adjudicated P0/P1/P2 finding, posts no new clean false positive, and does not increase provider failure/rate-limit rate. Archive the control and treatment telemetry with the decision.                                                                                                               | TASK-149 through TASK-153           |           |      |
| TASK-155 | P1 / Latency H waste, Quality 0 / S | Before any main-shard retry whose first attempt exceeded 60 seconds, re-fetch the PR state and current head through the existing GitHub client. If the PR is merged/closed or the head no longer equals the reviewed head, classify the run as `stale-before-retry`, skip the retry, post nothing, and finish telemetry without treating stale cancellation as a code-review finding. Local mode bypasses this check.                                   | TASK-011, TASK-150                  |           |      |
| TASK-156 | P2 / Latency H waste, Quality 0 / M | Evaluate a Depot/GitHub workflow cancellation path for `pull_request.closed` that cancels an in-flight same-PR review without launching a new model session. Verify Depot trigger/concurrency semantics first; retain TASK-155 as the correctness backstop when no close event arrives or an active provider call cannot be interrupted.                                                                                                                | TASK-076, TASK-110, TASK-155        |           |      |

Completion criteria for Phase 17:

- The PR #3563 shape is reproducible without relying on an expiring Depot artifact.
- A single tool-less request cannot silently exceed the measured prompt envelope without an explicit pinned-configuration warning.
- Main retry selection accounts for failure class, remaining budget, predicted duration, and model-comparability labeling.
- A retry cannot begin after the PR merged, closed, or moved to a different head.
- Every recovery path still refuses partial main coverage.

## 3. Alternatives

- **ALT-001**: Set one low global turn cap for every backend. Rejected as the primary strategy because turns have different meanings, tool-less backends already use high compatibility ceilings, and a hard cap can truncate exactly the large/risky reviews that require adjacent analysis. Retain backend-specific soft/p99 limits only after telemetry.
- **ALT-002**: Disable repository tools whenever a diff is embedded. Rejected because omitted/truncated patches and cross-file contract bugs require repository access; use embedded-first, coverage-aware tools instead.
- **ALT-003**: Review only the delta since the last J-Bot run. Rejected because it violates full-diff scope and misses interactions with earlier PR changes; delta remains summary text and auxiliary-lens gating only.
- **ALT-004**: Use a faster or smaller model and report the result as a pipeline optimization. Rejected for the primary objective because it invalidates same-model quality-speed comparison. Model substitutions may be a separate product-cost study.
- **ALT-005**: Increase shard count for every large diff. Rejected because throttled providers may serialize or rate-limit sessions, and more shards repeat shared context/output overhead. Use measured provider-aware predicted cost.
- **ALT-006**: Cache findings across changed PR heads when a shard's patch is unchanged. Deferred/rejected for default use because changes in other shards can alter contracts and invalidate the result. Cache deterministic preprocessing across identical inputs and model findings only for exact comparable content.
- **ALT-007**: Replace agentic review with static analyzers plus a model summarizer. Rejected as a complete architecture because static candidates create recall holes for business-logic and cross-file defects. Static/deterministic signals may enrich, not gate, full review.
- **ALT-008**: Post findings as soon as individual shards finish. Rejected because cross-shard deduplication, verification, severity filtering, anchoring, and final head validation have not completed.
- **ALT-009**: Implement self-hosted SGLang first. Rejected as sequencing because application-level redundant exploration, context, scheduling, cache, output, and CI costs affect every provider and are cheaper to validate first.
- **ALT-010**: Add a language parser/LSP immediately for blast-radius analysis. Deferred until git/regex retrieval misses are measured; a new dependency and multi-language runtime cost require evidence.
- **ALT-011**: Quantize a self-hosted model and call it a same-model comparison. Rejected terminology because changed precision can change quality; benchmark it as a separate runtime/model-precision arm.
- **ALT-012**: Remove verification to reduce tail latency. Rejected because it weakens precision. Optimize verifier priority, single-shot context, structured output, overlap during grace, and provider execution instead.

## 4. Dependencies

- **DEP-001**: Existing `src/shared/telemetry.ts` finding/session/run JSONL pipeline and CI artifact upload.
- **DEP-002**: Existing `src/shared/diff-context.ts` full-union sharding and `DiffHunksBlockResult` omission metadata.
- **DEP-003**: Existing `src/shared/prompt.ts` assembly and cache-stable prefix contract.
- **DEP-004**: Existing `src/shared/blast-radius.ts` deterministic exported-symbol grep manifest.
- **DEP-005**: Existing `src/shared/shard-cache.ts` content fingerprint and workspace-poisoning guard.
- **DEP-006**: Existing `src/shared/fanout.ts` risk-aware auxiliary-session scaling.
- **DEP-007**: Existing `src/shared/session-concurrency.ts` priority-aware global/provider slot limiting and high-priority verifier.
- **DEP-008**: Existing local review entry point and `.jbot-review` dry-run/telemetry outputs.
- **DEP-009**: Authenticated GitHub access for historical workflow/telemetry aggregation and live canary verification.
- **DEP-010**: Provider credentials and sufficient quotas for repeated fixed-model benchmark runs.
- **DEP-011**: Current SDK/CLI versions for OpenCode, Pi, Qoder, dim, ACP providers, and other routed backends; capability work must inspect the installed contracts.
- **DEP-012**: A secure external location for private benchmark repositories and raw artifacts when they cannot be committed.
- **DEP-013**: GPU capacity, compatible model weights/license, and production serving ownership before Phase 13 can move beyond local evaluation.
- **DEP-014**: Human adjudication capacity for ambiguous historical findings and competitor output.
- **DEP-015**: Stable model revision identifiers or explicit disclosure when a hosted provider does not expose them.

## 5. Files

- **FILE-001**: `plan/architecture-review-latency-quality-optimization-1.md` — this tracking plan.
- **FILE-002**: `src/shared/telemetry.ts` — extend run/session/finding telemetry with phases, tools, turns, budgets, cache, and policy rows.
- **FILE-003**: `src/shared/tool-telemetry.ts` — new bounded tool accounting and duplicate detection.
- **FILE-004**: `src/shared/exploration-policy.ts` — new pure coverage/risk-aware exploration policy and budget state.
- **FILE-005**: `src/shared/prompt.ts` — embedded-first exploration contract, stop condition, and structured-output prompt variants.
- **FILE-006**: `src/shared/runner.ts` — thin wiring for policies, phase telemetry, cancellation, context, sharding, verification, and experiments.
- **FILE-007**: `src/shared/session-concurrency.ts` — backend interface cancellation/budget options and priority preservation.
- **FILE-008**: `src/shared/pi.ts` — enforceable custom-tool budget, tool telemetry, soft stop, and cancellation.
- **FILE-009**: `src/shared/opencode.ts` — tool/session event observation, constrained output, cancellation, and capability detection.
- **FILE-010**: `src/shared/qoder.ts` — turn/tool telemetry and documented-hook budget support.
- **FILE-011**: `src/shared/dim.ts` — event telemetry and opaque-backend policy handling.
- **FILE-012**: `src/shared/acp.ts` and `src/shared/acp-remote.ts` — protocol-level event/cancellation/budget integration.
- **FILE-013**: Remaining backend adapters — capability metadata, timing, cancellation, and structured-output fallback where supported.
- **FILE-014**: `src/shared/blast-radius.ts` — typed changed-symbol/reference manifest.
- **FILE-015**: `src/shared/adjacency-context.ts` — new deterministic caller/test/contract snippet selection and ranking.
- **FILE-016**: `src/shared/context-trim.ts` and `src/shared/review-context.ts` — context experiments, relevance, and hard-budget preservation.
- **FILE-017**: `src/shared/diff-context.ts` — injected predicted-cost sharding and affinity graph.
- **FILE-018**: `src/shared/review-cost.ts` — new pure session-cost feature extraction and prediction.
- **FILE-019**: `src/shared/review-plan.ts` — new final adaptive policy selector after experiments graduate.
- **FILE-020**: `src/shared/shard-cache.ts` — cache observability/fingerprint version inputs; preserve exact-content safety.
- **FILE-021**: `src/shared/benchmark-score.ts` — new deterministic quality/latency scorer.
- **FILE-022**: `scripts/review-benchmark.ts` — new control/treatment benchmark runner.
- **FILE-023**: `scripts/review-performance.ts` — new telemetry aggregation and cohort report.
- **FILE-024**: `scripts/finding-dispositions.ts` — retain or extend finding-outcome reporting.
- **FILE-025**: `package.json` — add benchmark/performance commands only.
- **FILE-026**: `src/workflow/index.ts`, `src/app/app.ts`, and local/worker configuration entry points — internal flags and defaults after treatments graduate.
- **FILE-027**: `action.yml`, `.github/workflows/jbot-review.yml`, build scripts, and Dockerfiles — cache, slim/in-process routes, and telemetry artifact wiring.
- **FILE-028**: `test/*.test.ts` — focused pure/unit/backend/orchestration regression coverage described by phase.
- **FILE-029**: `test/fixtures/review-benchmark/` — redistributable manifest and benchmark cases.
- **FILE-030**: `docs/superpowers/specs/2026-08-19-review-speed-quality-scorecard.md` — measurement contract.
- **FILE-031**: `docs/superpowers/specs/2026-08-19-sglang-review-serving-evaluation.md` — controlled-inference design and go/no-go gate.
- **FILE-032**: `docs/superpowers/benchmarks/` — summarized baselines, experiment reports, and decision log.
- **FILE-033**: `docs/superpowers/audits/2026-08-06-wall-clock-latency-audit.md` — dated current-state appendix, preserving historical evidence.
- **FILE-034**: Private benchmark manifest entry for `INC-001` — immutable PR #3563 head metadata, expected findings, and content hashes without proprietary source.

## 6. Testing

- **TEST-001**: Run `node --import tsx --test test/benchmark-score.test.ts` for deterministic score formulas, fixed-seed confidence intervals, comparability rejection, and threshold gates.
- **TEST-002**: Run `node --import tsx --test test/telemetry.test.ts` for new row serialization, privacy bounds, missing metrics, phase reconciliation, tool duplicates, cache/policy metadata, and terminal states.
- **TEST-003**: Run `node --import tsx --test test/exploration-policy.test.ts` for modes, tiers, risk classification, recovery exemptions, soft stops, repeat budgets, and conservative fallback.
- **TEST-004**: Run `node --import tsx --test test/prompt.test.ts` for embedded-first wording, exact recovery exceptions, one-hop adjacency, stop condition, no-tools compatibility, rule uniqueness, and output-reminder order.
- **TEST-005**: Run backend-focused tests for Pi, OpenCode, Qoder, dim, ACP, CommandCode, Grok, Cline, Devin, and Poolside capability/telemetry/cancellation behavior.
- **TEST-006**: Run `node --import tsx --test test/blast-radius.test.ts test/adjacency-context.test.ts` for symbol extraction, callers, snippets, ranking, byte caps, omissions, caching inputs, and fail-open behavior.
- **TEST-007**: Run `node --import tsx --test test/diff-context.test.ts test/review-cost.test.ts` for predicted cost, affinity, auto shard count, complete union, deterministic balance, patchless behavior, and byte fallback.
- **TEST-008**: Run `node --import tsx --test test/runner.test.ts test/session-concurrency.test.ts` for phase wiring, deadline/cancellation, slot release, verifier priority, grace overlap, cache use, full filtering, and publication ordering.
- **TEST-009**: Run `node --import tsx --test test/shard-cache.test.ts` plus deterministic-cache tests for poisoning, corruption, versioning, concurrency, and cross-config misses.
- **TEST-010**: Run the smoke benchmark on every optimization PR; require zero P0/P1 misses and no new clean false positive.
- **TEST-011**: Run the core benchmark before merging an experiment implementation; attach the generated summary and comparability record.
- **TEST-012**: Run the full benchmark before changing a default, public input, backend policy, reasoning level, sharding algorithm, prompt contract, or inference runtime.
- **TEST-013**: For stochastic providers, run at least three repetitions per case/control/treatment and report variance/confidence intervals.
- **TEST-014**: Run local dry-review integration tests against small fully embedded, large omitted-hunk, large cross-file, patchless/binary, and same-head cache-hit scenarios.
- **TEST-015**: Run a live dogfood canary for each enforceable backend changed, read the posted review and telemetry artifact back, and verify exact head, complete run, valid anchors, no unresolved process, and no unexpected tool permission.
- **TEST-016**: Run `npm test`, `npm run typecheck`, `npm run lint`, `npm run format:check`, and `npm run build` before each phase is considered complete.
- **TEST-017**: For CI packaging changes, compare cold and warm jobs for full image, slim image, and in-process route; include fork PR and missing-secret behavior.
- **TEST-018**: For SGLang, run isolated load tests at concurrency 1, expected production concurrency, and overload; capture TTFT, decode, cache, GPU, queue, error, and quality metrics.
- **TEST-019**: Run security tests proving tool budgets, telemetry, deterministic caches, slim routes, and self-hosted serving cannot read outside approved scope, persist secrets/source, or accept PR-controlled cache results.
- **TEST-020**: Run rollback tests that switch every graduated experiment to the previous policy/version without cache collision or prompt mismatch.
- **TEST-021**: Reproduce `INC-001` with a provider-error control and auto-sharded/adaptive-reshard treatments; assert exact file union, deadline-aware retry, model-label correctness, no auxiliary-only posting, and full quality gates.
- **TEST-022**: Mark the PR merged, closed, and head-changed between a long failed main attempt and retry; assert no second provider call, `stale-before-retry` telemetry, no posting, and unchanged local-mode behavior.

## 7. Risks & Assumptions

- **RISK-001**: A hard exploration budget can suppress the one caller/test lookup needed for a high-severity finding. Mitigation: coverage exemptions, risk tiers, soft stop, conservative fallback, and full quality corpus.
- **RISK-002**: Prompt instructions may reduce redundant tools on one model but not another. Mitigation: report by backend/model and enforce only at controllable tool boundaries.
- **RISK-003**: More deterministic context can increase prompt prefill and dilute changed-code attention. Mitigation: rank, cap, disclose omissions, and A/B manifest-only versus snippets.
- **RISK-004**: Predicted-cost sharding may optimize historic providers and regress new ones. Mitigation: provider-specific coefficients, held-out validation, byte fallback, and versioning.
- **RISK-005**: Parallel shards or auxiliary sessions may hit upstream rate limits and increase p95. Mitigation: measured concurrency profiles, session caps, queue telemetry, and single-session fallback.
- **RISK-006**: Verification overlap can post late findings without verification. Mitigation: explicit late-unverified telemetry, blocking thresholds, automatic rejection, and serial fallback.
- **RISK-007**: Cancellation may race completion and lose a valid auxiliary result. Mitigation: settle result atomically before abort, treat abandoned aux as the existing fail-open fallback, and test races.
- **RISK-008**: Lower reasoning effort can produce large but subtle recall loss. Mitigation: fixed-model full-corpus gate, real PR canaries, severity-weighted scoring, and separate arm labels.
- **RISK-009**: Structured decoding can reject otherwise useful flexible output or differ by provider. Mitigation: capability detection, one plain-JSON fallback, existing sanitation, and repair telemetry.
- **RISK-010**: Cache reuse can serve results under a changed prompt, policy, or model option. Mitigation: exhaustive fingerprint inputs, version bump discipline, corruption tests, and exact comparability.
- **RISK-011**: Benchmark overfitting can make J-Bot excel on known cases but regress real work. Mitigation: held-out cases, counterfactuals, rotating real misses, blind adjudication, and limited prompt tuning.
- **RISK-012**: Human thread outcomes are noisy labels. Mitigation: keep reply valence neutral, require explicit signals/adjudication, and never use ignored findings alone as false-positive proof.
- **RISK-013**: Hosted providers can silently change model revisions or serving behavior. Mitigation: record revision when exposed, date every run, repeat controls, and label unknown revisions.
- **RISK-014**: Self-hosted SGLang can improve throughput while worsening single-review tail latency. Mitigation: gate on both p50/p95 review latency and fleet throughput, not throughput alone.
- **RISK-015**: Quantization/speculative decoding can alter output distribution and review quality. Mitigation: separate labels and full quality non-inferiority.
- **RISK-016**: Slim/in-process execution can weaken isolation relative to the container. Mitigation: explicit security comparison and retain full image where required.
- **RISK-017**: Tool-event APIs in installed SDKs may not expose enforcement hooks. Mitigation: capability matrix, observe-only classification, prompt policy, and absolute timeouts.
- **RISK-018**: Extensive experimental flags can create dead surface. Mitigation: internal-only flags, deterministic cohorts, decision log, and quarterly deletion pass.
- **ASSUMPTION-001**: The dominant controllable model-time costs remain repeated prefill/reasoning and agentic exploration, consistent with current telemetry and wall-clock audits.
- **ASSUMPTION-002**: At least one tool-capable backend exposes enough control to enforce byte/call budgets; Pi already uses J-Bot-owned custom tools.
- **ASSUMPTION-003**: The same-model benchmark can obtain adequate provider quota and stable enough revisions to characterize variance.
- **ASSUMPTION-004**: Exact same-head re-reviews and cancellation chains occur often enough for shard cache and cancellation work to have product impact.
- **ASSUMPTION-005**: Self-hosting is optional and proceeds only if model weights, hardware, ownership, reliability, and economics are available.

## 8. Related Specifications / Further Reading

- [Repository agent guide](../AGENTS.md)
- [Wall-clock latency audit](../docs/superpowers/audits/2026-08-06-wall-clock-latency-audit.md)
- [Review measurement loop design](../docs/superpowers/specs/2026-07-04-review-measurement-loop-design.md)
- [Incremental lens gating design](../docs/superpowers/specs/2026-06-28-incremental-lens-gating-design.md)
- [Review routing improvements](../docs/superpowers/plans/2026-06-28-review-routing-improvements.md)
- [SGLang repository](https://github.com/sgl-project/sglang)
- [SGLang model gateway and prefill/decode routing](https://github.com/sgl-project/sglang/blob/main/sgl-model-gateway/README.md)
- [SGLang hierarchical/radix cache benchmark documentation](https://github.com/sgl-project/sglang/blob/main/benchmark/hicache/README.md)
- [SGLang cache-aware scheduling implementation](https://github.com/sgl-project/sglang/blob/main/python/sglang/srt/managers/schedule_policy.py)
