# Measured auxiliary tuning

Six fixed-head route attempts show no consistent end-to-end speedup. Keep the
current review defaults; the report now exposes each attempt's auxiliary timings,
coverage, and finding counts.

## Observed workflow evidence

The [final PR #202 review](https://github.com/pgup-ai/jbot-review/actions/runs/34077046294)
(attempt 1, reviewer `418671a579694df0b6ac994ad987b63145e40207`)
finished successfully. Its job steps and logs were checked through GitHub, and the
`jbot-review-telemetry-34077046294-1` artifact was downloaded for measurement.

| Measure                           | Value    |
| --------------------------------- | -------- |
| Pipeline wall time                | 48.221 s |
| Main execution                    | 40.561 s |
| Auxiliary guideline execution     | 24.125 s |
| Auxiliary changes-since execution | 6.203 s  |
| Maximum auxiliary queue           | 0.007 s  |
| Grace wait                        | 0 s      |
| Lens passes                       | 0        |
| Retained findings                 | 0        |

Main was `commandcode/meta/muse-spark-1.2-contributor`. Auxiliary was
`opencode-go/muse-spark-1.2-contributor` through pi at low effort; verification was
skipped because there were no findings. Effective concurrency was five. This run
provides no evidence that raising concurrency would help, and no lens-quality
comparison. Zero findings is not proof of accuracy.

The six-entry shared pool in that artifact contains OpenCode Muse 1.2/1.3 free,
OpenCode Go Muse 1.2, CommandCode Muse 1.2/1.3, and CommandCode LongCat 2.0 free.
Historical slow GLM/Devin runs remain useful failure examples, but cannot rank a
pool that no longer contains those routes. This is an observed configuration for
one run, not a claim about every consumer's current settings.

## Fixed-head route screen

Reviewed a clean detached checkout of `a91dda587680cb59634d40d261f3ea939a2f85e1`
against `ac2253f3160d2c538124c7af6c14f7d2f1caeaec`: the six-file PR #202 diff.
The reviewer ran the same TypeScript runtime from that merged revision (`unbundled`);
this branch changes only reporting/tests/docs. Runs were sequential, in the order
control, candidate, candidate, control, control, candidate, with three attempts
per route. No shard-result reuse or concurrent benchmark processes.

- Main: `opencode/muse-spark-1.3-contributor-free`, OpenCode engine, medium effort.
- Control auxiliary: the same route, read-only workspace access, medium effort.
- Candidate auxiliary: `commandcode/meta/muse-spark-1.3-contributor`, native CLI,
  embedded-only access; effective reasoning effort is not reported for this model.
- Both: two passes, one shard, interactions lens and guideline pass, context trim
  enabled, embedded-first enabled, verification enabled, concurrency five, five-minute
  run budget, prompt caching enabled. Context7 had no configured key. Local dry-run
  mode has no prior-thread or changes-since sessions and never posts to GitHub.

The existing `MODEL` setting was the control singleton or
`commandcode/meta/muse-spark-1.3-contributor,opencode/muse-spark-1.3-contributor-free`.
At this frozen head, the existing deterministic selection keeps main on OpenCode
and picks CommandCode for auxiliary work. No auxiliary model input was introduced.
The pool change affects the configuration hash and is the declared treatment;
backends, workspace access, and supported effort are part of the route comparison.

Seconds from telemetry, in execution order:

| Run | Auxiliary route | Main execution | Guideline execution | Interactions execution |  Grace | Pipeline | Outcome        |
| --- | --------------- | -------------: | ------------------: | ---------------------: | -----: | -------: | -------------- |
| 1   | Control         |        157.575 |              87.032 |                191.816 | 34.242 |  192.263 | Completed      |
| 2   | Candidate       |         93.515 |              18.297 |                 77.005 |      0 |   96.989 | Completed      |
| 3   | Candidate       |        159.832 |              47.697 |                 62.985 |      0 |  162.179 | Completed      |
| 4   | Control         |         86.510 |              76.431 |                 86.511 |  0.002 |   86.953 | Completed      |
| 5   | Control         |         69.522 |              75.549 |                 65.495 |  6.029 |   75.984 | Completed      |
| 6   | Candidate       |        272.633 |              28.620 |                 41.591 |      — |  275.312 | Main timed out |

Maximum auxiliary queue time was **1 ms** across all six runs. All twelve auxiliary
sessions completed. The five successful reviews retained zero findings and skipped
verification. Run 6 failed closed: the main prompt exceeded 270 seconds, leaving no
retry budget. Its elapsed time includes cancellation overhead; it is not a completed
review latency or a zero-finding success. The five-minute experimental budget is
shorter than the observed workflow's thirty-minute budget.

CommandCode completed auxiliary work before main in every attempt, while the
control sometimes waited on a lens or guideline pass. However, the unchanged main
route varied from 69.522 seconds to timeout. Prompt caching remained enabled, and
provider cache/load were not controlled. The first candidate looked twice as fast
as the first control; the later control runs were faster than either successful
candidate. There is no stable end-to-end speed win in this sample.

This is one already-reviewed diff, not a seeded defect/clean-case corpus, and the
route capabilities differ. Neither recall nor precision was established; the
verifier and GitHub-specific auxiliary checks were not exercised. No success-rate,
tail-percentile, or model-ranking claim is justified by three attempts per route.

Telemetry run IDs, in table order: `fb297b69-e41c-4298-b4b3-eab0b056f2e1`,
`b6e4ce2a-5fe3-43c6-a5a4-82d26ece9d06`, `9df1b4fe-949f-4885-8ee0-22928ad5f3ad`,
`23d28fa0-aeb7-44cf-9f2e-0586c1c0c613`, `23b70003-249e-4976-967b-dcf28cf89cef`,
`bcaaf20a-c39b-481f-99ca-9845e9bffaad`. Raw local artifacts are retained outside the
repository. See [Comparing review runs](../../README.md#comparing-review-runs)
for the report command and interpretation.

## Decision

Keep the existing defaults. A route change should first be tested on the same
base/head, reviewer revision, main route, effort, cache policy, and fan-out, with
seeded defects and clean cases. Record both failed attempts and completed ones.
Blind-adjudicate findings before drawing precision/recall conclusions. The core
three-repetition quality benchmark is not run here; no default-policy flip is
proposed.
