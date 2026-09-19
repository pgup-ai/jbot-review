# Jev exploration and verification experiment

## Preregistered design

Continue `codex/jev-evidence-prefetch`, with both new evidence stages default off.
Code collects bounded source and documentary evidence; Jev independently scores
candidate relevance; the existing review model retains all reasoning and verdict
responsibility. No finding is suppressed by a Jev score. Deterministic selection
shares the candidate pool, admission budget, packet wording, and selection caps.

Two serial randomized comparisons, three repetitions per case/arm:

- Frozen verification (18 calls): the existing synthetic defective money-contract
  snapshot supplies one true invoice double-conversion finding and one false claim
  that unapproved credits bypass the caller guard. PR #148's original rerun concern
  supplies the external-contract case. Its claim that model rotation causes
  duplicate threads is unsupported: reruns preserve the head and prior-thread
  suppression still runs. Confirmation is incorrect; uncertainty is reported
  separately from a successful refutation. Findings are identical across arms,
  with prior verifier commentary removed. Active arms receive two attributed
  summaries of current official GitHub documentation; off uses usual source.
- End-to-end (18 reviews): the previous clean/defective synthetic snapshots, with
  three known double-conversion bugs in the defective case and no known defect in
  the clean case. Both new stages use the same arm. Full diff, fan-out, verification,
  and filters remain active. No documentation bundle is provided to these runs.

All runs use OpenCode 2.0.5 and `opencode/deepseek-v4-flash`, main effort medium,
verification low, and the first configured credential. The shared driver freezes
Git SHAs, finding/document hashes, runtime revision, and seeded schedule before
running. Seed: `jev-v4-frozen-evidence-2026-09-19`. One run at a time; no tests or
builds overlap timings. Cache state is uncontrolled and recorded. Verification
has a three-minute budget; whole reviews retain ten minutes. No retries or
exclusions, and no GitHub posts. Failed/unusable verdicts count as unverified,
never correct. Incorrect refutation of a true finding is a recall failure.

Primary outcomes: elapsed verification/pipeline time including preparation,
provider cost plus Jev input-token estimate, and correct verdicts/known-bug recall.
Secondary: tools, turns, cache tokens/hits, selected bytes/hashes, and phase times.
Report case-specific means, medians, ranges and matched repetition differences.
This small convenience sample is directional and does not establish general
speedups. The corpus quality benchmark is separate; no default is promoted here.

## Reproduction

The extended `scripts/jev-prefetch-experiment.ts` accepts `repetitions`, `evidence`,
an optional absolute `docs` snapshot path, and optional per-case `findings` paths.
Cases with findings invoke `scripts/jev-verification-trial.ts`; other cases invoke
the real local review pipeline. Workspaces must be clean immutable Git snapshots.

```sh
node --import tsx scripts/jev-prefetch-experiment.ts .jbot-review/jev-experiment-v4/verification/plan.json
node --import tsx scripts/jev-prefetch-experiment.ts .jbot-review/jev-experiment-v4/end-to-end/plan.json
```

Local plans, documentation summaries, expected labels, full logs, telemetry,
and outputs live under ignored `.jbot-review/jev-experiment-v4/`.
Official documentation checked before freezing:
[GitHub contexts](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts),
[rerunning workflows](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs).
The documentation packet is a manually attributed summary, not a signed or
independently authenticated source. Its hash establishes repeatability only.

## Implementation review

`@babel/parser` 7.29.9 adds bounded syntax parsing without executing project
configuration. TypeScript 7's installed package no longer exposes the stable
compiler API, so it was unsuitable for this use. Context7's Babel documentation
confirmed the parser contract. Named imports are syntactic links, not compiler
bindings; default/namespace imports, reexports, aliases, and unsupported syntax
remain fallback exploration. No attempt is made to prove absence of callers.

Packets remain additive. Source checks reuse tracked-file/symlink protections.
An invalid documentation bundle or evidence failure leaves normal verification
active. Cache entries are run-local and revalidated by source content hash.
Both active arms receive the same documented evidence budgets. Telemetry records
selection and candidate hashes, and separates selection bytes from coverage bytes.

Cleanup: kept the three new comment blocks because they explain budget priority,
document admission priority, and unsupported-syntax fallback. Kept four new test
cases: body-only discovery and alias parsing; protected source/admission/cache
invalidation; malformed-doc/time-budget fail-open; and evidence callback failure
not skipping the independent verifier. No existing assertion was weakened.
