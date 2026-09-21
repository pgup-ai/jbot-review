# Native investigation timing

Started from main `c10cffd` after PR #230 merged. This change measures native
CommandCode investigation. It does not add repository tools, a cache, a depth
limit, more review sessions, or a production prompt change.

## Measurement

The pinned CommandCode 1.56.2 CLI supports `--benchmark-output`. Its native
collector reports each turn's API duration, summed tool duration and tool count.
Jbot logs only these numeric fields and removes the temporary benchmark file.
Raw tool names, arguments, results and nested agent metadata are not copied from
the benchmark into logs. Missing benchmark output does not discard findings.

`toolWorkMs` is summed work, **not elapsed time** when tools overlap.
`observedToolActiveMs` measures the union of tool-running intervals observed on
the CLI event stream. Transport buffering can affect that estimate. The progress
record also includes peak concurrent tools and exact repeated argument counts.
Argument fingerprints stay in memory; paths and arguments are not logged.
A repeated call may be a legitimate retry, and overlapping reads with different
arguments are not counted as exact repeats. Dropped frames invalidate a complete
trace, as indicated by the existing progress metadata.

CommandCode already configures parallel execution and its system prompt asks for
independent calls in the same message. The experiment therefore tests the
behavior of the existing harness, not a replacement scheduler.

## Initial control

A clean, frozen Git fixture changes two identifiers in separate modules. The
reviewer must inspect the membership contract and payment gateway to establish
the two defects. Muse Contributor, low effort, native tools, no auxiliary passes:

| Metric                           | Control |
| -------------------------------- | ------: |
| Wall time, including CLI startup |   50.5s |
| Native API time                  |   50.0s |
| Native summed tool work          |    27ms |
| Observed tool-active time        |     9ms |
| Tool calls                       | 6 reads |
| Peak concurrent tools            |       5 |
| Exact repeated calls             |       0 |
| Known defects found              |     2/2 |

The first turn batched five reads. One dependent read followed. The final API
call took 36.4s without further tools. This is evidence of API-dominated latency
on this fixture, not proof that every long review has the same cause. API time
includes network/server/generation time; the collector does not split those.

The first full-PR #230 control hit the experiment driver's 300s deadline. That
attempt is a failed run, not a valid speed or quality sample. It was retried with
the existing 20-minute main-review allowance; no production deadline changed.

## Reproducing comparisons

`scripts/native-investigation-experiment.ts` takes a JSON plan:

```json
{
  "workspace": "/absolute/path/to/clean/fixture",
  "base": "base-commit",
  "head": "head-commit",
  "model": "commandcode/meta/muse-spark-1.3-contributor",
  "effort": "low",
  "repetitions": 3,
  "timeoutMs": 1200000,
  "arms": ["control", "reuse"],
  "output": "/absolute/path/to/new/results-directory"
}
```

Run with the pinned `command-code` CLI on PATH and `COMMANDCODE_ACCESS_KEY` in the
environment:

```sh
node --env-file=.env --import tsx scripts/native-investigation-experiment.ts plan.json
```

The script checks a clean checkout at the specified head and includes the entire
three-dot diff. Oversized single-page fixtures fail instead of truncating.
It alternates arm order, uses fresh sessions in one isolated CLI home, preserves
failures, and records revision/diff/script fingerprints and CLI version.
Provider-side prompt caching is not reset. Compare cache tokens and order effects
before attributing a latency difference to the treatment.

The optional `reuse` arm appends the existing exploration checkpoint. It asks for
independent reads together, reuse of evidence already present, and completion
when changed hunks and plausible failure paths are covered. It preserves
necessary dependency investigation and is not enabled in production.

## Unverified findings

Keep the current inline-publication gate. Native tools improve access to evidence
but do not turn an inconclusive verdict into confirmation. The code distinguishes
unavailable verification from inconclusive verification; both remain in diagnostics.
Restoring either category wholesale would publish unresolved hypotheses again.
A change to that policy needs its own precision/recall evidence, not merely a
successful tool-execution test.

## Full PR control

The complete #230 diff (`c10cffd^...c10cffd`) completed on retry:

| Metric                           |              Control |
| -------------------------------- | -------------------: |
| Wall time, including CLI startup |               323.4s |
| Native API time                  |               322.8s |
| Native summed tool work          |                196ms |
| Observed tool-active time        |                147ms |
| Model turns                      |                   11 |
| Turns with multiple tools        |                    6 |
| Tool calls                       | 11 reads, 7 searches |
| Peak concurrent tools            |                    3 |
| Exact repeated calls             |                    0 |

It returned no findings. That does **not** establish that the PR was defect-free
or that recall matched earlier dogfood runs. This was a main-review-only timing
control, without auxiliary passes or verification, and used a plain full diff
rather than the CI context package. The run generated 14,879 output tokens; API
time, not filesystem execution, dominated. Raw session token accounting reported
726,331 input tokens, including 454,920 cached input tokens.

A tool-result cache alone cannot materially shorten the measured subsecond tool
work. The useful question is whether fewer model turns can preserve findings.
Any proposed prompt change needs a separate matched quality/latency comparison.

## Three-pair checkpoint pilot

All six calls used the same fixture/base/head, Muse Contributor, low effort,
complete diff, native settings and CLI home. Sessions were fresh; order was
control/reuse, reuse/control, control/reuse. Only the checkpoint differed.

| Pair | Control | Reuse checkpoint | Known roots, each arm |
| ---- | ------: | ---------------: | --------------------: |
| 1    |   45.2s |            30.2s |                   2/2 |
| 2    |   42.5s |            48.7s |                   2/2 |
| 3    |   91.1s |            28.6s |                   2/2 |

Every call took three model turns and six reads, with peak concurrency five and
zero exact repeated calls. The checkpoint did **not** reduce investigation on
this fixture. It was faster in two pairs, but this small pilot cannot separate a
prompt effect on generation from service variability. Cached input also varied
between calls; the last checkpoint call had only 113 cached tokens yet was the
fastest. Do not attribute the result to a caching or batching improvement.

Manual adjudication retained the two known root defects in all six outputs.
Executing both functions at the base returned the expected refund and document;
at head they threw `Capture not found` and `Forbidden`. Some generated bodies
also speculated about identifier collisions and assigned P0 severity. This
fixture does not establish those exploit paths or justify that severity. No
negative cases or full-corpus precision gate were run. Root recall here is not
a general review-quality pass.

**Decision:** ship measurement, keep production guidance and publication policy
unchanged. Keep the checkpoint arm available only in the experiment script.
Test broader fixtures and adjudicate complete claims before any prompt rollout.

## Validation and self-review

All 1,113 tests, typecheck, lint, formatting and build passed. A final cheap-model
Docker pipeline completed in 14.3s including startup, found the seeded lookup
bug and retained it after verification with tools enabled. Both sessions answered
from supplied evidence without additional tool calls and emitted native benchmark
records. The core corpus was not rerun: production prompt text and
finding disposition are unchanged.

Self-review found no new P1/P2 issue. The script preserves complete diff bytes,
refuses oversized fixtures, keeps credentials/results private, and removes its
CLI home. Benchmark parsing and cleanup do not fail a review. Tests cover native
file cleanup and concurrency-safe measurement. De-slop: no new code comments;
one new test retained because it detects double-counted overlapping calls and
unsafe benchmark-field forwarding. No custom tools or new production flags.
