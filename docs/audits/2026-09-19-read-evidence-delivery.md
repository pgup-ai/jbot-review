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
