# Review performance containment

Control: `d3a29f9` (merged PR #206). The September 8 consumer audit found
CommandCode/GLM main sessions lasting 22–28 minutes, CommandCode/Muse interactions
hitting ten-minute timeouts, and a main JSON repair spending another 205 seconds
on repository tools before verification ran out of time. Luna and OpenCode
sessions sometimes completed quickly on larger prompts, so initial payload size
alone does not explain the regression.

## Changes

- CommandCode repository investigation is opt-in across Action, local, app,
  worker, and normalized options. Legacy comparison manifests retain tools enabled
  when the field is omitted; explicit manifest values still win. OpenCode/Pi tools and complete-diff coverage remain intact.
- Embedded-first guidance asks for targeted investigation and a stopping condition,
  without restoring the old aggregate tool/read quotas.
- Main and auxiliary CommandCode JSON repairs start fresh, block tools in the
  generated mod, and share the original deadline without a separate repair ceiling.
  The original main session remains available for an enabled guideline sweep.
- Main attempts and retries receive the absolute deadline already calculated by
  the runner. Finders reserve up to five minutes for available, enabled verification and
  30 seconds for posting; verification gets at most half the usable budget on
  short runs. The default 30-minute budget gives finders 24.5 minutes.

Consumer model-pool edits, auxiliary payload reductions, and re-enabling tools
remain separate measured rollout steps. No consumer variables were changed.

## Validation

All 1,023 tests, typecheck, lint, formatting, and build passed. Existing cases
exercise generated-mod tool denial, fresh repair identity, expired repair budgets,
main/retry deadline propagation, explicit tool opt-in, and configuration hashes.
A live CommandCode/Luna repair-mod smoke returned valid JSON in 2,513 ms. It used
no reviewed repository and is not a recall/precision measurement.

Self-review found no additional material issue. De-slop: one comment block
rewritten, no new test cases, obsolete resume assertions removed. Code, test,
and README delta before this audit: +80 lines.

The required full git-fixture corpus with three repetitions and adjudication
has not run. This branch is not merge-ready under the default-policy gate in
AGENTS.md. The next comparison must pin the same PR, model, and revision per arm,
and report completion, verified findings, false positives, wall time, and
cumulative token usage before recommending a new default-on tooling policy.

Follow-up skill review: removed an impossible resumed-repair condition from the
CLI fixture. All 196 focused tests passed after cleanup. No new production issue,
comment block, or test case was added; the full-corpus gate remains outstanding.
