# Phase 3 embedded-first prompt A/B

## Decision

Do not graduate the embedded-first prompt. Keep it available only through
`JBOT_EMBEDDED_FIRST_PROMPT=true`; the default review flow remains the control.

The treatment reduced repository-tool work and improved tail latency, but it
did not meet the predefined duplicate-diff, p50 latency, or QLT-003 gates.

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

All 113 retained findings were semantically adjudicated before rescoring.

## Results

| Metric                    |   Control | Treatment | Decision                                              |
| ------------------------- | --------: | --------: | ----------------------------------------------------- |
| Main-session p50          | 22,126 ms | 22,103 ms | 0.1% faster; fails the 10% gate                       |
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

## Pi compatibility probe

A one-repetition Pi probe completed 11 of 12 cases per arm before the run
budget expired on the final case, so it is not a graduation sample. Among the
completed sessions, treatment main-session p50 moved from 16,101 ms to
20,106 ms, tool calls fell from 52 to 43, and tool-output bytes fell from
68,821 to 55,612. Both arms recorded zero diff-recovery bytes.

## Rollback and follow-up

Rollback is immediate: leave `JBOT_EMBEDDED_FIRST_PROMPT` unset or set it to
`false`. The control prompt, Pi system prompt, no-tools directive, and shard
instructions remain byte-identical to `main` when the flag is off. Re-run the
experiment on a corpus with measurable duplicate diff recovery before
considering graduation; do not add hard exploration budgets until Phase 4's
separate gates are satisfied.
