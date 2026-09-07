# Startup fetches and changes-since summary

This change overlaps the enhanced-context commits, linked issues, and check-status
fetches after the existing skip gates (TASK-084). It also removes full PR context
from the changes-since summary contract across every backend (a narrow TASK-065
slice). Main review and finding-related auxiliary inputs remain unchanged.

## Startup probe

Six read-only batches used the existing GitHub helpers on PR #203 at
`20704a75bc22a63e61f1e5eee4fb01ea1f38a4ac`, alternating serial/parallel ordering.
All six returned the same hash of the assembled results.

| Execution | Batch durations (ms) | Median (ms) |
| --------- | -------------------- | ----------- |
| Serial    | 1175, 842, 864       | 864         |
| Parallel  | 472, 359, 343        | 359         |

These measure only the three-request batch, not total startup or review latency.
Network and server caching affect this small sample. Request count is unchanged.

## Summary probe

Four live OpenCode calls used `opencode/muse-spark-1.3-contributor-free` with
medium effort against a fixed checkout of PR #203. Control used the old assembler
with representative PR context constructed from its title and full diff, rather
than a captured production prompt. Treatment supplied only the existing bounded
delta context and shared untrusted-content warning.

| Delta                        | Control bytes / seconds | Treatment bytes / seconds |
| ---------------------------- | ----------------------- | ------------------------- |
| `b7319f8..20704a7` (cleanup) | 18,390 / 16.99          | 2,545 / 6.04              |
| `a91dda5..b7319f8` (report)  | 18,388 / 70.28          | 2,543 / 10.16             |

Call order was cleanup control, cleanup treatment, report treatment, report
control. All completed. Manual comparison against the two diffs found no
out-of-range claims. The cleanup treatment omitted the detail that the repeated
test artifact lacked a run header; the control included it. Prompt bytes fell
about 86%, but two pairs cannot establish equivalent summary quality or a reliable
latency improvement. These calls exercised the agentic summary path; deterministic
tests cover assembly of the single-shot variant.

## Validation and limits

Format, typecheck, lint, build, and all 1,048 tests passed at `ff6bb5a`. The new
startup test catches serialized requests while preserving a fatal commits error.
Existing prompt tests retain output-order and single-shot constraints and check
that the untrusted-content warning precedes the delta.

A local CommandCode Muse review of the implementation completed in 38 seconds
with main, interactions, and guideline sessions completed and zero findings.
Local mode skipped the re-review summary and GitHub posting; the separate probes
above exercised the changed paths. No production workflow validation is claimed.

The advisory three-repetition core quality benchmark was not run. These targeted
summary probes are not a corpus quality gate. No model, concurrency, or finding
policy defaults changed.
