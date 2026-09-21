# Read-triggered evidence delivery and DeepSeek Harness research

Continue `codex/jev-evidence-prefetch` from `b5df0aa`. All new policy remains
opt-in. The previous comparison proved that making `review_context` available
and recommending it did not cause natural adoption. This round tests delivery
through tools the reviewer already uses, then checks whether turns actually fall.

## What DeepSeek Harness contributes

Inspected the official repository at
[`ddefc45fbc7f8e46dd73185e68295696d1297887`](https://github.com/deepseek-ai/deepseek-harness/tree/ddefc45fbc7f8e46dd73185e68295696d1297887),
including code, package contracts, the linked
[GitHub review guide](https://deepseek-harness.github.io/deepseek-harness/en/guide/github-review)
and [quickstart](https://deepseek-harness.github.io/deepseek-harness/en/guide/quickstart).
Context7 confirmed the matching library and tool/plugin contracts. The checkout
is an ignored, read-only research reference; its dependencies were not installed
and its runtime was not launched.

- **Append new context after existing history.** The
  [instruction plugin](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/context/agent-instructions/src/index.ts)
  observes structured filesystem activity; its state tracks content digests so
  unchanged instructions are not injected repeatedly. The
  [package contract](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/context/agent-instructions/README.md)
  describes bounded, durable additions. Borrow the delivery principle for source
  evidence, retaining provenance, omissions and the existing cached prefix.
- **Respect provider-specific system-message semantics.** The
  [DeepSeek adapter](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/llm/llm-deepseek/README.md)
  declares in-history system updates only on capable routes. This is not a
  portable license to relocate system messages. Our prior experimental checkpoint
  hook changes the assembled system prefix; that is a possible cache cost, not a
  measured cause of its latency. Checkpoints are disabled in this comparison.
- **Batch work inside a turn.** The
  [scheduler](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/core/agent-loop/src/tool-calls.ts)
  overlaps parallel-safe calls with bounded concurrency and ordering barriers.
  [Programmatic tools](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/core/tools/src/ptc.ts)
  support composition within one call. This can reduce model round trips when
  work is actually batched; a scheduler cannot eliminate sequential decisions
  the model still makes. We already have session concurrency and OpenCode tools;
  this round targets evidence delivery instead of replacing the harness.
- **Compact only under measured pressure.** The
  [result pruner](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/compaction/compaction-tool-result-pruner/README.md)
  trims oversized text at compaction time and preserves originals in its log.
  Blind head/tail pruning is a poor default for review evidence because the
  decisive branch can be in the middle. Our original requested output stays intact.

The linked GitHub integration creates a read-only review session from a signed
webhook and pins the head SHA. It is not a published review-quality benchmark,
and the guide does not promise durable webhook deduplication or automatic
finding verification. Our full-diff union, trust-boundary filtering, prior-thread
handling and independent verifier remain in place.

DeepSeek's [V4.1 announcement](https://api-docs.deepseek.com/news/news260910/)
documents a smaller KV-cache footprint and lower cache-hit cost. That does not
establish the highest cache-hit _rate_ across harnesses. Its
[cache contract](https://api-docs.deepseek.com/guides/kv_cache/) is prefix-based
and best-effort. Repeatedly resending a large warm history can raise the hit
percentage while a review gets slower. Track uncached input, output tokens,
model turns, total cost and wall time alongside the rate. The official endpoint
also documents legacy V4 aliases routing to V4.1; this comparison keeps the same
`opencode/deepseek-v4-flash` route, rather than claiming a provider alias proves
an immutable underlying model revision.

## Implementation and boundaries

`JBOT_READ_EVIDENCE=1` extends the trusted OpenCode plugin's successful-tool-result
hook. Native source reads and the existing literal `cat`/numeric `sed` parser
supply a repository-relative location. Unknown shell grammar is not interpreted
or executed by the observer. A session attempts at most two distinct JS/TS paths;
its source packet uses the existing deterministic, guarded evidence collector.

Each attempt has a four-second preparation budget, at most four excerpts, and
at most 7,000 added text bytes including separators and omission notices. Attempts
are reserved before awaiting, so concurrent reads cannot overrun the two-attempt
limit. Repeated seed paths do not trigger more packets. The original tool output
and metadata remain intact; failed calls and tool-less agents are unchanged.
Preparation failure leaves the original result intact. Tool schemas, the system
prefix and earlier conversation history do not change. Ordinary deeper reads
and full-diff coverage stay available. No Jev or other model call prepares a packet.

The new numeric counters distinguish attempts, packets, added text bytes,
preparation milliseconds and fallbacks. They enter existing per-prompt exploration
rows and configuration/cache identity. Delivered bytes are not counted as saved
reads. Only a controlled reduction in tool calls/turns with retained quality can
support that claim.

OpenCode's [documented after-hook](https://opencode.ai/v2/docs/build/plugins)
permits replacing the completed result. The installed 2.0.5 plugin declaration
was checked without installing a new dependency. A live smoke test read `a.ts`,
received its imported rate from `b.ts` in the appended packet, and answered 137
with one tool call and two model turns. Preparation took 12 ms. This establishes
one successful avoided dependency read, not an end-to-end review speedup.

## Experiment protocol

A separate eight-run adoption pilot uses the four previous clean/defective
fixtures, one repetition per arm. The arms are baseline and automatic read
evidence; standalone retrieval, checkpoints and earlier preloading are disabled.
If actual delivery works, freeze a fresh serial seeded comparison with three
repetitions, retaining failures, missing findings and slow rows. The model route,
effort, full diff and independent verification settings stay equal. Provider
cache state is uncontrolled. Results and manifests are ignored local artifacts
under `.jbot-review/jev-experiment-v8/`.

The adoption pilot completed all eight runs. All four treatment reviews received
packets: 11 total, 22,645 added bytes and 133 ms preparation, with no fallback.
Both arms retained the four expected defects; baseline's three original defects
were unverified P3s after an incomplete verifier response, and it also produced
an unsupported P2 on the clean chain. Treatment retained four confirmed P1s and
no clean-case finding. These labels were manually checked against the fixtures,
not independently blind-adjudicated.

Pilot mean turns fell 7.25 to 6.00 and tool calls 12.75 to 9.25. Median time was
19.77 to 19.20 seconds, but mean time rose 21.00 to 31.21 seconds because one
treatment took 81.89 seconds. No timeout/retry explained that row in the log; do
not invent a provider cause or discard it. The pilot establishes natural delivery
and motivates replication, not a latency win. Its rows remain separate.

The next frozen comparison uses three repetitions of all four fixtures (24
reviews), seed `read-evidence-confirmation-2026-09-19`. The implementation is
unchanged from the pilot; tests, formatting and build passed before freezing.

## Frozen comparison results

Revision `b04aa59`; all 24 scheduled reviews completed with no process failure or
incomplete session. Pilot rows do not enter this table. No run was retried or
removed. Each arm reviews each of four fixtures three times.

| Metric                                  | Baseline | Read evidence |
| --------------------------------------- | -------: | ------------: |
| Mean total seconds                      |    19.23 |         19.57 |
| Median total seconds                    |    20.06 |         19.77 |
| Mean tool calls                         |    10.00 |         10.92 |
| Mean model turns                        |     5.83 |          6.08 |
| Mean tool-output bytes                  |    4,742 |        10,766 |
| Mean uncached input tokens              |   43,391 |        46,886 |
| Mean output tokens                      |    2,631 |         2,979 |
| Mean cache-read tokens                  |  114,624 |       120,533 |
| Mean reported cost, USD                 |  0.01002 |       0.01077 |
| Expected defects retained, confirmed P1 |    12/12 |         12/12 |
| Unsupported clean-case P1 findings      |        0 |             1 |
| Unsupported clean-case P3 advisories    |        1 |             1 |

The treatment delivered 33 packets, totaling 66,496 text bytes, with 471 ms
preparation and no fallback. This proves delivery, not universal use. It increased
model-visible tool output by about 2.3 times. Main-review mean time decreased
13.76 to 12.38 seconds, while verification increased 4.45 to 6.12 seconds,
canceling the gain before preparation/teardown overhead. Mean cost rose about
7.5%. Weighted cache-hit share was about 72.5% versus 72.0%, calculated as
cache-read / (uncached input + cache-read); neither a high share nor more cached
tokens establishes less total work.

All 27 retained findings were manually checked in an arm-masked list against the
fixture contracts. This is not independent blind adjudication: the investigator
knows the fixtures and saw some progress. The three clean-case findings assume
a direct external dollar caller of internal payment-chain functions, absent from
the fixture's checkout contract. One treatment verifier incorrectly retained
that premise as P1; both other instances became P3 advisories. Root-cause
detection was retained, but precision equivalence is not established. Detailed
labels, mappings and summaries are in `confirmation/runs/`.

### Narrow signal and its limits

For the multi-hop defect, all three treatment pairs were faster: mean 25.85 to
19.10 seconds, turns 10.67 to 9.00, tools 18.00 to 15.67, with the defect retained
in every run. This subgroup is exploratory and cannot override the global
quality/latency result. Inspecting tool logs explains why attribution needs care:

- Trial 21 received packets and skipped the separate native reads of checkout
  and dispatch that appeared in baseline trial 23. Its log also contains a
  truncated shell command, so the log alone cannot prove every avoided byte.
- Trial 11 batched shell reads and received no packet in the main session. Its
  two packets arrived during verification. Its main-review improvement therefore
  cannot be credited to main-review evidence delivery.
- Trial 04 still requested the individual chain files after receiving packets.
  Successful packet delivery did not reliably replace subsequent reads.

**Decision: keep the flag off.** The smoke probe demonstrated one actual avoided
dependency read, but natural reviews did not reduce total round trips. More
broad injection is not supported. Further work should make the packet specific
to an unresolved contract, omit already supplied source, include the concrete
caller/callee/test relationship, and measure subsequent rereads before extending
latency trials. Do not teach the model a clean/defective fixture label, suppress
findings, cap dependency depth, or waive independent verification to obtain a win.
The narrow chain signal merits that focused investigation; it does not justify
a production policy flip or a larger untargeted rollout of this implementation.

## Self-review and validation

Applied `jbot-review-pr-self-review` and `jbot-review-de-slop`. Inspected the
current-round diff from `b5df0aa` and its existing full-branch seams/audits against
`origin/main` (`2d8f9239424ba6644dcc36e0d45433eb74640974`). Rechecked source
admission, per-session concurrency, error/fallback paths, original result and
metadata preservation, tool-less agents, prompt ordering, cache identity and
numeric-only telemetry. The runner remains unchanged; no new dependency or
provider surface was added.

Current-round comment adjudication: one kept, zero rewritten/cut. The reservation
comment explains why incrementing before an await enforces the shared limit.
Current-round added tests: two kept, zero folded/cut. The concurrent delivery
case uniquely catches over-budget parallel packets while pinning original
results, failed calls, wrap-up exclusion, repeated-path suppression and untracked
source fallback. The admission test catches disk writes for a ninth 250 KiB
source that cannot fit the remaining 2 MiB budget. Existing policy, telemetry and
source tests were extended without weakening their previous checks.

The built full-branch local dogfood completed in 235.3 seconds, with no incomplete
session, against the frozen runtime at `b04aa59`. It made 51 tool calls across
51 model turns, delivered five packets (21,529 added bytes, 183 ms preparation,
zero fallback), and reported $0.14568 in model cost. It returned three P3
suggestions and no P1/P2. This is one functional run, not a speed comparison.
Its manifest, captured diff, review and transcripts are in `dogfood/`.

Each retained suggestion was manually adjudicated:

- **Applied the avoidable indexing fix.** The source-admission guard previously
  ran after parsing and index persistence. It now runs before both. The guarded
  reader can still read up to 256 KiB to check a source, so this does not claim
  zero I/O for rejected files. The regression test failed with nine index writes
  before the fix and passes with eight. No extra stat/read path was added.
- **Not applied: enable source reuse in the non-shared baseline.** That mode is
  an intentional experimental control. The automatic read-evidence tool already
  creates an `EvidenceStore` with `shared: true`, including freshness checks;
  the finding's claim that this arm uses non-shared reads is incorrect.
- **Applied the source-filter cleanup.** The evidence collector and Jev prefetch
  now share the same case-insensitive extension filter. The retrieval observer
  also reuses the indexer's JS/TS filter. Uppercase source extensions are checked
  by existing source tests; both checks failed before the fix.

These small follow-up fixes were made after the frozen comparison and dogfood;
the timing table still describes `b04aa59`, not the follow-up revision. No
latency improvement is attributed to the cleanup. The fixtures use small files
with lowercase extensions. Defaults remain off.

Validation passed before the frozen comparison: formatting, typecheck, lint,
1,089 tests and build. A fresh build preceded the full-branch local dogfood.
After cleanup, formatting, typecheck, lint, all 1,090 tests and build passed.
The focused evidence/retrieval/telemetry suite passed all 24 tests. Diff checks
passed and the tracked diff contains no configured credential values.
Packaging entry points and CLI versions are unchanged in this round; the
preceding audit includes the Docker slim build/import validation for this bundle.
No new Docker image is published.

Round diff from `b5df0aa`: 519 additions, 67 deletions (net +452), including
this 249-line audit. No untracked deliverables remain. Self-review found no
remaining P1/P2 issue; the quality and latency limits above remain unresolved.

The advisory core corpus with three repetitions and independent adjudication
was not run. These selected synthetic fixtures cannot establish broad quality
equivalence, and no benchmark-ledger pass or default-policy change is claimed.
