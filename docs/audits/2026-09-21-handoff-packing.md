# Pack missing evidence before ranking it

The previous Jev comparison imposed a four-excerpt cap even when more source
would fit. This follow-up removes that cap in the local experiment and subtracts
exact source lines already delivered in the verifier's cited-source block. The
packet still has a 6,000-byte limit, including headers and omission notices.
Production callers retain their existing four-excerpt default.

Deduplication uses the rendered source block, not requested citation windows:
truncated or unavailable source must not be mistaken for delivered evidence.
Only matching path, line number and full line text are subtracted. The original
full diff and cited-source block remain untouched. Partially retained files stay
marked partial, and native reads remain available. This does not deduplicate
against raw diff hunks or create a cross-run tool cache.

Replaying the previous 15-candidate fixture pool removed 31 duplicate lines and
left 10 excerpts totaling 4,598 bytes. All fit without ranking, versus four
excerpts previously selected. Replaying historical PR #128 removed 89 duplicate
lines; two partial excerpts remained, totaling 4,353 bytes. This replay tests
packing, not model latency.

The live driver continues comparing control, deterministic handoff and Jev
handoff with identical candidates and byte limits. Jev is deliberately called
in its arm even when everything fits, so its ranking/filtering and overhead can
be measured. A future integration should avoid a ranking request when no
selection is necessary.

## Dependency-fixture result

The fresh main review took 49.9s and emitted both known root defects. With two
false candidates added, every verifier confirmed the two defects and refuted
both false claims. Removing 37 supplied lines left nine excerpts. Deterministic
packing delivered all nine in 3,885 bytes. Jev's existing relevance threshold
kept only one, three and one excerpts across repetitions, despite all fitting.

| Repetition                        |   Control | Packed handoff | Packed + Jev |
| --------------------------------- | --------: | -------------: | -----------: |
| 1                                 |   29.372s |        18.679s |      26.049s |
| 2                                 |   40.295s |        30.454s |      64.701s |
| 3                                 |   22.184s |        24.669s |      30.437s |
| Mean                              | **30.6s** |      **24.6s** |    **40.4s** |
| Mean model turns                  |       4.0 |            2.7 |          4.0 |
| Mean native tool calls            |      13.7 |            4.0 |          9.3 |
| Mean cumulative input tokens      |    70,311 |         48,078 |       70,642 |
| Mean reported cached input tokens |    32,936 |         28,722 |       33,278 |

Deterministic packing needed fewer tool calls in every repetition, fewer turns
in two, and was faster than Jev in all three. Jev selection itself took only
138–147ms and cost an estimated $0.000142128 per request; the extra
investigation dominated its overhead. The existing 0.5
relevance cutoff removed dependencies that remained useful to verification.
This supports skipping selection when evidence fits, not claiming Jev can never
help under genuine budget pressure.

These are three paired repetitions on one synthetic case, with variable provider
cache hits. The wall-time means are observations, not a production speedup claim.
Root judgments were checked against executable fixture behavior; severity and
publication-ready prose were not scored.

## Historical PR #128

The main review took 176.6s and again emitted no findings. Verification therefore
uses the seeded known provider-comma defect and two false claims, not newly
recovered main-review findings. Every verifier confirmed the defect and refuted
both false claims.

| Repetition             |   Control | Packed handoff | Packed + Jev |
| ---------------------- | --------: | -------------: | -----------: |
| 1                      |   14.377s |        18.841s |      13.422s |
| 2                      |   14.930s |        11.145s |      11.647s |
| 3                      |   17.786s |        14.311s |      10.858s |
| Mean                   | **15.7s** |      **14.8s** |    **12.0s** |
| Mean model turns       |       2.0 |            1.3 |          2.0 |
| Mean native tool calls |       2.0 |            0.7 |          2.0 |

Both handoff arms supplied the same two remaining excerpts. Jev's lower mean
latency did not come with better selection or fewer turns. Service, generation,
cache and ordering effects remain possible; this is not evidence of a ranking
advantage. The main-review miss remains unresolved by either handoff technique.

## Decision

Prefer deterministic delivery when missing evidence fits. This experiment removes
an unnecessary count limit and redundant source without replacing the native
harness. Keep Jev as a candidate for actual budget pressure; the current relevance
threshold can discard useful dependencies when filtering is unnecessary. Do not
infer a global winner by averaging these two cases or restore unverified inline
comments from a latency result.

The packing changes remain in the offline driver. The shared selector accepts
an optional count limit used there; production callers still default to four.
No production default changes in this PR, and no full quality-corpus gate was
run. All 18 completed verifier calls matched the known root outcomes, which is
a targeted verification check rather than general recall/precision validation.

## Protocol and artifacts

Same model and harness as the previous comparison: CommandCode 1.56.2,
`commandcode/meta/muse-spark-1.3-contributor`, low effort, native tools. Each case
runs a fresh main review, freezes its candidates, and rotates the order of three
verifier arms across three repetitions. Calls are serial; provider caches are
not reset. Selection time is included in verifier wall time. New main-review
findings and read order mean comparisons against previous suites are not paired.

Use `scripts/native-handoff-experiment.ts` with the plan format in the
[first pilot](2026-09-21-native-handoff.md), both provider credentials and the
pinned CLI on PATH. Private artifacts are in `.jbot-review/native-investigation/`:
`packed-large-search-pinned/` and `packed-pr128/`, with plans
`packed-large-search-plan.json` and `packed-pr128-plan.json`. They use the same
fixture commits as the [previous comparison](2026-09-21-jev-handoff.md).

The first launch picked up a globally installed CommandCode 1.44.0 and failed
before a model call because that version rejected the effort setting. It is
retained under `packed-large-search/` and excluded from results. The successful
launch uses a local pinned 1.56.2 installation, without changing the global CLI.

## Validation and self-review

All 1,114 tests, typecheck, lint, formatting and build passed. Executable ground
truth checks passed for both pinned fixtures, and both experiment script hashes
match the reviewed files. No P1/P2 issue found in self-review. The relevant seams
are rendered-source delivery, native transcript evidence and byte-bounded
selection; native permissions, complete diff delivery and publication policy are
unchanged.

De-slop added no comment blocks or test cases in this follow-up. New assertions
were folded into existing tests for exact source subtraction, truncated windows,
unchanged default selection and the UTF-8 byte limit with a higher count limit.
A redundant budget assertion was removed. The branch's previously reviewed
single catch comment and two new test cases remain justified as documented in
the earlier audits. Residual limits: two cases, one model, variable provider
caching, and no production handoff integration.
