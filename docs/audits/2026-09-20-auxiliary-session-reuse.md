# Fewer auxiliary sessions and stronger verifier evidence

PR: [#228](https://github.com/pgup-ai/jbot-review/pull/228).
Control: `3154f11c49d9e1ac4566c505621ebf5a74004925`.
Paired full-review treatment: `239bdf997634036ffa5b004746597ce85624512b`.
Final runtime: `3e1c952`.

## Hosted failure diagnosis

The [35538979558 dogfood job](https://github.com/pgup-ai/jbot-review/actions/runs/35538979558/job/106153039727)
used a global concurrency limit of five. Its 38 main, 17 interaction and 22
guideline pages were queued work, not 77 simultaneous model sessions. Main
completed 263/263 hunks. Auxiliary failures included one `ENOTEMPTY` cleanup
error followed by 31 `spawn cline ENOENT` errors. Only three interaction and
four guideline pages completed. The run took 349.9 seconds overall.

The pinned Cline 3.0.60 [updater implementation](https://github.com/cline/cline/blob/08931a33cc528f1a540e50c4d6b147786930493f/apps/cli/src/commands/update.ts)
checks clients in its own home before scheduling a detached global npm update.
J-Bot isolates each session's home but shares the installed executable. That
makes competing updater activity a plausible explanation for the missing
executable; the logs do not establish that an updater actually ran.

## Changes

- Force `CLINE_NO_AUTO_UPDATE=1` in Cline child environments. Retry temporary-home
  removal with Node's bounded retry policy; log a code-only cleanup failure
  without replacing the model's result or original error.
- When a guideline check and auxiliary lens are selected, combine the written
  rule check with the first lens's pages. Preserve full rules, explicit violation
  citations and both aggregate coverage records. A standalone guideline pass
  remains when there is no lens; guideline sweep behavior is unchanged.
- Implement experimental verifier excerpts around relevant imports and local definitions,
  including option-normalization helpers, plus deterministic caller evidence.
  Existing tracked-source guards and omission notices remain. Retrieval is a
  heuristic, not a complete call graph or a verdict. These extra packets remain
  disabled in public presets after the replay below.
- Resolve each role's workspace capability before wrapping its backend. Verification
  retains its existing batch ceiling and shrinks required prompts to fit the actual
  budget. A fixed four-finding limit was tested and rejected, as described below.
- Keep the existing public experiment controls and record the selected evidence
  mode in configuration. Extra verifier retrieval is available through the existing
  programmatic research settings; Jev remains opt-in. No flags or dependencies
  were added.
- Move severity-table and merge-guidance presentation helpers into `report.ts`.

Concurrency limits, main hunk coverage, auxiliary grace limits, fail-open
verification and compact incomplete-pass reporting are preserved.

## Paired full-review experiment

Three alternating pairs used the same Cline Muse contributor model and installed
CLI 3.0.62, a 92-file / 173,912-byte diff, concurrency three, one initial shard,
two requested passes, guidelines and independent verification. Dynamic fan-out
was disabled. Both arms disabled Cline self-updates, so these timings do not
isolate the updater fix. All calls ran through the real pipeline in dry-run mode.

The executable fixture changes a batching loop to return only `jobs.slice(0,
limit)`. Its unchanged worker uses a limit of 100: 201 submitted jobs produce
201 results before the change and 100 after it. A second change removes an
explicit `owner: "batch-worker"` field required by the tracked `AGENTS.md`.
Ninety independent capacity-table additions exercise pagination. The known roots
are the lost jobs and the written ownership-rule violation.

[All six rows and hashes](data/2026-09-20-auxiliary-session-reuse.json) preserve
durations, coverage, findings and phase measurements.

| Pair |   Control | Treatment |    Change |
| ---- | --------: | --------: | --------: |
| 1    | 107.455 s |  97.601 s |  −9.854 s |
| 2    | 114.907 s |  82.989 s | −31.918 s |
| 3    | 102.014 s |  70.614 s | −31.400 s |
| Mean | 108.125 s |  83.735 s |    −22.6% |

Calls fell from 15 to 11 per run: five main pages, five interaction pages and
four separate guideline pages became five main pages and five combined auxiliary
pages. Both arms then made one verification call. Planned finder-prompt bytes
fell from 1,081,940 to 787,696 (−27.2%). Mean post-main auxiliary waiting fell
from 61.2 to 32.8 seconds; mean verification rose from 5.9 to 7.4 seconds.

Every run completed 92/92 hunks and all auxiliary passes, retained both known
roots after verification, and produced no additional findings. Both arms graded
the ownership-rule violation P1, which is excessive for this fixture. This trial
does not validate severity calibration or general false-positive rates. Cline
usage counters are unavailable: bytes and calls are not measured token/cache or
dollar savings.

The loaded treatment engine stayed at `239bdf9` throughout these six runs. The
final follow-up resolves backend capability and restores the existing default
verifier evidence policy after the negative replay below. The fixture has only
two verification targets, so it does not test the rejected smaller batch limit. Do not
attribute final-runtime behavior beyond that measured revision to these timings.

## Verification replay

Three alternating pairs replayed the nine hosted hypotheses against frozen
`3154f11` source. Inputs were reconstructed from posted comments, with prior
verifier reasoning removed. Both arms used bounded full-file patches for the
finding paths, not the production paged verifier context, so this is a component
experiment rather than a reproduction of that hosted run. Source/API adjudication
found no demonstrated defect in these nine hypotheses.

The `84cef93` candidate added evidence and capped each batch at four findings:

| Measurement across three runs    |  Control | Candidate |
| -------------------------------- | -------: | --------: |
| Mean verification time           | 42.982 s |  78.204 s |
| Calls per run                    |        1 |         3 |
| Refuted hypotheses               |     0/27 |      3/27 |
| Incorrectly confirmed hypotheses |     7/27 |      8/27 |
| Uncertain hypotheses             |    20/27 |     16/27 |

All three refutations concerned the same missing-import hypothesis. Caller
inventories and external API contracts remained insufficient, and some relevant
local definitions were collected but omitted by the shared source-byte budget.
The narrower batches did not establish better confirmation precision and raised
mean latency 81.9%. The final runtime removes that fixed limit and retains
budget-based batching. These candidate results do not describe the final policy.
An all-negative replay cannot establish recall; the two-root full-review fixture
is a separate positive control.

One follow-up probe at `85cf07f` retained extra retrieval but restored budget-based
batching. It made one call in 98.307 seconds, incorrectly confirmed three
hypotheses, left six uncertain and refuted none. This single observation does not
establish a stable latency regression, but it supplies no reason to enable the
extra retrieval by default. The final runtime leaves it research-only. The
missing import/default fixture verifies evidence delivery; no corpus-wide
precision or recall improvement is claimed.

The final `3e1c952` runtime completed the same full-review fixture in 86.725 seconds
with 11 calls, 92/92 hunks, both known roots retained and no incomplete passes.
This is a final integration smoke run, not another paired latency estimate.

## Self-review and validation

Self-review found and fixed missing capability propagation and an evidence-mode
telemetry mismatch before publication. No remaining P1/P2 issues were found.
Reviewed seams include isolated CLI homes, shared executable updates, main/aux
capabilities, combined-pass coverage, verifier budgets, tracked-source reads,
option defaults and reporting ownership. No CLI packaging changed. A full-suite
rerun exposed a cancellation-test race: a child readiness file can precede receipt
of its stdout. The test now waits for both observable conditions before cancelling;
the stdout assertion and cancellation checks remain.

All 1,111 tests, typecheck, lint, formatting, build and diff checks passed. No
provider credential value occurs in the branch diff; `.env` remains untracked.

De-slop accounting for the follow-up from `3154f11`:

- Comments: one block kept, explaining why isolated homes make self-updates unsafe.
- New tests: two kept. One prevents cleanup from masking either success or provider
  failure; the other prevents distant imports/defaults from disappearing from
  verifier evidence. Batch, coverage and configuration checks extend existing cases.
- Cut the fixed batch-size policy and the unproven default verifier expansion.
- Reporting policy reuses the existing report module. No new flags, dependencies,
  generalized scheduler or second evidence index were added.
- Implementation delta through `71c70dd`: +946/−138 lines (net +808) across 16 files.

The follow-up documentation review corrected the core Action and README promise
of a dedicated guideline session. [Wrapper PR #58](https://github.com/pgup-ai/jbot-review-action/pull/58)
updates the full/slim descriptors and input table to the same shared-session wording.
Defaults and runtime behavior are unchanged; generated slim parity and exact
canonical-description checks pass.

## Release limit

The full-corpus gate for default-policy changes remains unmet. The earlier invalid
attempt is excluded as documented in the [paging audit](2026-09-20-budgeted-diff-pages.md).
These targeted measurements do not create a passing benchmark-ledger row or qualify
this branch for production. Hosted dogfood validation remains separate from local
measurements.
