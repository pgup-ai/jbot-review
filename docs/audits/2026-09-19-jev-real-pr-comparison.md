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

## Execution notes

The driver is frozen at `7825fb98555a72144dadc2fe779784d0ad9cdca3` with a
clean runtime diff. The first PR #148 advisory was visible in its completed
run log before the arm-stripped collection was reviewed. Its adjudication is
therefore explicitly unblinded; no independent blind-quality claim is made.

## Results

All 30 scheduled reviews completed: five per case and arm, with no retries, exclusions, or failed/incomplete attempts. All 20 active-prefetch runs applied evidence successfully. Every run reported session costs. Timing includes context preparation; full-command time additionally includes local CLI setup and diff construction.

| PR   | Arm           | Full command mean (s) | Pipeline mean (s) | Median (s) | Range (s)      | MAD (s) |
| ---- | ------------- | --------------------: | ----------------: | ---------: | -------------- | ------: |
| #128 | Off           |               129.806 |           129.368 |    126.155 | 87.051–177.917 |  29.584 |
| #128 | Deterministic |               132.103 |           131.708 |    139.158 | 96.896–163.172 |  23.872 |
| #128 | Jev           |               109.257 |           108.831 |     95.547 | 93.986–141.513 |   1.561 |
| #148 | Off           |               112.780 |           112.354 |     41.803 | 25.637–262.883 |  16.166 |
| #148 | Deterministic |                87.415 |            87.001 |     55.854 | 39.563–238.587 |  15.606 |
| #148 | Jev           |                98.484 |            98.075 |     41.169 | 26.396–218.009 |  14.773 |

MAD is the median absolute deviation from the median. Cost below is the SDK-reported token estimate plus Jev input-token pricing, not an invoice or subscription charge.

| PR   | Arm           | Mean cost ($) | Median cost ($) | Range ($)         | Valid findings | Unsupported | Duplicate/overstated |
| ---- | ------------- | ------------: | --------------: | ----------------- | -------------: | ----------: | -------------------: |
| #128 | Off           |      0.037909 |        0.042195 | 0.030931–0.042618 |              3 |           0 |                    1 |
| #128 | Deterministic |      0.040794 |        0.042719 | 0.031799–0.050819 |              2 |           0 |                    1 |
| #128 | Jev           |      0.031840 |        0.033206 | 0.025645–0.036353 |              2 |           0 |                    0 |
| #148 | Off           |      0.020895 |        0.016299 | 0.014313–0.033588 |              0 |           1 |                    0 |
| #148 | Deterministic |      0.019885 |        0.017133 | 0.013220–0.030197 |              0 |           1 |                    0 |
| #148 | Jev           |      0.019753 |        0.018259 | 0.010319–0.032447 |              0 |           1 |                    0 |

Finding counts are emitted instances across five runs, not distinct bug counts. Preregistered provider-comma detections: **Off 0/5, Deterministic 0/5, Jev 1/5**. See the adjudication section for the distinct issues and limitations.

### Paired comparisons

Each pair uses the same case and repetition block; runs within a block were serial and randomized, not simultaneous. Negative deltas favor Jev.

| PR   | Comparison          | Mean full-command Δ (s) | Median Δ (s) | Range Δ (s)      | Faster pairs | Mean cost Δ ($) | Cheaper pairs |
| ---- | ------------------- | ----------------------: | -----------: | ---------------- | -----------: | --------------: | ------------: |
| #128 | Jev − Off           |                 -20.548 |        8.176 | -82.410–17.874   |          2/5 |       -0.006070 |           5/5 |
| #128 | Jev − Deterministic |                 -22.846 |      -20.012 | -67.578–2.380    |          4/5 |       -0.008954 |           4/5 |
| #148 | Jev − Off           |                 -14.296 |       -5.826 | -177.841–141.418 |          3/5 |       -0.001141 |           2/5 |
| #148 | Jev − Deterministic |                  11.069 |        0.940 | -212.144–178.510 |          2/5 |       -0.000131 |           2/5 |

### Where the work changed

All values below are means. Main execution is the run phase; guideline work can overlap it or continue into a separate grace wait. Tool/turn counts are specifically the main review session. Tokens aggregate all review-model sessions, including verification, and exclude the separately logged Jev request.

