# Auxiliary waiting, repeated context and caller evidence

PR: [#228](https://github.com/pgup-ai/jbot-review/pull/228).
Control: `a27aef04ea35d843849f3dac3594396a4648519f`.
Paired live treatment: `3ff2465c559d596f2f521a6c4e85a803fe40c68a`.

## Why some waiting remains

The [617.8-second dogfood run](https://github.com/pgup-ai/jbot-review/actions/runs/35535032749/job/106142411475)
spent 322.9 seconds after main review waiting for auxiliaries. Finder passes can
produce additional findings, so dropping all of them at main completion would
trade recall for time. Verification also remains necessary before publishing
confirmed findings. Change summaries and addressed-thread checks do not need
to delay a ready review.

The old policy extended the post-main grace to give auxiliary work ten minutes
from launch. That included queue time, and a large guideline pass could occupy
the queue ahead of every interaction page. When one page remained unfinished,
the aggregate timeout also discarded findings from that pass's completed pages.

The [newer baseline run](https://github.com/pgup-ai/jbot-review/actions/runs/35536217275/job/106145617499)
at `a27aef0` took 621.1 seconds. It delivered 225/225 hunks across 35/35 main
pages, but waited 329.2 seconds after main. Verification timed out after 300
seconds and all 14 posted comments were explicitly unverified. Its main model
already used low reasoning. Different model selections make this an operational
diagnosis, not a paired latency comparison.

## Changes

- Main and verification retain queue priority. Pending auxiliary pages rotate
  between passes. Summaries and addressed-thread checks use low-priority slots.
- At main completion, keep finished bookkeeping results and cancel unfinished
  ones before verification starts. Low priority alone cannot preempt a running
  summary holding the only slot. Skipped addressed checks leave prior threads
  unresolved.
- Finding-producing auxiliaries keep the five-minute maximum post-main grace,
  clipped by the run budget with verification/posting reserves. The ten-minute
  minimum lifetime is removed. Completed page findings survive another page's
  timeout, and incomplete finder coverage remains visible.
- Finder context above 16 KiB drops repeated commit/check/prior-comment metadata
  and the duplicate changed-file list when doing so reduces bytes. PR intent,
  guidelines, the shared change map, caller evidence and mandatory hunks remain.
  Logs report bytes before/after compaction. Prior suppression and thread checks
  still use their separate inputs.
- Caller retrieval searches reverse imports even when only an internal function
  changed. It prioritizes unchanged production callers, validates actual import
  bindings and reserves space after the call for options. Source reads reuse the
  tracked-file inventory already obtained for that packet.
- Verification sizes batches against required context before preparing optional
  evidence. If the extra packet does not fit, it is omitted and logged; fitting
  cited-source verification still runs. Required context that cannot fit even
  for one finding continues to fail open as an unverified finding.

These changes introduce no flags or dependencies. The full PR adds the pinned
`@babel/parser` dependency documented in the earlier audit. Jev remains opt-in;
this round uses deterministic retrieval. Reasoning defaults are unchanged.

## Historical caller probe

Both engines reviewed the same `2d8f923...868a476` diff in the frozen `868a476`
checkout, using identical prompt budgets. Both planned ten pages with identical
mandatory hunk delivery. Control delivered no `src/worker/run-job.ts` excerpt;
treatment delivered it on `review-shard-8`, including `reviewShards: 1`.

Evidence preparation measured 1,563 ms versus 827 ms in this local probe. This
establishes the missing caller's delivery, not model recall or general latency.

## Paired live protocol

Three alternating pairs use Cline's `muse-spark-1.3-contributor`, the same
91-file, 173,794-byte diff, concurrency three, one requested initial shard,
main + interaction + guideline passes and independent verification. Dynamic
fan-out is disabled. There are no previous review threads, so this fixture
measures context, retrieval and finder scheduling; the nonblocking bookkeeping
behavior is covered separately by deterministic tests.

The executable fixture changes a correct batching loop to return only the
first batch. An unchanged worker calls the public wrapper with a limit of 100.
Running it with 201 jobs returns 201 before the patch and 100 afterward. Ninety
independent capacity-table additions and bounded PR/commit metadata exercise
page planning. The expected retained finding is silent loss of jobs beyond the
first 100. Every run uses the real pipeline in dry-run mode and posts nothing.

Fixture hash:
`0313984f437eb10c34cc6680da79ef0f5d8618f272149634545e13d9e5a96df9`.

The paired revision precedes the final verifier fallback and earlier bookkeeping
cancellation. This fixture has neither optional verification evidence nor prior
threads. Those follow-ups are covered by deterministic regression checks rather
than attributed to the paired latency results.

## Results

[Per-run evidence](data/2026-09-20-auxiliary-review-optimization.json) includes
all six rows, retained findings, phase timings, coverage and raw-result hashes.

| Pair |   Control | Treatment |    Change |
| ---- | --------: | --------: | --------: |
| 1    | 173.846 s | 128.058 s | −45.788 s |
| 2    | 137.712 s | 126.723 s | −10.989 s |
| 3    | 145.356 s | 114.564 s | −30.792 s |
| Mean | 152.305 s | 123.115 s |    −19.2% |

Every control used 18 model calls; every treatment used 15. Main pages fell
from seven to five, guideline pages from five to four, and interaction pages
stayed at five. Planned finder-prompt bytes fell from 1,324,956 to 1,078,266
(−18.6%). Mean post-main auxiliary waiting fell from 82.8 to 62.1 seconds
(−25.0%). No pass was cut off to achieve these results.

All six runs delivered 91/91 hunks and completed all finder passes and
verification. Manual, unblinded adjudication found the same seeded defect in
3/3 controls and 3/3 treatments, with no additional findings. All three
treatments cited the unchanged worker's actual call; no control did. This is
better supporting evidence, not an increase in known-root recall on this case.
All six labeled the conditional job-loss defect P0, which is overstated; the
experiment does not validate severity calibration.

## Self-review and validation

Final runtime: `7d0b67bdb9b8719be6bf926050471cf2f43f9b21`.
Self-review found and corrected a single-slot scheduling issue: cancelling
bookkeeping only after verification could leave verification queued behind a
running summary. Cancellation now happens at main completion; a summary still
preparing its context also checks abandonment before launching.

No remaining P1/P2 issues were found in this follow-up. Reviewed seams include
global/provider queues, cancellation, completed-page findings, prompt assembly,
source-path isolation, caller selection and verifier budget/fail-open behavior.
The final diff was checked against the full-diff, read-only and posting-marker
contracts. No dependencies or CLI packaging changed in this follow-up.

Validation: 1,109 tests passed, including the single-slot cancellation check and
the verifier regression that failed before its fix. Typecheck, lint, formatting,
build and `git diff --check` passed. The paired live run exercised real Cline
main, interaction, guideline and verifier sessions. Hosted validation for the
new head remains separate from these local results.

De-slop accounting for the `a27aef0` follow-up:

- Comments: 10 blocks — one kept (reverse-import rationale), two rewritten
  (queue fairness and concurrent grace timers), seven cut (obsolete ownership
  and minimum-lifetime explanations).
- New tests: four kept — unchanged-wrapper callers, nonblocking bookkeeping,
  retained findings from completed pages and fair auxiliary queue rotation.
  Verifier and context-budget assertions extend existing cases. The removed
  minimum-lifetime test describes policy deliberately removed by this change.
- Removed the unused lens-specific grace helper and the ten-minute floor.
- Net incremental delta, including this audit and its data: +1066/−233 lines (net +833) across 15 files.

Review feedback: applied the dependency-audit correction, initial-group README
correction and both verifier-budget recommendations. The other eleven hypotheses
did not demonstrate a worthwhile defect: existing guards, parsing, stream
flushing, option rereads or failure handling already cover them; the exploration
checkpoint is advisory, and the concurrency-policy change is intentional.

## Dogfood report follow-up

The [a27aef0 review](https://github.com/pgup-ai/jbot-review/pull/228#pullrequestreview-5261715539)
listed 44 failure entries: verification, two auxiliary passes, and 41 child
page failures from those passes. These were not 44 independent failures.
Main coverage was complete; the auxiliary and verification failures made the
overall review incomplete.

Its 13 P3 comments were candidates demoted after verification timed out, not
13 confirmed minor bugs. Manual triage accepted two verifier-budget fixes and
the separate README nit. The other 11 P3 hypotheses were unsupported,
unreachable or intentional behavior, as recorded in their resolved threads.
This is one run's adjudication, not a general precision estimate.

The report now groups child failures under their pass, retaining page counts
and the incomplete warning. Replaying the exact failure rows reduces the
notice from 2,021 to 387 UTF-8 bytes. Per-page telemetry remains unchanged.
Unverified comments display an **Unverified** label and occupy a separate table
column instead of inflating P3/nit counts. All 14 candidates remain present;
finding disposition, filtering and approval policy are unchanged. Inconclusive
verification also gets explicit merge guidance when all sessions completed.

This follow-up changes presentation only. It does not establish that the
verifier timeout or review precision is fixed, and no new model benchmark is
needed for the report layout. Existing tests exercise grouped failures,
mixed verified/unverified counts, labels and incomplete-review markers.

Validation: all 1,109 tests, typecheck, lint, formatting, build and diff checks
passed. Self-review found no remaining P1/P2 issue in this presentation change.
De-slop added no comment blocks or test cases; assertions extend four existing
cases. No flags, dependencies or model calls were added.

## Release limit

This targeted fixture cannot establish corpus-wide recall, false-positive rate
or severity calibration. Cline does not expose token usage through this runner,
so prompt bytes and call counts must not be presented as measured token, cache
or dollar savings.

The required full-corpus gate for the branch's default-policy changes remains
unmet. The earlier full attempt used invalid clean fixtures and mismatched
engine metadata; it is excluded as explained in the
[complete-page audit](2026-09-20-budgeted-diff-pages.md). This round does not add
a passing benchmark-ledger row or qualify the branch for production.
