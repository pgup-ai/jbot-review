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

## Frozen verification results

All 18 scheduled attempts produced artifacts without process failure or retries. Two verifier outputs were unusable JSON (local/off repetition 3; rerun/deterministic repetition 3); these remain included in time/cost summaries and count as unverified, not correct. No true finding was incorrectly refuted.

| Case           | Arm           | Mean seconds | Median | Range          | Mean cost ($) | Tools | Turns | Verdict outcomes                 |
| -------------- | ------------- | -----------: | -----: | -------------- | ------------: | ----: | ----: | -------------------------------- |
| local-contract | off           |        6.963 |  6.452 | 4.485–9.951    |      0.004051 |  1.33 |  1.67 | 2/3 both correct; 1 unverified   |
| local-contract | deterministic |        4.358 |  4.134 | 3.573–5.368    |      0.003957 |  0.67 |  1.33 | 3/3 both correct                 |
| local-contract | on            |        6.082 |  6.367 | 4.419–7.459    |      0.004592 |  0.67 |  1.67 | 3/3 both correct                 |
| rerun-contract | off           |       60.450 | 49.250 | 30.259–101.842 |      0.014016 | 11.33 |  8.00 | refuted, confirmed, confirmed    |
| rerun-contract | deterministic |       34.019 | 39.871 | 18.802–43.385  |      0.011850 |  8.67 |  7.33 | uncertain, confirmed, unverified |
| rerun-contract | on            |       64.477 | 52.705 | 17.096–123.631 |      0.013191 |  7.67 |  8.00 | confirmed, confirmed, confirmed  |

Times include evidence collection and ranking, and exclude server startup; process times are separately recorded. Costs combine SDK-reported model estimates with Jev input pricing. Three repetitions cannot establish significance.

The local true/false pair was adjudicated directly from unchanged consumers: invoice dollars are multiplied a second time; `processCredit` returns before calling the processor when `approved` is false. For the rerun concern, `run_attempt` does advance on any rerun, but that proves the mechanism rather than the alleged duplicate-thread harm. The frozen repo still calls `suppressPreviouslyReported` (`src/shared/runner.ts`) and avoids a redundant clean review through `shouldPostReviewComment` (`src/shared/filter.ts`). Extra model cost is inherent to rerunning the review, not a defect introduced by selecting another model. Confirming this hypothesis is scored as unsupported; uncertainty is conservative but not a successful refutation. Labels are manual and unblinded, not an independent corpus gate.

Jev versus off was faster in 2/3 local pairs but only 1/3 rerun pairs. Mean differences were −0.881 s and +4.027 s respectively. Versus deterministic, Jev was faster in 1/3 pairs for each case; mean differences were +1.723 s and +30.458 s. The deterministic rerun mean includes its unusable-output attempt; its two usable attempts averaged 41.628 s, still with no correct refutation.

Jev removed source reads in two local runs, but did not consistently reduce verifier turns or cost across cases. The rerun on-arm confirmed the unsupported concern in 3/3 trials; off did so in 2/3 and deterministic in 1/3, with the latter also producing one uncertain and one unusable output. This comparison does not support adopting document-assisted verification. Supplied documentation can anchor the verifier on a true platform fact while leaving the alleged harm unproven. Trial 12 still did fresh web searches/fetches and took 123.631 s.

## End-to-end results

All 18 full-review runs completed with no incomplete sessions, retries, or exclusions. All nine defective reviews retained exactly the three expected invoice/credit/refund double-conversion bugs, with high confidence and no verification uncertainty. All nine clean reviews retained zero findings. These fixtures test one narrow family of cross-file bugs, not general review quality.

| Case   | Arm           | Mean seconds | Median | Range         | Mean cost ($) | Main seconds | Verification seconds | All tools | All turns |
| ------ | ------------- | -----------: | -----: | ------------- | ------------: | -----------: | -------------------: | --------: | --------: |
| clean  | off           |       10.155 | 11.049 | 4.858–14.557  |      0.005163 |        9.087 |                0.000 |      4.67 |      2.33 |
| clean  | deterministic |        4.165 |  3.282 | 3.108–6.106   |      0.004314 |        2.992 |                0.000 |      0.67 |      1.33 |
| clean  | on            |        5.667 |  6.261 | 4.310–6.429   |      0.004588 |        4.189 |                0.000 |      0.67 |      1.33 |
| defect | off           |       24.930 | 25.758 | 21.644–27.389 |      0.011701 |       17.505 |                6.431 |     11.67 |      6.00 |
| defect | deterministic |       29.539 | 29.392 | 24.166–35.060 |      0.010961 |       16.842 |               11.598 |      6.67 |      4.67 |
| defect | on            |       25.429 | 25.095 | 20.376–30.816 |      0.011650 |       16.627 |                7.459 |      5.00 |      4.33 |

