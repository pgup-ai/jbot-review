---
goal: Add explicit external-workspace and base-ref inputs to local review
version: 1.0
date_created: 2026-08-23
last_updated: 2026-08-23
owner: jbot-review
status: 'Completed'
tags: [feature, local-review, git, research]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

Add `--workspace` and `--base` to `npm run review:local` so a caller-prepared
external Git checkout can use the existing dry-run review pipeline without
jbot-review cloning, fetching, or switching the target repository.

## 1. Requirements & Constraints

- **REQ-001**: `--workspace <path>` selects an existing non-bare Git worktree and normalizes it to its top-level directory.
- **REQ-002**: `--base <ref>` takes precedence over `JBOT_LOCAL_BASE`; existing base fallback behavior remains unchanged.
- **REQ-003**: Existing merge-base-to-working-tree diff semantics, preview behavior, and gateway committed-HEAD behavior remain unchanged.
- **REQ-004**: No-argument `review:local` behavior and report content remain unchanged.
- **SEC-001**: Load exactly one `.env` from the captured launch root; never load another `.env` after changing to a distinct target workspace.
- **SEC-002**: The command must not clone, fetch, switch branches, call GitHub, or run target-provided setup/build/test commands.
- **CON-001**: Resolve driver-owned artifacts from the captured launch root so external target status is unchanged.
- **CON-002**: Add no dependency and keep `src/shared/runner.ts` thin.
- **PAT-001**: Put parsing and path resolution in a pure local module with unit tests; keep process and Git side effects in `src/local/index.ts`.

## 2. Implementation Steps

### Implementation Phase 1

- GOAL-001: Implement the local invocation and artifact-root contracts.

| Task     | Description                                                                                                                                                                                                | Completed | Date       |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-001 | Add `src/local/args.ts` with pure parsing for `--workspace`, `--base`, and `--preview`, including unknown-argument and missing-value errors.                                                               | ✅        | 2026-08-23 |
| TASK-002 | Update `src/local/index.ts` to capture `launchRoot`, load its `.env`, validate and normalize the selected Git worktree, change cwd before Git/context work, and pass the explicit base into `resolveBase`. | ✅        | 2026-08-23 |
| TASK-003 | Resolve built-in artifacts and relative `JBOT_BENCHMARK_OUTPUT` from `launchRoot`; pass an explicit artifact directory through ordinary and gateway-isolated telemetry paths.                              | ✅        | 2026-08-23 |
| TASK-004 | Add an optional telemetry output directory to the shared review options while preserving the workspace-local default for every existing caller.                                                            | ✅        | 2026-08-23 |

### Implementation Phase 2

- GOAL-002: Pin compatibility and document the supported command.

| Task     | Description                                                                                                                                                                         | Completed | Date       |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| TASK-005 | Add parser/path unit tests and a spawned temporary-Git-repository preview integration test covering target selection, dotenv isolation, base failures, and unchanged target status. | ✅        | 2026-08-23 |
| TASK-006 | Update the README local-review section with the `--workspace`/`--base` command, manual-checkout responsibility, output ownership, and explicit non-goals.                           | ✅        | 2026-08-23 |
| TASK-007 | Run focused tests, full tests, typecheck, lint, format check, build, and a credential-free external-worktree preview smoke run.                                                     | ✅        | 2026-08-23 |

## 3. Alternatives

- **ALT-001**: Document the current absolute-`tsx` cross-repository command only; rejected because it is easy to run with the wrong cwd.
- **ALT-002**: Accept a PR URL and own clone/fetch/checkout/GitHub metadata; rejected because it adds unrelated network and authentication responsibilities.

## 4. Dependencies

- **DEP-001**: Existing Node.js path/process/child-process APIs.
- **DEP-002**: Existing Git CLI and local review pipeline.

## 5. Files

- **FILE-001**: `src/local/args.ts` — pure argument and launch-relative path parsing.
- **FILE-002**: `src/local/index.ts` — bootstrap, Git-root validation, cwd, base, and artifact wiring.
- **FILE-003**: `src/shared/runner.ts` — optional telemetry output directory.
- **FILE-004**: `test/local-args.test.ts` — pure parser/path tests.
- **FILE-005**: `test/local-workspace.test.ts` — external-worktree preview integration tests.
- **FILE-006**: `README.md` — supported usage and boundaries.

## 6. Testing

- **TEST-001**: Parse valid arguments and reject unknown, duplicate, and missing-value arguments.
- **TEST-002**: Prove explicit CLI base precedence over environment fallback.
- **TEST-003**: Prove relative workspaces and output paths resolve from launch root.
- **TEST-004**: Prove preview reads diff/guidelines from the target while ignoring a distinct target `.env`.
- **TEST-005**: Prove preview and artifact resolution do not add files to the target checkout.
- **TEST-006**: Prove invalid workspace/base failures occur before credentials or sessions.
- **TEST-007**: Preserve existing local, gateway, telemetry, and report tests.

## 7. Risks & Assumptions

- **RISK-001**: A post-`chdir` relative path can redirect output into the target; resolve all launcher-owned paths before changing cwd.
- **RISK-002**: Gateway cleanup can copy telemetry into the target unless it consumes the same explicit artifact root.
- **RISK-003**: Global `process.chdir` can leak between in-process tests; exercise bootstrap through spawned processes.
- **ASSUMPTION-001**: The caller has already fetched the desired base and checked out the intended branch or PR head.

## 8. Related Specifications / Further Reading

[External-checkout local review design](./external-local-review-workspace-design.md)
[Local review documentation](../README.md#local-review)
