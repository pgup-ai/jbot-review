# Publication policy and verifier claim checking

Unresolved candidates now remain in diagnostics instead of becoming individual
PR comments. `diff-batches` remains the default; `adaptive` remains opt-in for
completed auxiliary reuse. Publication policy applies to every preset.

## Behavior

`filter.ts` owns the unresolved classification: inconclusive verification,
`kind: investigate`, or low confidence. These candidates cannot enter inline,
file-level or outside-the-diff publication routes. Severity and comment-count
limits apply to publishable findings; unresolved candidates remain available
for diagnostics and cannot consume the comment budget.

The review body contains only their count and a verification-limit notice.
Candidate details and speculative summaries stay out of it. Retained candidates
still prevent automatic approval and an all-clear result. Auxiliary failures
preserve candidates in logs and local output, satisfying fail-open retention
without publishing unsupported claims. Telemetry distinguishes
`withheld-unverified`, retained findings and findings routed for publication;
these routing counts are not proof that GitHub accepted a post.

Finders no longer treat missing caller/import/guard context as sufficient reason
to emit an investigation. The existing verifier prompt asks it to compare the
claim with actual source, refute materially incorrect descriptions, and give a
concrete trigger plus the decisive source expression when confirming. No new
model call, repository scan, dependency, public flag or reasoning setting was
added. Coverage and concurrency limits are unchanged.

## Evidence

[Measured rows and hashes](data/2026-09-20-publication-policy.json) separate three
experiments. Private drivers and raw logs remain in the gitignored
`.jbot-review/publication-policy/` directory. The committed rows are sufficient
to recalculate counts and durations; the private drivers are not a committed
reproduction interface.

### Publication-contract replay

At `40b8af7`, replaying the 18 retained candidates from hosted run
[35545046767](https://github.com/pgup-ai/jbot-review/actions/runs/35545046767)
retained all 18 and routed **zero** for publication. The report contained no
candidate titles or speculative summary and did not claim all-clear. This does
not classify all 18 as false positives: an investigation had identified a real
reporting issue subsequently fixed.

Across the 100 synthetic corpus cases, repeated three times, the routing replay
preserved all **150 seeded finding instances** and withheld **900 injected
unresolved candidates**. This checks the publication contract, not live model
precision or recall. Routing plus report generation for the 18-candidate input
took a median 0.0022 ms and p95 0.0045 ms over 1,000 local iterations; that is a
CPU microbenchmark, not hosted latency.

### Live pipeline pairs

Control `8f27454` versus publication-policy revision `40b8af7`: three alternating
pairs each for a defect and its clean counterpart, using Cline CLI 3.0.62 and
`cline/cline-free/muse-spark-1.3-contributor`. Both arms used `diff-batches`, low
requested effort, concurrency three, two review passes, guideline checking,
verification, and disabled dynamic fan-out. The production runner used read-only
local GitHub fixtures and dry-run posting.

The executable defect truncates 201 submitted jobs to 100. The base loop and
initially designated clean `Array.from` refactor both return all 201 at limit 100.
The changed file has one hunk;
this cohort does not exercise large-PR paging or auxiliary reuse.

| Measurement                                    |       Control |     Treatment |
| ---------------------------------------------- | ------------: | ------------: |
| Defect detected and publishable                |           3/3 |           3/3 |
| Initial negative-control runs with any finding |           0/3 |           0/3 |
| Average defect-run duration                    |      30.351 s |      30.394 s |
| Average initial negative-control duration      |      25.432 s |      20.431 s |
| Executions per defect / clean run              |         3 / 2 |         3 / 2 |
| Main hunk delivery                             | 1/1 every run | 1/1 every run |

Defect latency was effectively flat. The negative-control timing is a small-sample
observation, not a general speedup claim. Model severity varied, including an
overstated P0 for the seeded batching defect; these results do not validate
severity calibration. These pairs predate the verifier wording below.

**Negative-control correction:** the final `ff7a81d` smoke caught a real boundary
difference in the supposed clean refactor: `reviewBatch([1, 2, 3], Infinity)`
returns `[[1, 2, 3]]` before and `[]` after. The supplied worker only uses 100,
but the fixture contract did not restrict the exported function to finite limits.
The original six zero-finding negative-control runs therefore do **not** establish
clean-case precision. The final smoke's control reported no finding (20.943 s,
two executions); treatment reported this P1 (48.389 s, three executions including
verification). Both defect smoke runs caught the seeded loss (23.415 s / 25.588 s,
three executions each), and all four delivered 1/1 hunks. These observations are
retained, not discarded as outliers. The code change is demonstrable; its P1
severity is not established by the fixed-100 caller.