Jev was faster than off in 2/3 clean pairs and 1/3 defective pairs. Against deterministic it was faster in 0/3 clean pairs and 1/3 defective pairs; the latter comparison’s favorable mean (−4.110 s) is driven by the third pair (−14.684 s). Fewer tools and turns did not reliably reduce elapsed time. Neither active arm improved the defective-case mean over off.

### Tokens and preparation

| Case   | Arm           | Mean input tokens | Output tokens | Cache-read tokens | Mean full-command seconds |
| ------ | ------------- | ----------------: | ------------: | ----------------: | ------------------------: |
| clean  | off           |             28194 |           663 |             36779 |                    10.489 |
| clean  | deterministic |             28205 |           340 |              9643 |                     4.524 |
| clean  | on            |             28439 |           309 |              9387 |                     6.069 |
| defect | off           |             54818 |          3330 |            110507 |                    25.297 |
| defect | deterministic |             56773 |          3233 |             75264 |                    29.895 |
| defect | on            |             57604 |          3626 |             69205 |                    25.809 |

All 30 active preparations applied successfully, including 15 Jev calls. Jev API latency was 156–274 ms (mean 206 ms), and its total estimated cost across both suites was $0.004770. The full verification/main review often took seconds or tens of seconds despite this fast auxiliary call. All six end-to-end verification preparations reused 15 cached source indexes with zero newly parsed files. This avoids repeated syntax parsing; guarded file reads and hash checks still occur.

## Interpretation and next constraint

Keep both stages opt-in. The clean fixture supports deterministic source preloading, and the frozen local pair supports code-managed evidence reuse; neither proves a universal win. Jev ranking has not demonstrated a repeatable advantage over the deterministic control in this round. Document-assisted verification is not ready for promotion: the platform fact was correct, but the verifier often promoted it into an unsupported harm claim.

The useful division remains: code handles exact retrieval, parsing, hashing, bounds and cache invalidation; Jev makes narrow relevance judgments; the independent reviewer proves triggers and harm. Jev itself is probabilistic. A future retrieval iteration should prioritize evidence absent from the existing prompt and explicitly cover possible guards/refutations, then repeat the fixed-finding quality comparison before evaluating speed. This round does not implement a compiler call graph, persistent index, arbitrary documentation crawler, or replacement verifier.

The frozen verifier and combined end-to-end comparison are not a factorial ablation: they cannot assign an end-to-end gain solely to exploration or verification. Documentation and source preloading were changed together in the active frozen-verification arms. The false-positive result therefore does not isolate documentation, selection, and stochastic verifier behavior as causal factors.

## Artifact integrity

Runtime was frozen at `fdb40d9` for both suites. Every process exited zero; auxiliary verdict failures are detailed above. No tests/builds overlapped measured trials. Full artifacts remain local and ignored. Candidate hashes matched across active frozen-verification arms for each case. Exploration candidate hashes were stable per end-to-end case. Verification pools in end-to-end runs can differ with generated finding text and citations.

| Suite        | Manifest SHA-256                                                   | Results SHA-256                                                    |
| ------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| verification | `600ac17d295a2c958e8d1646927d8ee74da899c7211d0e4046e036e69c861da2` | `bd84de8435e1768ee25df0e199a2342edb8e73fe6d8d16ccee7cd10217ca6bd4` |
| end-to-end   | `d66bba57a5ef55921d5163bba3b98d2c173fee5f78698012208d0a9f7845648e` | `648e14f16ba0c24b78a3b38dadb76b1e1693710f97a64b708482efad92e063cb` |

| Fixture        | Base                                       | Head                                       |
| -------------- | ------------------------------------------ | ------------------------------------------ |
| local-contract | `aed334356bb71a8b3fbe75655710dc1d2dd258c7` | `8ceaf92cd729e498d5ecda005141af63af357445` |
| rerun-contract | `45318e46faaf6f55a16b2e1d3d9c8c16cc20dac4` | `cbbbeea5bd3a3b6c2635630e53639d7e1b312adc` |
| clean          | `aed334356bb71a8b3fbe75655710dc1d2dd258c7` | `7510ecbeaec8cbc1084d01747f7b04f0f787841c` |

