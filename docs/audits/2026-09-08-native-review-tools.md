# Native review tools comparison

The native-tool implementation removes J-Bot's custom repository tools, but this
experiment does **not** establish a latency improvement. Keep the change in draft
pending the required default-policy benchmark and a rollout decision.

## Change under test

- Baseline: `0c75310`, fetched main; CommandCode tools disabled, its shipped default.
- Treatment: `e7e4ea0`; CommandCode native tools, Pi native read/search/bash, and
  OpenCode native tools with external-directory access allowed.
- Custom CommandCode and Pi tool implementations, pagination, and configuration
  plumbing are removed. Provider authentication and session deadlines remain.
- CommandCode runs in the checkout with `--yolo --permission-mode plan`. Installed
  CommandCode 1.44.0 inspection and a live smoke test confirmed that explicit plan
  mode takes precedence, while `--yolo` removes the separate headless gate that
  otherwise blocks even read-only shell commands. No J-Bot mod is loaded.
- Model-facing diff commands use `git diff`, because the native plan classifier
  rejects `git -c ... diff`. J-Bot's parser still uses its original formatting pins;
  revision scope and raw-diff flags are retained in the model-facing command.

## Comparison setup

One frozen FMS Frontend PR #2240 checkout was reviewed through the actual local
pipeline, with no GitHub posting. Its head was
`a3b2d011fa2071f3e13ed2d61a7a482caa0f2cb4`, base
`217e7bd9b42b453542270339e3f1e5498edf8e33`: 13 changed files,
1,019 additions and 155 deletions. Dependencies were not installed in the fixture.

Both main and auxiliary sessions used
`commandcode/meta/muse-spark-1.3-contributor`, CommandCode 1.44.0, medium requested
reasoning effort, two review passes, one shard, verification enabled, and maximum
session concurrency five. The overall budget was 30 minutes. Context trimming and
verification overlap were off in both arms. Existing interactions deadlines and
finding filters were unchanged. There was one measured attempt per final arm;
this is a diagnostic comparison, not a statistical quality benchmark.

Main, guidelines, interactions, and frontend started concurrently within each
arm. The baseline and final native arm ran separately. Earlier custom-tool and
native prototype processes were stopped before the final native arm started.

## Results

| Measurement            | Baseline: tools disabled | Native tools         |
| ---------------------- | ------------------------ | -------------------- |
| Total wall time        | 4m06s                    | **21m09s**           |
| Main                   | 2m54s, complete          | 16m07s, complete     |
| Guidelines             | 1m36s, complete          | 6m51s, complete      |
| Interactions           | 3m07s, complete          | **10m, timed out**   |
| Frontend               | 1m47s, complete          | 9m02s, complete      |
| Verification           | 56s, complete            | **5m, timed out**    |
| Retained concerns      | 3 P3, 2 unverified       | 3 P3, all unverified |
| Reported input tokens  | 215,581                  | At least 1,910,751   |
| Reported output tokens | 52,496                   | At least 138,786     |

The native run was **5.2 times slower**, with incomplete coverage. Its process
exited successfully because auxiliary failures are fail-open; that is not a
fully completed review. Native token totals exclude the timed-out interactions
and verifier sessions because their final usage was unavailable. Main alone
produced 13 assistant messages, 64,539 output tokens, and 28 completed tool calls.
The fixture checkout remained unchanged, and the temporary CLI home was removed.

The final native arm's assembled main prompt was 87,879 bytes versus 116,156 in
the baseline, about 24% smaller. Interactions was 79,802 versus 108,079 bytes,
about 26% smaller. These are actual backend prompt bytes, not the earlier
context-assembly estimate or the total conversation after tool calls.

Two diagnostic controls were stopped and are not completed-run timings:

- The old custom-tool implementation, explicitly enabled at the baseline
  revision, still had main and frontend running after 13m36s. Guidelines completed
  in 5m02s and interactions in 6m59s. Cancellation triggered a main retry, which
  was also stopped; driver teardown time is excluded from the comparison.
- The first native prototype exposed the headless shell gate and `git -c`
  rejection. It was stopped, fixed, and replaced by the final native run. Its
  timing is not evidence for the final implementation.

## Interpretation

Native tools successfully read files, search code, run git, and fetch external
documentation. Removing custom wrappers therefore fixes the integration and
reduces maintenance, but does not by itself make the model finish sooner.

The native run makes repeated model turns with substantial generated output.
Main also followed a dependency-documentation path: a TanStack documentation URL
redirected to a general page, then two guessed source/documentation URLs returned 404. These are observable model investigation costs, not J-Bot wrapper failures.
Tool results alone do not establish how much elapsed time belongs to model
generation, provider scheduling, or CLI processing. Persisted transcript timestamps
are not reliable per-tool latency measurements, and stream event counts are not
assistant turn counts.

The baseline retained three P3 concerns. Its cache-wiping hypothesis is unsupported:
TanStack Query's `setQueryData` returns early when an updater returns `undefined`.
The entity-parent compatibility concern needs backend-contract evidence. The
silent Undo path is supported by the fixture: when `buildChartAccountUndo` returns
`undefined`, clicking the offered action produces no feedback. Native main repeated the cache-wiping hypothesis despite its external investigation.
Native frontend also found that Undo path. Its filtered-cache concern is not yet established as a
distinct actionable defect. Verification timed out, so the pipeline retained all
three native concerns as unverified, including the incorrect cache-wiping claim.
This run shows no demonstrated quality gain to offset the latency regression.

## Validation and release status

- Self-review and de-slop completed; obsolete wrapper tests and prompt assertions
  were removed or updated to the native-tool contract.
- Changed retained comments: two kept (CLI permission behavior and native git
  classification), one rewritten (parser formatting pins). Obsolete wrapper
  comments and the redundant local-diff explanation were cut.
- Tests: 12 obsolete wrapper cases cut; two Pi prompt cases folded into one;
  three existing cases renamed for the changed contract. No new test cases.
- 1,012 tests passed; formatting, typecheck, lint, and bundle build passed.
- Full and slim Docker images built successfully without the deleted mod artifact.
- Installed Pi SDK smoke: native `read`, `bash`, `grep`, `find`, and `ls` registered;
  actual read and bash execution passed without a provider call.
- Installed OpenCode smoke: native tools registered, external-directory permission
  allowed, edit permission denied; no provider call.
- Live CommandCode smoke: native git diff completed in headless plan mode.
  Docker smoke also exercised git in a foreign-owned checkout with the same
  process-level `safe.directory` configuration.

The [self-review skill](../../.agents/skills/jbot-review-pr-self-review/SKILL.md)
requires default-policy flips to have `subset: "full"` with
`mergeGateSatisfied: true`. That full, adjudicated corpus has **not** run.
This single-fixture diagnostic does not satisfy that merge gate. No
benchmark-ledger pass is claimed, and the branch is not validated as a performance
improvement or ready for release.

## Follow-up: native event timing

CommandCode now logs each native tool's running-to-terminal interval and each
model request's start-to-end interval, with unfinished intervals retained on abort.
These are monotonic event-receipt timings, not CPU measurements. Model requests
also report input/output tokens when supplied by the CLI. No tool hooks or mods
are introduced.

A short Muse 1.3 Contributor smoke ran native `git diff --stat` on the same
fixture: shell execution took approximately **26 ms**, and the two model requests
took **4.4 s** and **17.1 s**. This validates the logger, not the cause of the full
21-minute review. The earlier review was not rerun. Follow-up validation: 1,013
tests, typecheck, lint, formatting, and build passed.
