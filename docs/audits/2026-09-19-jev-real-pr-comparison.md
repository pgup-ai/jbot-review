# Jev prefetch: randomized real-PR comparison

## Preregistered design

Continue `codex/jev-evidence-prefetch`. Compare `off`, `deterministic`, and `on`
without changing the review model, prompt policy, verification, or default
prefetch mode. The deterministic arm uses the same collected and byte-trimmed
candidate pool and the same greedy context-budget selection as Jev, but in
collection order with no relevance scoring, API request, or credential needed.
A candidate-pool hash checks comparability between active arms. The selected
window and actual injected bytes can differ; equal caps do not mean equal
context size.

Two immutable Git snapshots, with the entire original base...head diff:

- [PR #128](https://github.com/pgup-ai/jbot-review/pull/128), model pools:
  `ed9ffee02c531e83645490d062c893279cd2f1b0` →
  `3caf9803b6232dc9accc5e0d0d5c5258deaa1de7`. Nine changed files and nine
  unchanged reference files. This is the actual pre-fix PR commit, not a
  synthetic mutation. It contains the known provider-comma validation bug:
  `.github/workflows/jbot-review.yml` accepts `/jbot --provider=foo,bar`,
  forwarding an invalid provider rather than warning and using the default.
  Live review threads confirm maintainer acceptance and the later `3460b21`
  fix; direct inspection confirms the bug in this snapshot. Detection of this
  issue is a preregistered quality check. Other findings require adjudication.
  The usage list also includes references to the removed local `parseModelName`
  copy, whose consumers import the extracted package: this is real reference
  ambiguity rather than nine proven affected callers.
- [PR #148](https://github.com/pgup-ai/jbot-review/pull/148), advancing model
  selection on workflow reruns:
  `45318e46faaf6f55a16b2e1d3d9c8c16cc20dac4` →
  `cbbbeea5bd3a3b6c2635630e53639d7e1b312adc`. Five changed files and two
  unchanged reference files. No known defect is preregistered. Merged status
  and an empty review-thread list are not treated as proof of correctness.

Cases were selected by diff/caller shape and historical evidence before timing
any reviews. Preflight only collected candidates and called Jev in shadow mode:
#128 has 20 collected / 18 budget-admitted candidates; #148 has four. Both arms
share the same candidate hash per case. These preflights do not enter timings.

Run five repetitions of each case and arm: 30 reviews. In each repetition,
shuffle all six case/arm combinations using SHA-256 ordering and the fixed
random seed `4904fabfea39ad0a272896d81904d5f6`. Save the entire schedule before
the first review. Run serially with no local tests/builds overlapping timings.
Keep failed/incomplete attempts visible, with no automatic replacements or
retries. Record all observations; do not discard slow completed runs.

Use `opencode/deepseek-v4-flash` through OpenCode 2.0.5, main effort `medium`,
one shard/pass, existing dynamic fan-out and guidelines, independent finding
verification, ten-minute run budgets, and the first configured OpenCode key
throughout. Separate servers and artifact directories isolate each run.
Provider cache state and service latency cannot be controlled; log cache-read
usage and randomize order to reduce order bias. No GitHub posting takes place.

Primary measurements: total time including preparation, total provider-reported
cost plus estimated Jev cost, and known-issue detection / adjudicated findings.
Secondary: main and verification durations, tool calls, turns, input/output
and cache-read tokens, actual injected bytes, selection counts, and failures.
Report means, medians, ranges, and paired repetition differences separately per
PR. Five repetitions and two hand-selected PRs support directional observations,
not general statistical claims. A reduction in tools alone is not a latency
or cost win; any observed quality loss limits a favorable performance claim.

Adjudicate retained findings against frozen source, collecting unique findings
without arm labels first. This is a single-agent manual audit; knowledge of the
case history means it is not the corpus's independent blind-adjudication gate.
Do not enable prefetch by default based on this comparison.

## Reproduction and artifacts

The driver is `scripts/jev-prefetch-experiment.ts`. It consumes a JSON plan with
`seed`, `model`, and two `cases`, each carrying `id`, an absolute clean-worktree
`workspace`, immutable `base`/`head` SHAs, and the reference `pr` URL:

```sh
node --import tsx scripts/jev-prefetch-experiment.ts .jbot-review/jev-experiment-v3/plan.json
```

It refuses to overwrite an existing `runs/` directory, freezes the schedule,
checks source revisions between reviews, isolates output, and preserves each
review's logs, structured findings, report, and telemetry. Credentials load
from the driver's ignored `.env` into memory and are never saved in the plan.
The results directory also retains live GitHub metadata, source-only preflight
stats, the frozen Git worktrees, and validation logs. To reproduce, fetch the
recorded refs and create detached worktrees, then copy the plan to a new output
directory and update workspace paths. The original snapshot SHAs must remain.
