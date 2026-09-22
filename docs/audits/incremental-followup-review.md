# Incremental follow-up experiment

Date: 2026-09-22. Model: `opencode/mimo-v2.6-flash-free`, native OpenCode 2.0.5.

## Decision

Follow-up reviews automatically select incremental scope when the baseline and impact checks pass, as requested. The small matched comparison preserved both seeded root causes and reduced average wall time, but the cross-file case was slower in two of three pairs. This does not establish a universal speedup or production recall.

Dynamic fan-out remains enabled by default. No new Action input, environment variable or runner option is needed. First reviews, explicit reruns, auto-approval and the existing `skip-unchanged: false` setting use full review.

## Method

A real full review first established a clean baseline over eight committed utility files. Each scenario then changed one existing file. Both arms ran `runPrReview`, including normal finding verification, against the same base/head, model and settings. No GitHub calls or posting were used.

- Three repetitions per scenario, nine matched pairs (18 runs), plus the initial baseline.
- Main/auxiliary/verification: the same free MiMo model; requested effort `low`.
- `reviewPasses: 2`, dynamic fan-out on, concurrency 3, five-minute budget, prompt caching on, Context7 off, guideline pass off (fixture has no guidelines).
- Order alternated by repetition. Provider cache and queue state were not controlled.
- Full review delivered all eight PR files. Incremental delivered one file for direct/clean changes and two for the cross-file change, including the caller from the earlier PR commit.
- Selected files received their complete base-to-head patches. Every mandatory task completed, with no incomplete sessions or withheld candidates.

The treatment changes both finder scope and auxiliary scheduling: the smaller selected scope qualifies for the existing minimal fan-out. These results do not isolate the benefit of narrowing main-review input.

## Results

| Scenario   | Full / incremental seconds, by pair    | Incremental faster | Median paired difference |
| ---------- | -------------------------------------- | ------------------ | ------------------------ |
| direct     | 37.6 / 19.9; 43.8 / 22.2; 38.1 / 25.0  | 3/3                | -17.7s                   |
| cross-file | 89.7 / 31.7; 75.5 / 134.4; 29.2 / 38.3 | 1/3                | +9.1s                    |
| clean      | 59.0 / 13.9; 90.4 / 27.5; 35.9 / 4.1   | 3/3                | -45.1s                   |

Across all nine pairs, average wall time was **55.5s → 35.2s** (−36.5%). Incremental won **7/9 pairs**; the median paired difference was **−21.6s**. Reported input tokens averaged **75,663 → 44,233**, and observed tool calls averaged **8.1 → 2.6**.

The 134.4s incremental outlier spent 130.1s in main review, 3.2s in verification and about 1.0s in context assembly. Only two native tools were observed (361ms and 164ms); these traces do not establish whether the remaining delay was upstream queueing or model/API processing.

Quality was manually checked by root cause, not by matching titles:

- Direct regression: removing the zero clamp allowed negative payable amounts. Both arms caught it in all **3/3** repetitions.
- Cross-file regression: the modified helper returned zero for a one-item remainder; the earlier `drain` caller stopped advancing and looped forever. Both arms caught it in all **3/3** repetitions.
- Clean follow-up: changing an inactive display label. Both arms returned **zero findings in 3/3** repetitions.
- Full review sometimes emitted duplicate reports of the cross-file root cause. Both arms sometimes assigned P0 to that synthetic defect; these runs do not establish good severity calibration.

## Limits and fallback behavior

This first implementation accepts only bounded modifications to existing JavaScript/TypeScript files. It widens through declarations, static relative imports and same-directory files in both snapshots. Unknown syntax/dependencies, default exports, unresolved relative imports, references outside the PR, added/deleted/renamed files, contract edits, broad impact, missing history, policy/base changes, open findings and tool-less reviewers fall back to full review. Impact lookup has a five-second Git budget and a two-MiB source budget.

Reports identify incremental scope and file counts. A separate completion marker prevents existing full-review skip and compaction paths from treating incremental coverage as full coverage. Run telemetry includes the baseline, reason, selected/total files and patch bytes, and planning time. Incomplete or unverified results cannot become a baseline. Quiet clean reviews leave the last posted baseline in place, so the next review includes intervening commits.

This is a small synthetic follow-up experiment, not the full quality corpus or a production FMS performance benchmark. The full quality corpus was not run, following the earlier request to defer it; the repository normally requires that gate for default-policy changes. The matched runs below are narrower evidence, not a substitute for that gate. No public Action wrapper change is needed.