## Run-level measurements

| Suite        | ID  | Case           | Arm           | Repetition | Seconds | Estimated cost ($) | Output            |
| ------------ | --- | -------------- | ------------- | ---------: | ------: | -----------------: | ----------------- |
| verification | 01  | local-contract | off           |          1 |   6.452 |           0.004307 | confirmed/refuted |
| verification | 02  | rerun-contract | off           |          1 |  30.259 |           0.014477 | refuted           |
| verification | 03  | rerun-contract | deterministic |          1 |  43.385 |           0.012931 | uncertain         |
| verification | 04  | local-contract | on            |          1 |   6.367 |           0.003966 | confirmed/refuted |
| verification | 05  | local-contract | deterministic |          1 |   3.573 |           0.003641 | confirmed/refuted |
| verification | 06  | rerun-contract | on            |          1 |  17.096 |           0.006686 | confirmed         |
| verification | 07  | local-contract | on            |          2 |   4.419 |           0.004004 | confirmed/refuted |
| verification | 08  | rerun-contract | deterministic |          2 |  39.871 |           0.014232 | confirmed         |
| verification | 09  | local-contract | deterministic |          2 |   5.368 |           0.004553 | confirmed/refuted |
| verification | 10  | local-contract | off           |          2 |   9.951 |           0.004362 | confirmed/refuted |
| verification | 11  | rerun-contract | off           |          2 | 101.842 |           0.015149 | confirmed         |
| verification | 12  | rerun-contract | on            |          2 | 123.631 |           0.019294 | confirmed         |
| verification | 13  | rerun-contract | on            |          3 |  52.705 |           0.013594 | confirmed         |
| verification | 14  | rerun-contract | off           |          3 |  49.250 |           0.012421 | confirmed         |
| verification | 15  | local-contract | off           |          3 |   4.485 |           0.003484 | unverified        |
| verification | 16  | local-contract | deterministic |          3 |   4.134 |           0.003677 | confirmed/refuted |
| verification | 17  | rerun-contract | deterministic |          3 |  18.802 |           0.008387 | unverified        |
| verification | 18  | local-contract | on            |          3 |   7.459 |           0.005806 | confirmed/refuted |
| end-to-end   | 01  | clean          | off           |          1 |   4.858 |           0.004816 | 0 findings        |
| end-to-end   | 02  | clean          | on            |          1 |   6.261 |           0.005244 | 0 findings        |
| end-to-end   | 03  | defect         | on            |          1 |  30.816 |           0.013598 | 3 findings        |
| end-to-end   | 04  | defect         | deterministic |          1 |  29.392 |           0.011159 | 3 findings        |
| end-to-end   | 05  | clean          | deterministic |          1 |   6.106 |           0.004995 | 0 findings        |
| end-to-end   | 06  | defect         | off           |          1 |  25.758 |           0.011836 | 3 findings        |
| end-to-end   | 07  | defect         | off           |          2 |  21.644 |           0.011554 | 3 findings        |
| end-to-end   | 08  | clean          | on            |          2 |   6.429 |           0.004244 | 0 findings        |
| end-to-end   | 09  | clean          | off           |          2 |  11.049 |           0.005800 | 0 findings        |
| end-to-end   | 10  | clean          | deterministic |          2 |   3.282 |           0.003983 | 0 findings        |
| end-to-end   | 11  | defect         | deterministic |          2 |  24.166 |           0.010362 | 3 findings        |
| end-to-end   | 12  | defect         | on            |          2 |  25.095 |           0.011097 | 3 findings        |
| end-to-end   | 13  | defect         | off           |          3 |  27.389 |           0.011713 | 3 findings        |
| end-to-end   | 14  | clean          | deterministic |          3 |   3.108 |           0.003963 | 0 findings        |
| end-to-end   | 15  | defect         | on            |          3 |  20.376 |           0.010256 | 3 findings        |
| end-to-end   | 16  | defect         | deterministic |          3 |  35.060 |           0.011361 | 3 findings        |
| end-to-end   | 17  | clean          | on            |          3 |   4.310 |           0.004277 | 0 findings        |
| end-to-end   | 18  | clean          | off           |          3 |  14.557 |           0.004872 | 0 findings        |

## Branch dogfood and deadline correction

The built CLI reviewed the whole branch against `origin/main` after the comparisons,
including uncommitted audit documentation. It completed in 144.990 seconds with
no incomplete sessions. Main review, guideline checking, and independent
verification completed; one P2 finding was retained and manually accepted:
optional evidence preparation could spend the last seconds of a late verifier
batch's remaining budget, leaving that batch unverified.

