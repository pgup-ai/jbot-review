---
goal: Add the J-Bot runtime contract required by the arena model comparison workflow
version: 1.0
date_created: 2026-08-29
last_updated: 2026-08-29
owner: J-Bot maintainers
status: 'Completed'
tags: [feature, arena, model-comparison, local-review, docker]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

This plan implements the J-Bot-owned foundation for arena model comparisons on a fresh branch from `origin/main`. The separate arena repository is intentionally deferred until this versioned contract is merged and its full-SHA image is published.

## 1. Requirements & Constraints

- **REQ-001**: Accept arena mode only when `--pr-context <comparison.json>` and `--output <jbot-output.json>` are supplied together.
- **REQ-002**: Validate the complete version-1 comparison manifest before resolving provider credentials or starting model sessions.
- **REQ-003**: Require the checked-out `HEAD` to equal the frozen target head SHA, require a clean worktree, and compute the review diff from the merge base of the frozen base SHA and `HEAD`.
- **REQ-004**: Use the manifest target owner, repository, PR number, title, and body without reading target comments, review threads, checks, or mutable branch tips.
- **REQ-005**: Require one selected model in arena mode and require it to match one requested manifest model; use that same model for main and auxiliary sessions.
- **REQ-006**: Use only the frozen manifest review configuration in arena mode. Do not reread mutable review-knob environment variables.
- **REQ-007**: Emit versioned `JbotArenaOutputV1` for completed, skipped, and caught J-Bot failures; preserve the existing interactive local behavior when arena flags are absent.
- **REQ-008**: Aggregate session telemetry with independent reporting-session counts per token metric and provider-cost precedence over configured estimates.
- **REQ-009**: Write arena output and `telemetry.jsonl` only beneath the absolute output parent outside the reviewed workspace.
- **REQ-010**: Bundle `src/local/index.ts` as `dist/local/index.js` in the existing image without changing its default app-server entrypoint or removing any SDK/CLI.
- **SEC-001**: Persist only scrubbed, newline-collapsed, 512-byte failure messages; never persist credentials or raw unbounded provider errors.
- **SEC-002**: Keep reviewed-repository OpenCode config disabled, keep session credential scrubbing enabled, and never add GitHub posting capability to local/arena mode.
- **CON-001**: Preserve full-diff scope, downstream filtering, auxiliary fail-open behavior, and all repository invariants in `AGENTS.md`.
- **CON-002**: Add no dependency; use Node APIs and existing repository helpers.
- **CON-003**: Keep `src/shared/runner.ts` unchanged; new validation and aggregation logic must be pure and unit-tested.
- **CON-004**: The arena repository parser, matrix wrapper, artifact publisher, safe comment renderer, and GitHub workflow are out of scope until this contract is merged and the pinned image exists.
- **PAT-001**: Reuse `resolveModelSelection`, `selectReviewBackends`, `supportedModelOptions`, `parseGitDiff`, and the existing telemetry JSONL schema.

## 2. Implementation Steps

### Implementation Phase 1 — Versioned arena contracts

- GOAL-001: Define and test the trust-boundary types, manifest validation, telemetry aggregation, and output serialization.

| Task     | Description                                                                                                                                                                                                                                                                                        | Completed | Date       |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-001 | Create `src/local/arena-contract.ts` with `ComparisonManifestV1`, `JbotArenaOutputV1`, failure/status/usage types, complete manifest validation, one-model selection validation, metric aggregation, failure classification, bounded message scrubbing, and atomic JSON output.                    | ✅        | 2026-08-29 |
| TASK-002 | Add `test/local-arena-contract.test.ts` covering valid same-repo/fork manifests, every required-field rejection class, model mismatch/pool rejection, independent token completeness, actual-versus-estimated cost precedence, completed/skipped/failure invariants, and secret/message scrubbing. | ✅        | 2026-08-29 |
| TASK-003 | Amend `docs/superpowers/specs/2026-08-29-arena-model-comparison-design.md` so `reviewConfig.sdkEngine` is frozen as `auto` or `opencode`, matching the implementation boundary.                                                                                                                    | ✅        | 2026-08-29 |

### Implementation Phase 2 — Frozen PR input and structured output

- GOAL-002: Integrate arena mode into the local entrypoint without changing ordinary `review:local` behavior.

| Task     | Description                                                                                                                                                                                                                                                                     | Completed | Date       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-004 | Extend `src/local/args.ts` and `test/local-args.test.ts` with paired `--pr-context`/`--output` flags, absolute arena path resolution, and rejection of output paths inside the reviewed workspace.                                                                              | ✅        | 2026-08-29 |
| TASK-005 | Update `src/local/index.ts` to load the manifest before credential resolution; enforce exact `HEAD`, clean worktree, frozen base merge-base, target metadata, one-model identity, same-model auxiliaries, and manifest-only review options.                                     | ✅        | 2026-08-29 |
| TASK-006 | Update `src/local/index.ts` to write skipped output before provider use, completed output after persisted telemetry is available, and caught serialized failures after backend resolution while retaining nonzero exit status.                                                  | ✅        | 2026-08-29 |
| TASK-007 | Extend `test/local-workspace.test.ts` with credential-free arena integration cases for exact-head/frozen-base success through preview-free skip paths, dirty/mismatched-head rejection, fork metadata parsing, output-location isolation, and unchanged default local behavior. | ✅        | 2026-08-29 |

