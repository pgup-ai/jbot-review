# Reusing completed auxiliary reviews on documentation follow-ups

This experiment keeps the complete base...head main review and verification.
It tests whether a successful auxiliary pass needs to repeat after a routine
documentation follow-up. A separate caller-evidence trial did not improve
verification and was removed. `diff-batches` remains the default; `adaptive` is opt-in through
the existing `JBOT_REVIEW_EXPERIMENT` selector.

## Why this experiment

The [inspected hosted run](https://github.com/pgup-ai/jbot-review/actions/runs/35541762958/job/106160591167)
at `1d8013b` completed all 284 main-review hunks in 39 pages. The 32-page
interaction pass also completed, sharing guideline checking. Its 534.8 seconds
included queue time: the first auxiliary page waited 271.5 seconds; individual
executions had a 23.4-second median and a 92.6-second maximum. The main review
took 362.7 seconds, followed by 172.2 seconds of auxiliary waiting and 46.1
seconds of late verification, within a 608.0-second run. The global cap was five.

The run produced 11 main candidates and 11 auxiliary candidates. Seven main
findings survived (six unverified); ten auxiliary findings survived (nine
unverified). Both sources contributed uncertain findings. Removing auxiliary
passes would therefore remove some candidates without resolving the main
reviewer's missing-evidence problem.

The latest commit alone is insufficient for scheduling. A pass that failed on
an earlier code change still needs to review that change after a subsequent
documentation commit.

## Reuse policy

The newest authenticated bot review carries bounded completion metadata for
each successful auxiliary pass: reviewed commit, base and policy hash. A reused
pass preserves its original successful commit. Failed or partial passes do not
produce a reusable entry. Metadata inside model-written summaries is ignored.

Reuse requires an ancestor commit, the same base, model, settings, instructions,
guidelines, linked issues and PR intent. Every changed path since that pass's
successful commit must be a README, changelog or Markdown file under
`docs/audits/`. Code, configuration, other documentation, missing history,
changed policy and explicit same-head reruns run the pass normally. Disabling
dynamic fan-out also forces normal auxiliary scheduling.

The previous-to-current comparison controls scheduling only. Model review scope
remains the full three-dot PR diff. No Jev judgment decides whether to skip work.
The existing optional summary/addressed checks still yield to main completion;
session concurrency and verification policy are unchanged.

Logs record the decision and reason per pass, `state: reused` with its source
commit, full hunk delivery, execution/queue/wait phases, and finding dispositions.
A clean follow-up that does not post a review keeps the earlier baseline.
Local mode has no previous GitHub review state, so it cannot demonstrate reuse.

## Live follow-up experiment

Control: `1d8013be1361d34bfe10876f9d0a151c36dc25a5`.
Treatment: `b74889f` using `adaptive`. Both used Cline CLI 3.0.62,
`cline/cline-free/muse-spark-1.3-contributor`, concurrency three, two review
passes, guidelines and verification. The driver exercises the production
GitHub-backed runner with local Git commits and read-only fake GitHub responses;
it never posts. The initial successful treatment supplies the previous review
for both arms. Three documentation pairs alternate their execution order.

The fixture contains a batching defect and an explicit ownership-rule violation,
plus inert capacity tables large enough to require two main and two auxiliary
pages. A runtime probe confirms 201 jobs before the change versus 100 after it.
The documentation follow-up has 48 hunks. A subsequent code follow-up changes an
unchanged caller and has 49 hunks.

| Documentation follow-up             |           Control |         Treatment |
| ----------------------------------- | ----------------: | ----------------: |
| Pair 1                              |             56.2s |             50.6s |
| Pair 2                              |             45.1s |             31.1s |
| Pair 3                              |             44.6s |             34.6s |
| Average total duration              |             48.6s |    38.7s (-20.3%) |
| Median total duration               |             45.1s |             34.6s |
| Average post-main auxiliary waiting |              8.9s |                0s |
| Session executions per run          |                 6 |                 4 |
| Auxiliary finder prompt bytes       |           133,065 |                 0 |
| Main hunk delivery                  |   48/48 every run |   48/48 every run |
| Known roots retained                | 6/6 opportunities | 6/6 opportunities |

Both auxiliary completion records were reused in all three treatment runs.
No failed or cut-short pass accounts for the saving. Cline does not expose
token/cache/cost usage here; session executions are not a measure of internal
provider turns, and fewer prompt bytes are not a dollar-cost measurement.

The code follow-up reran both auxiliary passes in both arms: six executions,
49/49 hunks, both known roots retained. It took **63.7s versus 75.3s**. Treatment
also retained a duplicate investigation lead at the caller, displayed in the
collapsed advisory section. This single pair is not evidence of a speedup for
code changes. Both arms also overstated the ownership-rule violation as P1;
severity calibration remains unproven.

An earlier uncommitted pilot accidentally included Git setup configuration in
the fixture, making the supposed documentation follow-up ineligible. It is
excluded from these results. Later fixes strengthened same-head retry detection,
joint-guideline policy invalidation, omission accounting and advisory rendering.
The table describes its recorded treatment revision, not those later changes.

[Recorded rows, revision and fixture hashes](data/2026-09-20-adaptive-auxiliary-review.json)
include every measured run. Reproduce from clean treatment and control checkouts
with configured Cline authentication:

```sh
npx tsx scripts/auxiliary-followup-experiment.ts <control-checkout> <output-directory>
```

The optional fourth argument selects the number of documentation pairs (default
three); the initial review and code follow-up pair always run. The script asserts
that documentation reuse happens, code changes invalidate it and no pass is
incomplete. Its temporary fixture and Git configuration are removed on exit.

## Verifier evidence replay

The 17 comments in the [latest inspected review](https://github.com/pgup-ai/jbot-review/pull/228#pullrequestreview-5261979603)
were reconstructed without the previous verifier's conclusions, then ordered
by severity as in the runner. Unverified comments no longer expose their original
severity, so their reconstructed input uses P2. Both arms receive the same
findings and targeted diff pages from the frozen `1d8013b` checkout. Only the
source lookup differs. Each comparison uses three alternating pairs.

This is a component replay, not an exact reproduction of the hosted prompts or
a defect-recall benchmark. Refutation counts alone cannot establish quality.

Source inspection establishes two useful checks: the reported P1 about
`backendCanReadWorkspace` overlooks its caller's separate model-capability
guard; the newline-free-file truncation defect exists on `main` already.
Neither is a demonstrated new regression in this PR. The unawaited test callback
claim also overlooks that the tested configuration reaches its synchronous
statistics write without an intervening await.

| Verifier replay (three pairs each)      | Control | Treatment |
| --------------------------------------- | ------: | --------: |
| Original named lookup: average duration |   65.0s |     54.7s |
| Original lookup: uncertain verdicts     |   44/51 |     45/51 |
| Original lookup: refuted hypotheses     |    0/51 |      0/51 |
| Call-ranked lookup: average duration    |   58.6s |     73.4s |
| Call-ranked lookup: uncertain verdicts  |   45/51 |     45/51 |
| Call-ranked lookup: refuted hypotheses  |    0/51 |      0/51 |

The original lookup at `d592b8d` filled its bounded windows with generic matches
before useful callers. The refinement at `9e51be9` prioritized named calls over
import mentions and supplied the separate capability guard. It still confirmed
the unsupported capability warning and pre-existing truncation issue in all
three treatment runs. One original-control run additionally confirmed the
unsupported test-callback claim. More evidence did not establish better verdicts.

**Decision: remove the named lookup from the shipped experiment.** Its tests and
extra omission plumbing were removed too; the recorded commits retain the trial
implementations. Existing verification and research-only retrieval remain as
before. The faster original-lookup timing is not evidence of better verification;
the revised lookup was slower with unchanged outcomes. Provider variability and
the reconstructed inputs limit both timing comparisons.

## Reporting and limits

In `adaptive`, investigation leads and inconclusive findings remain available in
one collapsed **Unverified concerns** section, with their locations and concise
reasons. They do not create individual inline threads or count as graded bugs.
The full findings remain in run output and telemetry as `posted-advisory`;
performance aggregation still counts them as retained. Confirmed findings keep
their usual routing. Findings are not silently discarded or converted into an
all-clear review.

Enable with `JBOT_REVIEW_EXPERIMENT=adaptive` on a build containing this branch.
Return to `diff-batches` to disable this follow-up experiment while keeping the
existing batching default, or `off` to disable batching too. No extra public
flags or dependencies were introduced in this follow-up.

These targeted fixtures do not qualify a production rollout. The advisory core
corpus was not rerun for this follow-up; the branch's required full-corpus gate
for its earlier default-policy changes remains unmet. Hosted runs that use the
default preset do not validate adaptive reuse or its report layout.

## Self-review and cleanup

The review traced marker parsing and authenticated history, per-pass completion,
same-head retries, full-diff coverage, source bounds, fail-open behavior,
report routing and telemetry consumers. It caught the initial completion-marker
ordering bug, omitted-location inconsistencies and misleading severity counts
for investigation leads before publication.

For this increment, four comment blocks were adjudicated: three kept for
trust/provenance rationale, one removed with the unsuccessful retrieval code.
Four added test cases were adjudicated: three kept for independent failures
(forged completion metadata, stale or incomplete Git history, advisory/coverage
footer compatibility), one removed with that code. Existing telemetry and
preset tests were extended rather than duplicated. No assertions were weakened.

Self-review found no remaining P1/P2 issue in this increment. Validation passed:
`npm run format`, `npm run typecheck`, `npm run lint`, `npm test` (1,114 tests),
`npm run build` and `git diff --check`. No dependency or CLI packaging changed
in this follow-up. A hosted run of the new preset and the full-corpus release
gate remain unvalidated.