| PR   | Arm           | Main execution (s) | Verification (s) | Main tools | Main turns | Input tokens | Output tokens | Cache-read tokens |
| ---- | ------------- | -----------------: | ---------------: | ---------: | ---------: | -----------: | ------------: | ----------------: |
| #128 | Off           |            115.573 |           11.991 |       13.4 |       10.2 |      103,843 |        21,149 |           623,206 |
| #128 | Deterministic |            123.527 |            7.122 |       14.6 |       10.8 |      109,534 |        21,765 |           691,610 |
| #128 | Jev           |             96.137 |            4.871 |       10.6 |        7.4 |      103,373 |        17,430 |           432,486 |
| #148 | Off           |             96.381 |           14.844 |        7.0 |        5.6 |       77,520 |         9,241 |           266,240 |
| #148 | Deterministic |             79.246 |            6.626 |        6.0 |        5.0 |       76,360 |         9,711 |           231,270 |
| #148 | Jev           |             70.402 |           25.643 |        4.4 |        4.0 |       77,909 |        11,631 |           195,277 |

### Individual runs

| ID  | PR   | Repetition | Arm           | Pipeline (s) | Full command (s) | Estimated cost ($) | Retained |
| --- | ---- | ---------: | ------------- | -----------: | ---------------: | -----------------: | -------: |
| 01  | #148 |          1 | Off           |       41.803 |           42.266 |           0.016299 |        0 |
| 02  | #148 |          1 | Jev           |       36.112 |           36.440 |           0.013035 |        0 |
| 03  | #128 |          1 | Jev           |      141.513 |          141.938 |           0.028580 |        0 |
| 04  | #128 |          1 | Off           |      126.155 |          126.560 |           0.030931 |        0 |
| 05  | #128 |          1 | Deterministic |      139.158 |          139.558 |           0.034620 |        0 |
| 06  | #148 |          1 | Deterministic |       60.752 |           61.205 |           0.017133 |        0 |
| 07  | #148 |          2 | Jev           |      218.009 |          218.445 |           0.032447 |        1 |
| 08  | #128 |          2 | Deterministic |      144.027 |          144.431 |           0.044014 |        0 |
| 09  | #128 |          2 | Jev           |      117.951 |          118.350 |           0.025645 |        0 |
| 10  | #148 |          2 | Off           |      262.883 |          263.267 |           0.025891 |        1 |
| 11  | #148 |          2 | Deterministic |       39.563 |           39.935 |           0.013220 |        0 |
| 12  | #128 |          2 | Off           |       99.980 |          100.476 |           0.031210 |        0 |
| 13  | #148 |          3 | Deterministic |      238.587 |          238.971 |           0.030197 |        1 |
| 14  | #148 |          3 | Off           |      204.129 |          204.668 |           0.033588 |        0 |
| 15  | #128 |          3 | Off           |      155.739 |          156.126 |           0.042618 |        1 |
| 16  | #128 |          3 | Deterministic |       96.896 |           97.305 |           0.042719 |        2 |
| 17  | #128 |          3 | Jev           |       93.986 |           94.366 |           0.035413 |        0 |
| 18  | #148 |          3 | Jev           |       26.396 |           26.827 |           0.010319 |        0 |
| 19  | #128 |          4 | Deterministic |      163.172 |          163.551 |           0.050819 |        1 |
| 20  | #128 |          4 | Jev           |       95.547 |           95.973 |           0.036353 |        1 |
| 21  | #148 |          4 | Deterministic |       40.248 |           40.652 |           0.016877 |        0 |
| 22  | #128 |          4 | Off           |      177.917 |          178.383 |           0.042591 |        1 |
| 23  | #148 |          4 | Jev           |       41.169 |           41.592 |           0.018259 |        0 |
| 24  | #148 |          4 | Off           |       25.637 |           26.003 |           0.014313 |        0 |
| 25  | #148 |          5 | Off           |       27.319 |           27.698 |           0.014383 |        0 |
| 26  | #128 |          5 | Deterministic |      115.286 |          115.671 |           0.031799 |        0 |
| 27  | #148 |          5 | Jev           |      168.688 |          169.116 |           0.024708 |        0 |
| 28  | #148 |          5 | Deterministic |       55.854 |           56.314 |           0.021998 |        0 |
| 29  | #128 |          5 | Jev           |       95.159 |           95.659 |           0.033206 |        1 |
| 30  | #128 |          5 | Off           |       87.051 |           87.483 |           0.042195 |        2 |

