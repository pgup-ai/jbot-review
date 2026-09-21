# Jev versus deterministic evidence handoff

The first handoff pilot improved a small fixture. Broader testing gave mixed
results: no average latency gain on historical PR #128, and a promising but
variable improvement on a dependency-heavy synthetic fixture. Keep this local
experiment offline while fixing evidence packing; neither result establishes a
production default or a reason to publish unresolved claims.

## Comparison

CommandCode 1.56.2, `commandcode/meta/muse-spark-1.3-contributor`, low effort,
native tools. Each case ran one main review, froze its findings plus explicitly
seeded candidates, then ran three repetitions of three verifier arms:

- Control: complete diff and production's existing cited-source context.
- Handoff: the same input plus deterministically selected native source excerpts.
- Jev: the same candidate pool and limits, ranked by `jev-1.13.0`.

The order rotated across repetitions. Sessions were fresh and calls serial;
provider caches were not reset. Timings include selection and verification,
including Jev latency, but exclude the shared main review and source extraction.
This measures verification, not total review latency. Native benchmark output,
token usage, candidate hashes, selections and fallback status were retained.

Both selection arms reuse `buildJevPrefetch`: four excerpts, 6,000 packet bytes,
and at most 2,048 bytes per candidate. These are tighter limits than the first
pilot's eight excerpts and 16 KiB; comparisons across those pilots are not paired.
Mandatory diff and cited-source context are never removed. Native investigation
remains available when the packet omits evidence.

## Results

Mean seconds across three repetitions per arm:

| Case                                     | Control | Deterministic |  Jev |
| ---------------------------------------- | ------: | ------------: | ---: |
| Historical PR #128                       |    20.4 |          21.0 | 20.9 |
| Dependency fixture, read + grep evidence |    58.6 |          52.1 | 40.7 |

Individual seconds, in control / deterministic / Jev order:

| Case               | Repetition 1             | Repetition 2             | Repetition 3             |
| ------------------ | ------------------------ | ------------------------ | ------------------------ |
| PR #128            | 16.495 / 11.161 / 39.682 | 27.994 / 19.957 / 11.387 | 16.796 / 31.882 / 11.524 |
| Dependency fixture | 64.215 / 42.964 / 62.945 | 51.216 / 71.851 / 18.528 | 60.253 / 41.554 / 40.520 |

PR #128 supplied only two eligible excerpts. Both arms selected both; Jev changed
their order in one repetition. There was no evidence-selection advantage. The
main reviewer emitted no findings, so verification used the known provider-comma
defect and two false claims. All nine calls confirmed that defect and refuted the
empty-pool and random-selection claims. Handoff cannot recover a defect that the
main reviewer never emits.

The synthetic repository has 23 files but only two changed files: this is a
dependency-selection stress case, not a large-PR coverage test. Fifteen eligible
excerpts competed for four slots. Deterministic selection chose `charge`,
`document`, `receipt` and `round`; Jev chose `charge`, `document`, `membership`
and `records`. The latter two address the claims more directly.

| Dependency fixture mean                 | Control | Deterministic |    Jev |
| --------------------------------------- | ------: | ------------: | -----: |
| Model turns                             |     4.0 |           3.3 |    3.3 |
| Native tool calls                       |    13.7 |          11.7 |    9.7 |
| Cumulative input tokens                 |  69,512 |        61,019 | 60,489 |
| Input tokens minus reported cache reads |  40,491 |        22,190 | 19,873 |

Jev was faster than deterministic selection in two of three repetitions, but
both had exactly the same turn counts in every pair: 3, 3 and 4. Cache hits and
API durations varied substantially. The roughly 22% lower mean does not establish
a stable causal speedup. Verifiers continued retrieving source outside the packet.

All nine calls confirmed both fixture defects and refuted both false claims.
Executable checks reproduced charging 190,000 rather than 1,900 cents and denying
a legitimate tenant member, and confirmed that missing orders throw and disabled
memberships are rejected. Generated P0 severities and broad authorization wording
were not justified by those checks. Correct root verdicts are not proof of correct
severity, anchors or publication-ready prose.

Jev added 140–238 ms per call across the two headline cases, with no fallback.
Estimated Jev cost was $0.000096642 per historical call and $0.000230412 per
dependency-fixture call, using the existing client's input-token estimate. The
integration reuses the documented [Noul relevance-ranking approach](https://docs.typesafe.ai/cookbooks/rerank_typesafe),
[API contract](https://docs.typesafe.ai/api) and [model pricing](https://docs.typesafe.ai/models).

## What the experiment exposed

The original observer captured file reads but missed source returned by native
grep. A preliminary fixture suite had only four eligible candidates and averaged
54.4 / 35.7 / 17.6 seconds. All verdicts were correct, but selection membership
was identical. Those runs are retained as a diagnostic, not pooled with the final
suite. The observer now accepts native grep's numbered match/context lines only
when each line matches the tracked checkout. Unsupported formats remain excluded.
A fresh main review supplied the final 15-candidate pool; its different findings
and read order prevent attributing cross-suite improvements to the observer fix.

The four-excerpt cap also leaves much of the byte budget unused: packets were
3,047 bytes deterministic and 3,346 bytes with Jev. Both repeat cited source
already in the verifier prompt. All 15 excerpts together fit in 6,937 bytes,
within the first pilot's allowance. Before adding semantic ranking to production,
test removing already-delivered lines and packing by available bytes. Use Jev
only when useful evidence still exceeds that budget.

## Reproduction and limits

Run `scripts/native-handoff-experiment.ts` with the plan format documented in
[the first pilot](2026-09-21-native-handoff.md), a clean pinned fixture, CommandCode
1.56.2 on PATH, `COMMANDCODE_ACCESS_KEY` and `TYPESAFE_API_KEY`. It now always runs
all three arms. Candidate snippets are sent to TypeSafe in the Jev arm; native
tools and verifier execution remain CommandCode's. Failed Jev selection falls
back to deterministic packing and is recorded separately.

Local artifacts live under `.jbot-review/native-investigation/`:

- `jev-pr128/`, plan `jev-pr128-plan.json`, ground truth `pr128-ground-truth.json`.
  Fixture base `ed9ffee02c531e83645490d062c893279cd2f1b0`, head
  `3caf9803b6232dc9accc5e0d0d5c5258deaa1de7`.
- `jev-large-search/`, plan `jev-large-search-plan.json`, ground truth
  `large-ground-truth.json`. Synthetic base
  `2dbd3728787b760336999cf12683d2e379d54ba4`, head
  `5f4a6e2647a42a0147f5b79a92c8bcbc0d5ed7c4`.
- `jev-large/` retains the preliminary read-only observer diagnostic.
- `jev-handoff-summary.json` contains the per-call comparison.

Manifests record script hashes, CLI version, diff and revisions. Raw fixtures,
source packets and results remain private local artifacts. The historical and
preliminary suites predate grep capture; the final suite hashes the updated
observer. The 27 verifier calls are repeated measurements of two cases, not 27
independent quality cases. No full quality-corpus run or production default flip
was performed. Unverified-inline publication remains a separate precision policy.

Self-review: no P1/P2 issues found. All 1,114 tests, typecheck, lint, formatting
and build passed; the final suite's script hashes match the reviewed files.
De-slop retained the branch's one catch comment (unsupported syntax must not
disable citation selection) and two new test cases: one catches double-counted
tool time or unsafe benchmark fields; the other catches stale/failed source
handoff and overlapping-line inflation. This follow-up extends that source test
instead of adding cases. Duplicate packet-packing logic was removed in favor of
the existing selector. No production prompt, tools or publication policy changed.