Applied a narrow correction after the frozen measurements: optional preparation
now receives only time above the existing 45-second minimum verification budget,
capped at five seconds. With insufficient surplus it is skipped and logged;
the verifier keeps its available time. The policy is a pure helper in
`time-budget.ts`, tested at unlimited, ample, boundary, and exhausted budgets.
The existing fail-open integration case now also asserts that a tight-budget
request skips preparation but still invokes the verifier. No finding is dropped
and no deadline is extended. The recorded comparisons used ample budgets and
one batch, so this edge was not exercised; their runtime revision remains
`fdb40d9`, not a claim to have benchmarked the later correction.

The larger dogfood also exposed an imprecise README bound: the coverage notice
was 826 bytes for 131 omitted files. Its path-list cap plus fixed text bounds it
below 900 bytes, not the previously stated 800. Corrected the documentation and
added a multi-byte omission-budget assertion to the existing request-budget test.

The post-correction dogfood used built revision `e807aa3` and finished in
185.677 seconds. Main review completed, but the guideline pass was interrupted
at the auxiliary grace deadline and verification returned unusable output.
It is therefore an **incomplete integration review**, not a clean quality pass.
Its only retained item was an unverified P3 about the older `baselineOverlap`
metric. Manual inspection rejected its claim that the deterministic branch
returned before recording that field: both branches reached the same assignment.
The README also explicitly defined the old field as a prefix comparison.
However, overlap with the actual deterministic control is more useful here,
so that suggestion was applied as a telemetry improvement.

This round introduced telemetry version 5: `deterministicOverlap` replaces the old
`baselineOverlap` and compares against the shared first-fitting selector's real
output, including one-per-file and byte limits. A regression assertion covers
Jev selecting just candidate index 3: it overlaps the deterministic four-item
set even though it is outside a one-item prefix. Existing version assertions
were updated for this intentional schema change, not weakened. The historical
version-4 trial artifacts remain unchanged; later cache experiments use version 6. None of the reported conclusions
uses either overlap field. This final telemetry change preserves prompts and
selection behavior and was validated with deterministic tests rather than
another paid review.

## Final self-review and validation

Manual self-review: no remaining P1/P2 issue found. Seams checked: parser and
import resolution, guarded reads, bounded prompts, source-cache invalidation,
operator-owned documentation, independent verdict authority, auxiliary failure
handling and deadlines, mode/environment wiring, telemetry versions, and frozen
experiment inputs. Full-diff scope, review models, posting, confidence filtering,
and default policy remain unchanged. No GitHub posting or CI run was performed.

Validation after the corrections: all 1,078 tests, typecheck, lint, formatting,
build, and diff checks passed. The built CLI executed both branch dogfoods;
the second review's incomplete auxiliary coverage is retained above. Fixture
workspaces and input hashes remained unchanged. Credential scans of changed
files and experiment artifacts found no configured secret value; `.env` is
still ignored and untracked.

The advisory core corpus was not run. These fixtures, historical concern,
manual labels, and incomplete final dogfood do not establish broad review-quality
non-regression or meet the independent blind-adjudication gate. There is no
benchmark-ledger pass and no default-policy flip.

Cleanup applied: reused the existing Jev request/selection path, tracked-source
reader, verifier batching, time-budget floor, and experiment driver. The deadline
and metric corrections were folded into existing tests. No extra reviewer,
provider backend, verdict filter, or speculative retrieval service was added.
Comment blocks were individually retained: source/import priority, documentation
admission priority, unsupported-syntax fallback, tracked-source protection,
JSON-byte/token budgeting, and the shadow-mode option contract. All ten branch-added
tests retain distinct failure cases; four belong to this continuation, with
previous adjudications recorded in the earlier audits.

Cut: ambiguous default/namespace import attribution was removed before timing;
no additional dead surface remained in the final cleanup.
Comments: 6 branch blocks — 6 kept, 0 rewritten, 0 cut.
Tests: 10 branch cases — 10 kept, 0 folded, 0 cut; follow-up assertions extend
existing cases rather than adding duplicate cases.
Residual risks: small convenience sample, unstable external-contract verdicts,
syntactic rather than compiler-resolved links, and incomplete final dogfood
auxiliary coverage. Both new stages stay default off.

Continuation net line delta: +1265 across 16 tracked files; no untracked source files.
