# Auxiliary guideline budget repair

September 21, 2026. Base: `d81cb17058d00500b4a877c00b81c80e20d26fd5`.

Released runs could fail interactions and compliance before calling a model:
roughly 98 KB of guidelines exceeded the unknown-model input allowance of
87,040 bytes even before instructions and diff evidence. Compliance shared the
interactions task, so that planning error marked both passes failed.

The repair partitions the rendered guideline bundle at source-fragment boundaries
when it cannot fit. Each part receives the complete assigned diff, paged by the
existing diff planner. Existing session limits and deadlines still apply.
Explicitly unmatched `.mdc` scopes are excluded; global and unknown scopes stay.
Known model and transport limits replace the blanket 120 KiB ceiling. Unknown
models keep the conservative fallback, and Cline keeps its argument-size limit.

## Local evidence

OpenCode v2.0.5 drove the real local review pipeline. The regression fixture had
one changed TypeScript hunk, an unchanged caller, and a **97,590-byte rendered
guideline bundle**. Removing the empty-cart guard made `meanPrice([])` return
`NaN` instead of the documented `0`.

Control and treatment used `opencode/muse-spark-1.3-contributor-free`, concurrency
3, two requested review passes, verification enabled, a ten-minute budget, and
`diff-batches`. Dynamic fan-out was disabled in the fixture runs so the tiny diff
would exercise both auxiliary passes. No GitHub comments were posted.

| Measurement                 | Main control                | Repair                                                            |
| --------------------------- | --------------------------- | ----------------------------------------------------------------- |
| Interactions                | Failed before dispatch      | Two pages completed                                               |
| Compliance                  | Failed with interactions    | Completed with interactions                                       |
| Assembled auxiliary prompts | No dispatch                 | 64,692 and 64,706 bytes                                           |
| Diff delivery               | Complete main task          | Complete main task and both auxiliary pages                       |
| Seeded defect               | Retained after verification | Retained after verification; duplicate auxiliary findings deduped |
| Incomplete sessions         | 2                           | 0                                                                 |

A separate clean fixture preserved the empty-cart guard while replacing the
reduction with a loop. With `opencode/mimo-v2.5-free` and one requested review
pass, standalone compliance completed both pages (57,626 and 57,640 bytes).
Main and compliance returned **zero findings**, with no incomplete sessions.
All model sessions in these three runs reported **$0**.

The free Muse Spark review of this branch found one valid P2: an initial splitter
assumed source labels ended in `.md` or `.mdc`. The fix uses discovered labels,
including `.cursorrules`, `.windsurfrules`, `.coderabbit.yaml`, and `greptile.json`.
A subsequent live fixture with a **98,241-byte** bundle from those root files
completed both auxiliary pages (64,818 and 65,231 bytes) with no incomplete
sessions. It retained two differently anchored reports of the same seeded bug;
this repair does not change duplicate suppression across line-level and orphaned
findings. The additional model sessions also reported $0.

These runs establish dispatch and completion for the reproduced failure; they
are not a latency benchmark. Restoring previously skipped work can take longer,
and provider latency/cache state were not controlled. The rendered guideline
bundle is conserved across tasks; discovery's existing file/candidate/render
limits and omission notices remain in place.

## Validation and limits

- 1,124 tests passed, plus typecheck, lint, formatting, and build.
- Regression tests conserve the guideline text and seven complete diff hunks for
  both combined and standalone prompt assembly. They also check model versus
  transport limits, scope selection, non-Markdown source fragments, and dispatch
  with each page's own rules.
- Self-review and de-slop: two comment blocks kept for the unknown-scope and
  fragment-boundary constraints; two new tests kept for distinct planner and
  dispatch regressions. Other assertions were folded into existing tests.
- The advisory three-repetition quality corpus was not run. These targeted free
  model runs do not establish broad recall/precision equivalence.
- The original production runs have not been rerun with this branch. Production
  validation must inspect their new coverage logs after release.