### Implementation Phase 3 — Image bundle and validation

- GOAL-003: Make the arena-safe local entrypoint available in the existing SHA-tagged image.

| Task     | Description                                                                                                                                                                                                                           | Completed | Date       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-008 | Add `src/local/index.ts -> dist/local/index.js` to `scripts/build.ts`; keep the existing image entrypoint unchanged.                                                                                                                  | ✅        | 2026-08-29 |
| TASK-009 | Add build/image smoke assertions in `.github/workflows/build.yml` and `Dockerfile` that `dist/local/index.js` exists while preserving all existing provider binary checks.                                                            | ✅        | 2026-08-29 |
| TASK-010 | Run focused tests, full tests, typecheck, lint, formatting check, build, bundled-entrypoint smoke, and a final diff audit; record that no quality-corpus benchmark is required because prompts and finding disposition are unchanged. | ✅        | 2026-08-29 |

## 3. Alternatives

- **ALT-001**: Install J-Bot and provider CLIs dynamically in each arena worker. Rejected because the existing image already contains the supported tooling and a pinned image is faster and more reproducible.
- **ALT-002**: Add a second arena-only review pipeline. Rejected because it would drift from the real local review pipeline and violate reuse/thin-runner conventions.
- **ALT-003**: Build the arena repository first against an unpublished contract. Rejected because its producer/consumer schemas and image entrypoint would chase moving J-Bot behavior.

## 4. Dependencies

- **DEP-001**: Approved design at `docs/superpowers/specs/2026-08-29-arena-model-comparison-design.md`.
- **DEP-002**: Existing local review pipeline in `src/local/index.ts` and `src/shared/runner.ts`.
- **DEP-003**: Existing full-SHA image publication in `.github/workflows/build.yml`.
- **DEP-004**: Arena repository creation after this branch is merged and its image is published.

## 5. Files

- **FILE-001**: `src/local/arena-contract.ts` — new versioned contracts, validation, telemetry aggregation, and output helpers.
- **FILE-002**: `src/local/args.ts` — arena flags and output-path rules.
- **FILE-003**: `src/local/index.ts` — frozen context and output integration.
- **FILE-004**: `scripts/build.ts` — bundled local entrypoint.
- **FILE-005**: `Dockerfile` — bundled-entrypoint image smoke check.
- **FILE-006**: `.github/workflows/build.yml` — build artifact smoke check.
- **FILE-007**: `test/local-arena-contract.test.ts` — pure contract tests.
- **FILE-008**: `test/local-args.test.ts` — argument/path tests.
- **FILE-009**: `test/local-workspace.test.ts` — credential-free integration tests.
- **FILE-010**: `docs/superpowers/specs/2026-08-29-arena-model-comparison-design.md` — frozen SDK-engine contract clarification.

## 6. Testing

- **TEST-001**: `node --import tsx --test test/local-arena-contract.test.ts test/local-args.test.ts test/local-workspace.test.ts`.
- **TEST-002**: `npm test`.
- **TEST-003**: `npm run typecheck`.
- **TEST-004**: `npm run lint`.
- **TEST-005**: `npm run format:check`.
- **TEST-006**: `npm run build` followed by `test -s dist/local/index.js` and a no-provider argument-error smoke invocation of the bundle.
- **TEST-007**: `git diff --check` and a final updated-diff audit against `origin/main`.

## 7. Risks & Assumptions

- **RISK-001**: Arena mode could accidentally inherit mutable environment knobs. Mitigation: construct every review option from validated `comparison.json` and pin SDK-engine selection in the manifest.
- **RISK-002**: A skipped run may occur before backend resolution. Mitigation: make backend/options nullable and emit zero-session unavailable telemetry.
- **RISK-003**: Telemetry may be partial across heterogeneous providers. Mitigation: track reporting sessions independently for every metric and cost.
- **RISK-004**: A caught provider error may contain credential-bearing URLs. Mitigation: redact credential-shaped values, collapse newlines, and enforce the UTF-8 byte cap.
- **ASSUMPTION-001**: Arena workers will clone/fetch the frozen base and head objects before invoking this entrypoint.
- **ASSUMPTION-002**: The future arena wrapper will own checkout/image/credential/external-timeout/signal/exit synthesis and merge J-Bot output into `ArenaResultV1`.
- **ASSUMPTION-003**: The separate arena repository will resolve the published full-SHA tag to one digest before matrix fan-out.

## 8. Related Specifications / Further Reading

- `docs/superpowers/specs/2026-08-29-arena-model-comparison-design.md`
- `AGENTS.md`
- `plan/review-quality-corpus.md`
