# Selective source delivery after a review read

Continue `codex/jev-evidence-prefetch` from `d0e0dbe`. The preceding experiment
delivered evidence but did not reliably replace sequential reads. This round
tests a narrower selection policy before considering another latency claim.

## Hypothesis and implementation

`JBOT_READ_EVIDENCE=linked` supplies at most two directly import-linked source
files around the requested source range. It excludes the seed, unresolved text
matches and paths already requested or delivered in that session. This is a
syntactic approximation of the current investigation, not an inference about
the model's private reasoning or a complete call graph. Original reads and
unrestricted follow-up exploration remain available.

The existing tracked-source collector, freshness checks, byte budgets and
fail-open behavior remain. Native read ranges and literal numeric `sed` ranges
identify relevant definitions; literal multi-file `cat` is observed without
evaluating shell syntax. A read without an explicit limit is treated as a request
for the file, not proof that the provider returned every line. Path suppression
can omit useful unseen portions of a previously requested file; ordinary reads
remain the recovery path. Two attempts per session, four seconds per preparation
and 7,000 added bytes per result are unchanged. No model call prepares evidence.

Augmentation is serialized within a session so simultaneous reads cannot both
inject the same dependency. Cross-session source caching retains freshness
checks; findings and reviewer conclusions are not shared. New counters record
delivered files, observed reads, subsequent requests for delivered files,
unclassified shell calls, excluded candidates and empty packets. A subsequent
request is not necessarily waste: it can seek lines outside a supplied excerpt.
Unclassified calls prevent absence of an observed reread from proving avoidance.

The broad arm remains available as `JBOT_READ_EVIDENCE=1`; default remains `0`.
The run/cache configuration distinguishes all three settings. A plan with
`"readEvidence": "linked"` compares baseline, broad delivery and linked delivery.

## Mechanism probe

Three live sessions answered the same source-dependent arithmetic question.
`a.ts` imports `rate` from `b.ts`; the rate is absent from the prompt. The prompt
requires reading `a.ts` first but does not instruct the model to reuse a packet.
All three returned the correct result, 386.

| Arm      | Source reads | Total tools | Model turns | Delivered packets |
| -------- | -----------: | ----------: | ----------: | ----------------: |
| Baseline |            2 |           5 |           6 |                 0 |
| Broad    |            2 |           4 |           5 |                 2 |
| Linked   |            1 |           3 |           4 |                 1 |

Linked delivery supplied only `b.ts`, 1,379 added bytes, in 20 ms; no subsequent
read of `b.ts` occurred. Broad delivery supplied 3,183 added bytes, and the model
still requested `b.ts`. This is evidence of one removed dependency read in a
controlled task, not a review-quality or latency result.

The initial probe assertion incorrectly equated one source read with one total
tool call. The linked session also made a failed read and a file-discovery call.
The retained raw run failed that assertion; post-run adjudication checks actual
source reads and preserves every tool call. Files are under the ignored
`.jbot-review/jev-experiment-v9/` directory, including `probe.json`, transcripts,
the original `probe.log` and `probe-adjudication.json`.

## Natural review protocol

The adoption pilot uses the four existing clean/defective fixtures, one review
per arm per fixture (12 reviews), in seeded serial order. Keep all results,
including failed or slow runs. All arms use the same OpenCode route and effort,
full diff, verification and finding policy. Earlier preloading, checkpoints and
standalone retrieval remain disabled. Provider cache state is uncontrolled.

Only continue to repeated latency trials if delivery occurs naturally and the
tool traces support some replacement of later reads without losing seeded
defects. Before confirmation, add an unseen clean/defective contract pair and
freeze source, fixture SHAs, seed and settings. Compare findings against concrete
fixture contracts before interpreting time. A small synthetic comparison cannot
establish broad quality equivalence or justify a default-policy change.