The corrected negative control only renames the loop's local `batches` binding
to `chunks`, preserving its behavior. At final runtime `ff7a81d`, three new
alternating pairs produced no findings in either arm, with two executions and
1/1 delivered hunks in every run. This is a deliberately narrow clean-case check,
not evidence of precision across realistic code changes.

### Verifier component pairs

Control `8f27454` versus final runtime `ff7a81d`: three alternating pairs, each
verifying two actual false claims from the latest dogfood and the seeded true
batching defect in one call. Both arms received the same decisive source.

The P1 incorrectly quoted the hunk header as using `newCount` for the start;
current source already uses `newLine`. The other claim questioned an import
that exists in the supplied runner import block.

| Verdict over three repetitions       |  Control | Treatment |
| ------------------------------------ | -------: | --------: |
| False P1 refuted                     |      3/3 |       3/3 |
| False missing-import claim refuted   |      1/3 |       3/3 |
| False missing-import claim uncertain |      2/3 |       0/3 |
| True batching defect confirmed       |      3/3 |       3/3 |
| Average duration                     | 28.876 s |  19.684 s |

The P1 was refuted by both prompts once decisive source was supplied: this is
not evidence that wording alone fixed it. The treatment reduced unresolved
claims in this small component replay without losing the positive control.
The new publication rule would withhold the control's two uncertain results too.

Model: `commandcode/meta/muse-spark-1.3-contributor`, CommandCode CLI 1.44.0,
tools disabled, provider-default effort. An initial explicit-low invocation was
rejected by the installed CLI before inference and excluded. Both measured arms
used the same supported setting. Context7 returned no matching model-specific
documentation; the CLI rejection is the evidence for this local limitation.
This is not an exact reproduction of hosted prompts or hosted CLI configuration.

## Validation and remaining limits

At `ff7a81d`, all **1,114 tests**, typecheck, lint, formatting and build passed.
The final source check uses the existing verifier call. New uncertainty-routing,
comment-budget, severity-filter and investigation-only-summary assertions were
folded into existing cases.

Self-review found no remaining P1/P2 implementation issue in this increment.
Reviewed seams: candidate retention, verdict application, every publication
route, report generation, automatic approval, telemetry aggregation and both
verifier prompt variants. De-slop removed the collapsed advisory renderer and
its preset-specific option. No added/modified comment blocks or new test cases;
two existing cases were renamed. Relative to `8f27454`, implementation/docs/tests
before these evidence files were **+168 / -111, net +57 lines**.

**The required full-corpus default-policy gate remains unmet.** The earlier
[full-corpus attempt](2026-09-20-budgeted-diff-pages.md) was invalid: materialized
clean fixtures contained undefined behavior and the recorded engine did not
match the runtime. No passing ledger row is claimed. The advisory live core
corpus was not rerun; these targeted trials do not qualify the default-policy
change for production.

A confidently wrong finder/verifier can still publish a false positive. The
deterministic gate prevents explicitly unresolved claims from becoming comments;
it cannot prove arbitrary model reasoning correct. Hosted validation of this
revision and a valid, independently adjudicated quality corpus remain necessary
before claiming general precision or latency improvements.

The later hosted run at `8f27454`
([35546344982](https://github.com/pgup-ai/jbot-review/actions/runs/35546344982))
posted 19 finding threads: 16 explicitly unverified, two low-confidence and one
high-confidence P1. The new policy would withhold the first 18; the confidently
wrong P1 requires correct verification, as the component replay above illustrates.
This explains why a publication guard is necessary but not a complete precision fix.