## Interpretation

Jev shows a useful cost signal on the larger reference-pool case, but this is
not a reliable general latency or quality win:

- **PR #128:** full-command mean time fell **15.8%** versus off and **17.3%**
  versus deterministic. Estimated mean cost fell **16.0%** and **22.0%**,
  respectively. Jev was cheaper than off in **all five** paired repetitions,
  with fewer main tools and turns. However, it was faster than off in only
  **two of five** pairs; the median paired time difference favors off by
  8.2 seconds despite the favorable aggregate mean. Against deterministic,
  Jev was faster and cheaper in four of five pairs.
- **PR #148:** Jev's full-command mean was **12.7% lower** than off, but
  **12.7% higher** than deterministic. Its median pipeline time was nearly
  unchanged from off (41.2 vs 41.8 seconds). Estimated mean cost fell 5.5%
  versus off, but Jev was cheaper in only two of five pairs; it was within
  0.7% of deterministic's mean cost. There is no convincing incremental
  benefit from ranking the smaller candidate pool here.
- **Quality:** Jev found the known provider-comma defect once; both controls
  missed it in all five runs. Off found the auxiliary configuration issue
  once, while the other arms did not. The documentation issue appeared twice
  with off, twice with deterministic, and once with Jev. Off and deterministic
  each emitted a duplicate; all three arms emitted one unsupported advisory
  on PR #148. These sparse, manually adjudicated outcomes establish neither
  general superiority nor non-regression. Counting the configuration issue as
  outside the desired review scope would not change the low known-bug recall
  or the lack of an adoption-quality gate.

The expensive reviewer still determines end-to-end time. On PR #128, Jev cut
mean main execution by 19.4 seconds and mean verification by 7.1 seconds versus
off, while its mean grace wait grew from 0.7 to 6.4 seconds. On PR #148, main
execution fell by 26.0 seconds but verification grew by 10.8 seconds; the
single unsupported Jev advisory cost 128.2 seconds of verification. Jev's own
request is too small to explain these swings. Provider latency, model sampling,
different exploration/output, auxiliary tails, and uncontrolled caches remain
confounded. Cache-read counts are reported as usage, not inferred hit rates.

All ten Jev requests succeeded. End-to-end prefetch overhead was **171–281 ms**;
total estimated Jev cost was **$0.002496** out of **$0.855382** for all 30
reviews. Each PR #128 request cost $0.000377496 and each PR #148 request
$0.000121716. Deterministic preparation took 10–64 ms with no API usage.
PR #128 injected 4,462 bytes in deterministic mode versus 5,523–5,996 with Jev;
PR #148 injected 3,283 versus 3,950 bytes. This compares selection strategies
under equal caps, not equal-size prompts or ranking alone.

Keep the experiment **off by default**. Preserve deterministic prefetch as the
control. A worthwhile next step is a quality-first set of real cross-file
contract bugs with confirmed behavioral callers, including cases where the
baseline reliably detects the issue. PR #128's reference ambiguity and PR
#148's small pool limit what this batch says about that workload. Do not add
more production stages or claim a dependable speedup from these two cases.

## Integrity and artifact identity

All case worktrees remained clean at their frozen heads. The driver commit and
runtime diff hash remained unchanged. Within each case, normalized review
policy and execution settings had exactly one value across all 15 runs;
only the prefetch mode differed. Active arms shared one admitted-candidate hash:

- PR #128: `530c3836bf523e4247441adab8b6fd6d113e1b4a4a5e0bcb065e0d659ed78259`
- PR #148: `0863f7d536b2170911928c74e38fbddce08b4d143cf77a8c454fea52096b4949`

The ignored `runs/` directory retains raw logs, structured reviews, telemetry,
the arm-stripped finding collection and labels, and computed summaries. SHA-256:

- `manifest.json`: `42e4007fa071dd15d882b3d6ccafb3b52e36cdd82dc0ebe2d26e9f361f682247`
- `results.json`: `ec3e4cb715c0f62f97e834d6901e7a5266a2c618a1f95ee95a3905defd075d67`
- `adjudication.json`: `4af4cc006a57f7d6ecea223509638aa4da76f6c0d4cdc2f85d3a30d8f8a2bb88`

## Finding adjudication

Retained unverified advisories count as emitted findings and their verification
time remains in the measurements. They do not count as correct detections
without a concrete trigger supported by the frozen repository and its contracts.

