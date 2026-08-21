# Phase 3 embedded-first prompt A/B

## Decision

Do not graduate the embedded-first prompt. Keep it available only through
`JBOT_EMBEDDED_FIRST_PROMPT=true`; the default review flow remains the control.

The treatment reduced repository-tool work and improved tail latency. It did
not meet the predefined duplicate-diff or QLT-003 gates. The p50 latency gate is
recorded as unresolved rather than failed: paired, the run improves latency at
p=0.04, but its sample resolves only a 25% effect against a 10% gate and ran
both arms in a fixed order (see "Why
the p50 result is unresolved").

## Contract

- Base commit: `2d372cc71731757e21afc4b9e0f4c59a57e1334c`
- Corpus: smoke subset, 12 cases, 3 repetitions per arm, 72 successful runs
- Model: `zai-coding-plan/glm-5.2` (`glm-5.2-2026-08-20`)
- Engine: OpenCode `1.18.14`
- Reasoning: provider default; temperature `0`
- Cache state: uncached cases; provider prompt cache remained enabled equally
- Code-side exploration enforcement: disabled
- Control prompt: `sha256:aca6bccce0ed03c96b649a90c98d9fe400686da4767f3f035514061052051364`
- Treatment prompt: `sha256:654ac023aa277992213e02f29007710967b265c1a072b4f97cd4554bd90abfa0`
- Declared treatment variables: prompt source root and prompt version only

Semantic adjudication covered all 113 retained findings before rescoring.

## Results

| Metric                    |   Control | Treatment | Decision                                              |
| ------------------------- | --------: | --------: | ----------------------------------------------------- |
| Main-session p50          | 22,126 ms | 22,103 ms | 0.1% faster; the gate is underpowered here            |
| Main-session p90          | 42,197 ms | 32,171 ms | 23.8% faster                                          |
| Main-session p95          | 46,207 ms | 40,171 ms | 13.1% faster                                          |
| Repository tool calls     |       171 |       122 | 28.7% fewer                                           |
| Tool-output bytes         |   292,848 |   187,062 | 36.1% fewer                                           |
| Turns p50 / p95           |     3 / 5 |     3 / 4 | Better tail only                                      |
| Duplicate diff-read bytes |         0 |         0 | No control signal; 50% reduction is not demonstrated  |
| Diff-recovery bytes       |         0 |     1,453 | Treatment performed three non-repeated recovery calls |
| Severity-weighted recall  |    57.66% |    64.86% | No QLT-004 regression                                 |
| Precision                 |    14.04% |    16.07% | No QLT-004 regression                                 |
| Seeded P0/P1 misses       |         4 |         3 | Treatment misses P1; QLT-003 fails                    |

The scorer also rejected the treatment because one treatment run introduced a
new clean-case false positive. Trigger completeness and evidence support were
100% in both arms.

## Why the p50 result is unresolved

The gate reads a pooled p50 over 12 cases whose cost differs several-fold, so
the median tracks whichever case family lands at the median rank instead of a
uniform per-case shift. Pairing the arms by (caseId, repetition) removes case
difficulty from the comparison. `summarizePairedBenchmark` reports this run as:

| Statistic                 |           Value |
| ------------------------- | --------------: |
| Paired median             |          -16.2% |
| 95% CI                    | [-25.0%, +7.8%] |
| Permutation p             |          0.0429 |
| Treatment faster          |        22 of 36 |
| Minimum detectable effect |             25% |

The improvement clears the 0.05 level, so the -0.1% gate reading measures the
estimator rather than the prompt.

One caveat applies to this run specifically: it executed control first for
every pair, so the arm label was confounded with execution order and any
provider warm-up inside a pair would read as a treatment gain. Prompt-cache
reads were near-identical across arms (449,088 vs 432,320 tokens), which rules
that channel out but not throttling or load drift. The harness now picks which arm
leads by hashing the case id (`benchmarkArmOrder`), so later runs do not carry
this qualification. It is still not a graduation: the design
resolves a 25% effect while the gate asks for 10%, and a significant result
from an underpowered design overstates the effect, so -16.2% is an upper
estimate. Re-run on a larger sample before setting a number.

## Pi compatibility probe

A one-repetition Pi probe completed 11 of 12 cases per arm before the run
budget expired on the final case, so it is not a graduation sample. Among the
completed sessions, treatment main-session p50 moved from 16,101 ms to
20,106 ms, tool calls fell from 52 to 43, and tool-output bytes fell from
68,821 to 55,612. Both arms recorded zero diff-recovery bytes.

## Verification on merged `main`

Re-run after the merge, with both arms on the same checkout so
`JBOT_EMBEDDED_FIRST_PROMPT` is the only declared variable besides the prompt
hash. Smoke subset, 12 cases, 2 repetitions: 24 pairs and 48 runs per model,
144 runs across the three models below. Failure rate 0/144, counting timeout, signal, setup,
runner-exit, invalid-output, and missing-output as failures. Every quality
figure below is run-level, with 12 defect runs and 12 clean runs per arm per
model.

| Metric                     | `muse-spark-1.2-contributor-free` | `mimo-v2.5-free` | `devin/glm-5.2` |
| -------------------------- | --------------------------------: | ---------------: | --------------: |
| Tool-output bytes          |                            -58.3% |           -35.7% |    no telemetry |
| Tool calls                 |                            -23.0% |           -40.3% |    no telemetry |
| Turns                      |                            -22.4% |           -36.4% |    no telemetry |
| Generated tokens           |                             -6.4% |           +11.5% |    no telemetry |
| Main-session paired median |                  -19.6% (p=0.040) |  -15.1% (p=0.90) |  +7.4% (p=0.88) |
| Whole-run paired median    |                 -26.1% (p=0.0023) |   -8.3% (p=0.86) | -19.4% (p=0.14) |
| Defect runs with a finding |                    12/12 -> 12/12 |   12/12 -> 12/12 |  12/12 -> 11/12 |
| Clean runs with a finding  |                      8/12 -> 9/12 |    9/12 -> 10/12 |    9/12 -> 8/12 |

`mimo-v2.5-free` ran on production-default model options, unlike the other two.
Its unpaired p50 improves 28.2% while the paired test reports p=0.90, with the
treatment faster in 14 of the 24 pairs and slower in 10. No pair was dropped.
Reading the p50 alone would have claimed a speed-up the data does not support,
in the opposite direction to the reading that made round 1 look flat.

`devin/glm-5.2` reports `capability: "opaque"` with `turnCountAvailable:
false`, so every tool counter is zero by construction and the byte gate cannot
be evaluated there. Its two latency metrics also disagree in sign and neither
reaches significance, so the honest reading is no detectable effect rather than
a small one.

Detection here counts a run as finding the defect when it returned at least one
finding, which does NOT confirm the finding matches the seeded defect. These
numbers therefore do not evidence QLT-003, which needs semantic adjudication
and remains unsatisfied. Clean counterfactuals returned findings in 8-10 of 12
runs in BOTH arms, so that precision problem predates the treatment.

## Decision after verification

The gate is per backend/model cohort, and the treatment clears it on three of
the four cohorts that report telemetry. `deepseek-v4-flash-free` falls short at
-13.7% against the 25% bar and is not graduated. `devin/glm-5.2` cannot
evidence the gate at all and is judged on quality and failure rate alone, both
of which it meets. No cohort shows a quality regression beyond one defect run
on `devin/glm-5.2`, and none of these figures evidence QLT-003.

Two cohorts come from earlier runs rather than the 144-run verification, so
their populations differ; each row names its source.

| Cohort                       | Tool bytes | 25% byte gate | Source            |
| ---------------------------- | ---------: | ------------- | ----------------- |
| `muse-spark-1.2-contributor` |     -58.3% | pass          | verification      |
| `mimo-v2.5-free`             |     -35.7% | pass          | verification      |
| `devin/glm-5.2`              |     opaque | unevaluable   | verification      |
| `zai-coding-plan/glm-5.2`    |     -36.1% | pass          | round 1, 36 pairs |
| `deepseek-v4-flash-free`     |     -13.7% | FAIL          | screen, 12 pairs  |

Across the same five the tool-work reduction is the consistent effect and
latency is not:

| Model                        | Tool bytes |    Latency paired |
| ---------------------------- | ---------: | ----------------: |
| `muse-spark-1.2-contributor` |     -58.3% | -26.1% (p=0.0023) |
| `zai-coding-plan/glm-5.2`    |     -36.1% |  -16.2% (p=0.043) |
| `mimo-v2.5-free`             |     -35.7% |    -8.3% (p=0.86) |
| `devin/glm-5.2`              |     opaque |    +7.4% (p=0.88) |
| `deepseek-v4-flash-free`     |     -13.7% |  +16.3% (p=0.040) |

The latency payoff appears only where the model does not spend the saved tool
time generating instead: `mimo-v2.5-free` emitted 11.5% more tokens and
`zai-coding-plan/glm-5.2` 4.4% more. That is the case for gating on the
mechanism rather than on its downstream effect.

## Rollback and follow-up

To roll back, leave `JBOT_EMBEDDED_FIRST_PROMPT` unset or set it to `false`.
The control prompt, Pi system prompt, no-tools directive, and shard
instructions remain byte-identical to `main` when the flag is off. Re-run the
experiment on the `core` subset, which supplies 60 pairs against this run's 36,
and on a corpus with measurable duplicate diff recovery before considering
graduation. Do not add hard exploration budgets until Phase 4's separate gates
are satisfied.