## Reproduce

```sh
node --env-file=.env --import tsx scripts/incremental-review-compare.ts
```

The ignored output directory contains every result, review body, log and telemetry file. Initial comparison: `.jbot-review/incremental-comparison/`. Raw `results.json` SHA-256: `e33869f60572b3f49a61ffc75341880d5e486d38ecf757e9a750282aaee63e31`.

The repeated comparison preceded conservative self-review additions for unresolved imports and references outside the PR. Those additions leave these fixtures eligible with the same scopes. A final pipeline smoke test checks the current code separately; its timings are not pooled into the paired comparison.

The final smoke test's full-review control completed and verified the seeded bug,
but its interactions pass timed out: **257.6s**, eight of eight mandatory hunks
delivered, incomplete auxiliary coverage, and **no reusable baseline emitted**.
This result is recorded separately from the nine matched pairs above.
The incremental arm completed in **138.6s**, delivered both selected hunks, and
verified the same cross-file root cause. It had no incomplete sessions or withheld
candidates and emitted a reusable baseline. This additional pair exercises the
final impact guards; it does not remove the latency variability seen above.

## Validation and self-review

All 1,123 tests pass, as do typecheck, lint, build and changed-file formatting.
One earlier full-suite run timed out starting the ACP test gateway; that test
passed alone and the complete suite passed on the subsequent run. No gateway
code changed.

Self-review found no remaining P1/P2 issues. The review traced baseline provenance,
impact selection, complete selected-file delivery, finding verification, report
markers, telemetry and Action/app configuration. The final marker adjustment was
checked deterministically; it does not change model input.

De-slop removed repeated metadata assembly and explanatory boilerplate. Four
remaining comment blocks were adjudicated: three kept for non-obvious fallback
reasons, one cut. Three new tests were kept: baseline/marker provenance, aliased
cross-file impact, and real-Git fallback behavior. Defaults and report rendering
assertions were added to existing cases.

## Automatic-default smoke test

After removing the toggle, a fresh full baseline completed in 84.5s. The native
MiMo runs used the same model/settings as above, with no incremental option:

| Case            | Full review                                                                      | Automatic incremental review                      |
| --------------- | -------------------------------------------------------------------------------- | ------------------------------------------------- |
| Cross-file bug  | Main timed out at 135.0s; auxiliary found the bug, but mandatory coverage failed | 29.0s; 2/8 files selected; bug found and verified |
| Clean follow-up | 82.5s; 8/8 files; zero findings                                                  | 30.2s; 1/8 files; zero findings                   |

Both incremental runs completed all assigned hunks with no incomplete sessions
or withheld candidates. The failed control is not counted as a successful latency
comparison. No timeout or model setting was changed for the continuation.
Artifacts: `.jbot-review/incremental-default-smoke/` and
`.jbot-review/incremental-default-continue/`.

All 1,123 tests and typecheck/lint/build passed again. De-slop removed the toggle
from Action, environment, workflow, app, runner and telemetry configuration;
those configuration files now match main. No test cases or code comments were
added in this follow-up. The removed toggle assertions describe a contract that
no longer exists; baseline selection and fallback assertions remain.

## Review feedback validation

The follow-up fixes require verification to be enabled before emitting a reusable
baseline, preserve incremental markers during resolved-review compaction, and
fall back to full review for default exports or unresolved relative imports. The
bounded file map now keeps complete UTF-8 filenames. Comparison manifests record
the implementation HEAD and dirty-worktree status.

Native `opencode/mimo-v2.6-flash-free` validation on the updated worktree:

- Normal incremental follow-up: **34.6s**, 2/8 files selected, the cross-file bug
  found and verified, all assigned hunks delivered, reusable baseline emitted.
- Verification disabled: **24.1s**, full review after the policy change, two
  candidates returned, verification recorded as skipped, **no baseline emitted**.

Artifacts: `.jbot-review/incremental-feedback-smoke/`. Its manifest records
`84ff078776247d3c9ed0a40bed46f4a8a49726e1` with `dirty: true`, since validation
preceded the feedback commit. The later filename-boundary adjustment was checked
deterministically and does not affect this fixture's short file map.

All 1,123 tests, typecheck, lint and build passed. Self-review found no remaining
P1/P2 issue. No new comment blocks or test cases were added; regression assertions
were folded into the existing provenance, impact and fallback cases. No new
policy layer, dependency resolver or public option was added.
