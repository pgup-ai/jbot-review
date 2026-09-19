# Jev caller-evidence prefetch: initial experiment

Date: 2026-09-19. Base: `2d8f9239424ba6644dcc36e0d45433eb74640974`.

Jev selected the relevant caller cheaply and consistently, but this pilot did
not demonstrate an end-to-end speedup. The experiment remains off by default.

## Implementation

`JBOT_JEV_PREFETCH=shadow` measures ranking without changing context; `on`
adds bounded original source excerpts to the existing caller list. Neither mode
changes review scope, session roles, verification, or finding disposition.

The implementation uses the documented TypeSafe HTTP API with pinned
`jev-1.13.0`, independent Noul questions, explicit candidate references, and
bounded state. It samples tracked source only, reuses the verifier's guarded
reader, shares excerpt formatting, and falls back to existing context on any
API failure. No SDK dependency was added. The tested credential remains only
in the ignored local `.env` (0600).

Selection keeps at most four excerpts, one per file, with relevance >= 0.5.
An initial probe without that floor filled spare slots with irrelevant name
mentions. The floor limits additive context; it never suppresses findings or
removes files from review.

## Local comparison

Frozen defect fixture: `7a0f10d057970d5ac1f543987167919f8bbe1a7b` -> `0d60294d66654349b121d32cb64f50801e5a2004`.
The only changed file widens `invoiceTotal` to accept readonly lines and starts
returning cents instead of dollars. The unchanged `chargeInvoice` consumer
still multiplies its result by 100 before calling `chargeCents`. Six other
source files mention the symbol only in metadata strings. All eight defect
candidates fit the request budget.

The clean counterfactual makes only the readonly parameter change, retaining
the dollar return value. Its frozen head is `10eb031557d76187039747ba8cc9a680ecd76bba`.

Both arms use `opencode/deepseek-v4-flash` through OpenCode 2.0.5, one review
shard, verification enabled, a five-minute run budget, and the same model
settings. Each has its own OpenCode server. Sessions can still search/read the
repository. Small-diff fan-out skips the separate guideline pass. Defect order
was off/on/on/off/off/on, followed by one clean off/on pair. Runs were serial;
provider caching was not cleared or controlled.

| Run           | Review seconds | Observed tool calls | Turns | Reviewer input | Reviewer output | Cache read | Retained findings |
| ------------- | -------------: | ------------------: | ----: | -------------: | --------------: | ---------: | ----------------: |
| fixture-1-off |         33.445 |                   7 |     6 |         52,729 |           2,250 |    108,032 |                 1 |
| fixture-2-on  |         29.680 |                  12 |     5 |         53,368 |           2,541 |     80,896 |                 1 |
| fixture-3-on  |         19.719 |                   3 |     4 |         52,232 |           2,343 |     52,480 |                 1 |
| fixture-4-off |         25.851 |                  12 |     7 |         53,280 |           2,230 |    132,096 |                 1 |
| fixture-5-off |         19.435 |                  11 |     5 |         52,692 |           2,040 |     79,104 |                 1 |
| fixture-6-on  |         29.433 |                  14 |     7 |         53,559 |           2,836 |    130,816 |                 1 |
| clean-1-off   |          7.647 |                   3 |     3 |         27,760 |             491 |     54,784 |                 0 |
| clean-2-on    |          8.169 |                   2 |     2 |         27,353 |             533 |     27,392 |                 0 |

Review seconds come from the run header and include context assembly and
teardown. Tool calls and turns sum completed review and verification session
observations. The table's token columns exclude Jev, whose usage is reported
separately; cache accounting follows the provider and must not be combined
into an invented cache-hit rate.

For the three defect runs per arm:

- Median review time: **25.851 s off, 29.433 s on**. Means were nearly equal:
  26.244 s and 26.277 s.
- Median observed tool calls: **11 off, 12 on**; median turns: **6 off, 5 on**.
- Jev overhead: **164–184 ms total**, including **132–150 ms API time**.
  Each call reported 1,832 input tokens and 140 output tokens, approximately
  **$0.000076944** at the published input-only price.
- Each treatment injected one 913-byte evidence block containing the relevant
  payment consumer. This is a per-context block size, not bytes summed over
  every session that receives it.
- All six defect runs retained one confirmed P1 about the seeded 100x overcharge.
  Manual inspection of the finding bodies confirms the trigger and unchanged
  caller evidence. Both clean runs produced no findings; the clean treatment
  also successfully injected caller context.

This is one deliberately small fixture and one clean counterpart, not a
representative quality or latency benchmark. Cache variation and model
sampling are material. The evidence supports cheap, relevant prefetching;
it does not establish faster reviews, lower total token usage, or a quality
improvement. A useful next experiment is a real cross-file PR where discovery
consumes several sequential tool turns, with repeated runs and adjudication.

## Measurements and validation

`Jev prefetch` log/telemetry rows include mode, algorithm version, pinned model,
request hash, candidates, selection, context bytes, timings, usage, estimated
cost, and fallback reasons. `Review timing` and `Review metrics` log rows expose
run outcome and per-session token/tool/turn observations. Run policy hashes
include the mode. `performance:review` preserves the Jev rows alongside each
run, so measurements need not be reconstructed from prose.

Local evidence is retained under `.jbot-review/jev-experiment/`: `manifest.json`,
`clean-manifest.json`, the frozen fixture repositories, comparison scripts,
per-run logs/reports/JSONL, and `performance.json`. These are gitignored.
The defect comparison records the driver's source diff hash
`bafd246d7f8f8e320c6bddc794e2b120855a5a0f0b1b802a9acdcd3db427c4cc`; subsequent changes are test assertions, cleanup with
unchanged request content, and this audit.

Validation: 1,072 tests passed; focused tests passed again after adding log-sink
and low-relevance assertions. Typecheck, lint, formatting, build, and
`git diff --check` passed. The key was checked absent from changed tracked
files and remains excluded from OpenCode server/session environments.

A separate full-branch dogfood attempt timed out at its 135-second main-session
limit and produced no review verdict. It is not counted as a successful review
or included in the fixture measurements. The eight fixture reviews completed.

The advisory core quality corpus (60 cases, three repetitions) was **not run**:
this is an initial default-off integration with bounded live comparisons, not
a proposed default-policy change. No quality-gate or benchmark-ledger pass is
claimed. The full corpus remains required before enabling the experiment by
default.

## Self-review and cleanup

Manual self-review found no remaining P1/P2 issue. Seams checked: caller
collection, source-read boundaries, prompt budgets, API response validation,
error handling, environment isolation, runner wiring, and measurement output.

Existing tracked-source reading and excerpt formatting were extracted and
shared instead of duplicated. A one-use question helper was inlined. All three changed comment blocks were kept:
the symlink/credential rationale, worst-case token budget rationale, and the
shadow-mode option contract. All four new tests were kept for distinct failure
classes: request budgets, ranking/response validation, integration and secret
isolation, and failure/no-evidence fallback. Existing assertions were retained.

Remaining limits: exported-symbol discovery can miss body-only changes;
candidate sampling is bounded; the full-branch model review timed out; broader
review-quality and performance effects remain unmeasured.

Sources: [API](https://docs.typesafe.ai/api),
[reranking](https://docs.typesafe.ai/cookbooks/rerank_typesafe),
[models and pricing](https://docs.typesafe.ai/models), and
[known limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13).

Net branch delta: +831 lines across 13 files; no untracked source files.