Run 29 (Jev, PR #128, repetition 5) correctly detected the preregistered
provider-comma bug. Its trigger and before/after behavior match the frozen
workflow diff and the accepted later fix. The one detection is useful evidence,
but cannot establish a stable recall advantage or prove that ranked caller
evidence caused it.

PR #148 produced three unsupported advisory types:

- Rotating on successful reruns: the PR intentionally rotates on workflow
  reruns; failure-only gating is not its contract. The proposed duplicate-comment
  harm was not demonstrated after existing prior-finding suppression.
- Successful reruns resetting the attempt counter: this contradicts GitHub's
  documented behavior. `run_id` stays fixed and `run_attempt` increments on
  each rerun ([GitHub context reference](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#github-context)).
- Missing `GITHUB_RUN_ATTEMPT`: an absent variable could cause invalid arithmetic,
  but no supported deployment lacking it was established. GitHub documents it as
  a default variable available to workflow steps across runner environments.
  Neither self-hosting alone nor speculation about old GHES/`act` establishes a
  shipping regression ([GitHub variables reference](https://docs.github.com/en/actions/reference/workflows-and-actions/variables#default-environment-variables)).

The local arm-stripped finding pool, finding-to-run map, and rationale labels
are retained alongside raw results for inspection. These are manual labels,
not an independent blind adjudication or a passed review-quality corpus gate.

PR #128 also produced a valid P3 documentation-contract finding: the new README
promises that any pool typo fails the next run, but `resolveModelPool` only
validates syntax and only the selected model reaches execution. A syntactically
valid nonexistent candidate can remain unnoticed when another candidate is
picked. Narrowing that documentation is justified; rejecting arbitrary slash
prefixes would conflict with legitimate provider catalog IDs. This finding is
separate from the preregistered provider-comma runtime defect.
Run 16 emitted this same issue twice at different paths: a P3 README finding
and a P2 code finding. The latter adds no independent defect and overstates
the supported severity; count one useful documentation issue plus one
duplicate/overstated comment, not two correct detections. Run 30 repeated the
same documentation issue twice at adjacent README lines; it likewise counts
as one valid issue plus one duplicate.

Another PR #128 finding identifies a valid auxiliary-model startup-validation
gap. The new comma rejection is reached inside the webhook event handler,
after startup/authentication/clone; it throws before `runPrReview`, and the
handler only logs while the server continues accepting events. The commit
intends startup rejection, but the server reads auxiliary configuration without
invoking the new single-model validator. This P2 finding requires an invalid
comma-valued `JBOT_REVIEW_AUX_MODEL`; it is not a failure under valid settings.
The general deferred validation structure predates the PR. Count the missing
startup application of the new guard as a separate configuration-validation
issue, not as the preregistered provider-comma detection.

## Validation and scope

Before the timed batch, all **1,074 tests** passed, as did typecheck, lint, full
formatting, build, and `git diff --check`. No tests or builds overlapped measured
reviews. The runtime remained frozen at the recorded commit; only audit and
README documentation changed while the batch ran.

Manual self-review found no remaining P1/P2 issue in this continuation. Seams
checked: mode normalization, credential-free deterministic selection, identical
candidate admission and context caps, Jev response handling, additive prompt
injection, telemetry export, and isolated experiment-driver configuration.
The live runs exercise the real local review pipeline with verification;
they do not validate GitHub posting or CI behavior. This turn did not change
the Jev API contract, review model, finding filters, or default policy.

Cleanup: the shared bounded selection loop serves both arms; no dependencies
or speculative configuration knobs were added. This continuation adds zero
code comment blocks. Its one new test is kept because it uniquely catches the
deterministic control making an API call, requiring a key, fabricating model
usage, or selecting from a different admitted pool. Existing assertions remain.
The three comment blocks and five earlier tests retain their individual
adjudications in the preceding two audits.

The advisory core review-quality corpus was not run. These two selected PRs
and single-agent manual labels do not establish broad non-regression or satisfy
the independent blind-adjudication gate. There is no benchmark-ledger pass or
default-policy change.

Post-run documentation formatting, diff checks, artifact-integrity checks, and
credential scans passed. No credential appeared in the scanned changed files or
run artifacts; `.env` remains ignored and untracked.

Continuation net line delta: +624 across seven files; no untracked source files.
