# Complete diff pages and PR #228 dogfood diagnosis

Runtime: `15e5d7c95506c1ec6d2be33ed91516bd8e674696`. Baseline:
`868a476c9e915f0494d35903aaf275323d5d8d3f`.

## Delivery contract

Every main-review task receives its complete assigned diff page. The planner
measures the assembled instructions, guidelines, PR context, diff and supporting
evidence. Transport bytes and model input/output capacity are separate checks.
UTF-8 bytes conservatively bound text tokens; this is not an exact tokenizer.
Known SDK model limits come from the installed offline catalog. Opaque CLI models
use a logged 128,000-token policy ceiling with output/harness reserves, including
the known backend tool directives; hidden CLI prompts and undisclosed model limits remain an operational uncertainty.
Input text is capped at 96 KiB per task, with a separate Cline argv check.
Optional PR metadata and prior-review context shrink with an omission notice
to reserve room for a useful diff page. Omission notices count toward their
blocks' byte limits.

Related file groups are packed into pages. Oversized files split at hunk
boundaries; oversized hunks split at line boundaries with reconstructed old/new
coordinates and bounded adjacent context. The original hunk body must reconstruct
exactly from its parts. An unsplittable line or fixed prompt that cannot fit fails
explicitly. A requested single shard can therefore produce many tasks. The shared
session limiter queues them; zero now selects the bounded default of three.

Logs and telemetry record expected/delivered original hunks and
expected/completed/incomplete tasks. Every part must finish before its original
hunk counts as delivered. A failed or partial main task fails the run. Lens and guideline
tasks use the same planner; failed auxiliary pages retain successful findings and
report incomplete coverage. Verification measures each candidate batch after
adding cited source and optional evidence, reducing it until it fits. An
oversized singleton stays explicitly unverified without a doomed API call.
Targeted auxiliary diff text also has a finite block budget and explicit
truncation/omission notices, so a file-level finding need not exhaust the request.
Main-page diffs remain complete. Missing evidence cannot justify refuting a finding.

Each task receives a bounded shared change map and actual caller/contract
excerpts. These are supporting evidence, not an exhaustive dependency graph.
An unchanged caller can still be missed: a retrieval-only probe of the old
67-file PR produced ten pages but did not select `src/worker/run-job.ts` in any
page. The correctness fix below does not establish that this same P1 would now
be detected automatically. Maps, completion counters and delivered code do not
prove model comprehension.

## Default and rollback

`JBOT_REVIEW_EXPERIMENT=diff-batches` is the requested new default. `off` disables
the shell batching hints while preserving mandatory paging, deterministic caller
context and delivery checks. Pi, CommandCode and tool-less backends receive no
shell batch hints.
`linked` and `jev` remain separate opt-in presets; Jev is not called by paging or
deterministic caller preparation. `.env.example` and the ignored local `.env`
select `diff-batches`.

Historical batching reduced delivered tool bytes by 44.1% with essentially flat
total latency. That experiment recovered omitted main-review patches. The new
workflow embeds all assigned patches and batches only supporting cross-task
reads, so the old result does not establish a speedup here. The required default
policy quality gate is **not established**; this branch is not production-qualified.

## Live Cline regression

The isolated fixture adds a 207,078-byte patch containing one large hunk. Its
late ownership predicate incorrectly returns `actorId !== ownerId`. Both arms
request one shard, use tool-less
`cline/cline-free/muse-spark-1.3-contributor`, enable independent verification,
and run three alternating repetitions against the same fixture.

The frozen baseline fails before model launch: the assembled prompt is
228,627 bytes, exceeding Cline's 122,880-byte argv limit. All three committed-code
trials completed three of three treatment runs, with four completed pages, one
fully delivered original hunk, no incomplete tasks, and the late defect retained
after verification.

| Treatment revision | Completed | Root retained | Durations                 |
| ------------------ | --------- | ------------- | ------------------------- |
| `3dd54a1`          | 3/3       | 3/3           | 31.916s, 46.491s, 32.394s |
| `df71e99`          | 3/3       | 3/3           | 37.172s, 37.319s, 31.703s |
| `cdb449a`          | 3/3       | 3/3           | 39.153s, 35.643s, 47.543s |

All 18 results, including nine failed controls, are preserved in the
[per-run data](data/2026-09-20-complete-diff-pages.json).

This is delivery and root-detection evidence for one synthetic fixture, not a
latency comparison with a successful baseline or a general recall measurement.
The model results all escalated the finding to P0; they do not
establish calibrated severity.

## Why the preceding dogfood missed the P1

[Run 35530999481, job 106131440350](https://github.com/pgup-ai/jbot-review/actions/runs/35530999481/job/106131440350)
reviewed head `868a476`. Its complete job log, telemetry artifact, review
submissions and inline threads were inspected.

- All **67 reviewable changed patches** were embedded: **495,909 diff bytes,
  zero truncated patches, zero omitted patches**. One noise file was excluded.
  The main session's actual prompt usage recorded **557,453 bytes**.
- Main used CommandCode DeepSeek V4 Flash Fast; auxiliary checks used CommandCode
  Muse Spark 1.3 Contributor. Both had repository tools disabled.
- Main generated two candidates, the interaction lens one, and the guideline
  pass zero. Verification refuted one candidate and left two uncertain. The
  final review contained two P3 investigation notes. The hosted-Cline P1 was
  never generated, so verification did not drop it.
- The missing evidence was unchanged code: `src/worker/run-job.ts` pins
  `reviewShards: 1`, and hosted users cannot increase it through the job
  contract. That file was absent from the diff. The model could not retrieve it.
  Prompt dilution at this size is plausible, but this one run cannot isolate it
  from model variation or missing caller evidence.

| Other finding                     | Assessment and action                                                                        | Interpretation of J-Bot's miss                                              |
| --------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Qodo/Cubic hosted Cline P1        | Same valid issue; automatic pages fix it without a new hosted setting.                       | Missing unchanged worker evidence; no generated P1 hypothesis.              |
| Qodo planner architecture         | Valid; extracted planning into `review-plan.ts`.                                             | Architecture guidance, not a demonstrated runtime defect.                   |
| Qodo/Cubic preview test gap       | Removed the preview-only routing branches; shared planner regressions cover the replacement. | Missing tests alone are a different finding class from runtime regressions. |
| Qodo README duplication           | Not applied: README is current operator guidance; the audit records a frozen revision.       | Editorial judgment; not evidence of lost bug recall.                        |
| Cubic audit validation SHA        | Applied the revision label.                                                                  | Documentation traceability, not a runtime defect.                           |
| CodeRabbit Pi batch compatibility | Valid; suppress shell batches for Pi.                                                        | Its prior one-path tool contract was outside the changed diff.              |

J-Bot's two uncertain notes were not actionable defects: OpenCode uses the same
capability gate to disable tools, and the remaining two-argument helper caller
additionally checks the OpenCode model's capability. Both were answered in-thread.
Cubic's latest review covered 15 incremental files while J-Bot covered the full
67-file diff. Greptile's earlier comments referred to an older revision. These
are not controlled, equal-scope recall comparisons.

The next [dogfood run, 35533647942](https://github.com/pgup-ai/jbot-review/actions/runs/35533647942/job/106138676276),
at `3dd54a1`, failed during planning before any review session. Optional metadata
left too little space for a README diff line. The follow-up reserves useful diff
space by shrinking metadata, not mandatory hunks. It also fixes the separately
reported no-newline split boundary, partial-main acceptance and verifier-source
budget cases. This failed run provides no recall comparison with other reviewers.

## Latest completed dogfood: delivery fixed, auxiliary coverage incomplete

[Run 35535032749, job 106142411475](https://github.com/pgup-ai/jbot-review/actions/runs/35535032749/job/106142411475)
at `45498eb` completed its main review: **225/225 original hunks, 34/34 main
tasks, zero incomplete main tasks**. All main page rows reported zero omitted
or truncated patches. The largest measured main prompt was 83,018 bytes.
Main, auxiliary and verification roles all used tool-less CommandCode Muse Spark
1.3 Contributor; batching hints were therefore inactive.

The job succeeded, but its posted review explicitly reported **incomplete
auxiliary coverage**. All 34 guideline pages completed; 13 of 14 interaction
pages completed and the remaining page was aborted at the settlement deadline.
The optional changes-since-last-review summary failed preflight at 156,028 bytes.
Successful findings were retained, as required; this is not an all-clear result.

This run took **617.8s**, including **277.1s main review** and **322.9s waiting
for auxiliary work**, and made 85 model calls: 34 main, 34 guideline, 14 lens,
two verification and one addressed check. The preceding completed run took
125.4s, but changed code and selected models differ, so these are not paired
latency measurements. The extra pages and auxiliary queue are observable costs;
there is no evidence of a speed improvement here. Token totals were 2,646,665
input, 200,262 output and 390,834 cached-input tokens. Counters and artifact hashes
are in the per-run data. Optional context repeated across pages and auxiliary
scheduling are concrete follow-up optimization targets.

The five main candidates all survived filtering: one confirmed P2 and four
uncertain findings posted as investigation notes. No P1 was generated.
Manual adjudication found **one valid defect among those five**, in an uncertain
note; the confirmed P2 was a false positive:

| J-Bot result                              | Manual check                                                                                 | Action                                              |
| ----------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Relative experiment workspace             | Valid: the child changes cwd before using the relative workspace.                            | Resolve workspace arguments in both trial branches. |
| Raw diff headers treated as changed lines | Not reachable: GitHub patches are hunk-only and `parseGitDiff` removes raw file headers.     | Not applied.                                        |
| Backend workspace capability              | The sole telemetry caller separately checks the model capability.                            | Not applied.                                        |
| Missing experiment defaults               | `runReviewPipeline` calls `normalizeOptions` before the dereferences.                        | Not applied.                                        |
| Removed blanket auxiliary diff gate       | Finder pages are complete; targeted checks explicitly fail open when evidence is incomplete. | Not applied.                                        |

The verifier lacked the unchanged experiment child/parser/caller context. It
therefore demoted the valid path bug to uncertain, and incorrectly confirmed the
header hypothesis without proving that raw headers reach the function. Complete
main delivery solved the delivery contract, but did not solve dependency evidence
or verifier precision. This run does not establish a general recall improvement.
CodeRabbit's separate model-limit finding was valid: reserving a model's entire
maximum output can leave no input space when it equals the context window. The
follow-up caps reserved output headroom while Pi's installed SDK independently
clamps actual generation to remaining context. A real catalog entry with equal
input/output ceilings now exercises that regression.

The public Action's matching input descriptions are prepared in
[draft wrapper PR #57](https://github.com/pgup-ai/jbot-review-action/pull/57).
They should publish with the runtime after its release gate is satisfied.

## Full-corpus attempt: invalid, not scored

The scheduled full gate was 100 cases × three repetitions × two arms. It was
stopped after **92 completed rows across 18 cases** (45 control, 47 treatment),
with all completed commands exiting successfully. Eight isolated case workers
preserved alternating arm order within each repetition. Partial results are not
a full-corpus result and no passing benchmark-ledger row was created.

Two independent problems invalidate the attempt:

1. Materialized clean fixtures contain undefined dependencies. For example,
   `clean-tenant-scope-leak` has a base calling undefined `previousBehavior` and
   a head calling undefined `db`; both throw `ReferenceError`. The clean Dim
   fixture similarly references undefined `normalized`, `command` and
   `classifyTool`. The model repeatedly reports these scaffolding failures;
   scoring them as production false positives or seeded-root misses would be
   misleading. The corpus needs valid executable contracts before a release gate.
2. The experiment manifest incorrectly declared Pi and set
   `JBOT_SDK_ENGINE=pi`. The accepted automatic selector is `auto`; the invalid
   value fell back to OpenCode. The declared and observed engines therefore did
   not match. The original manifest and rows were preserved, not relabeled.

No quality or latency comparison is claimed from these rows. Their SHA-256 is
`5afa18a39c259627e81b39bc13d004c635bbfcb9cfbcfb99dddd536002ed08cf`.
The manifest hash is
`56c25fcd5dec5e702a5f77d2b798bf7f1958c1c67b67bf412927b4bd6fd2ae6a`.

## Follow-up review decisions

Qodo and Cubic independently reported the partial-main, no-newline and verifier
batch failures; the corrections above address each. The local preview now labels
its page counts as approximate because it does not include runtime metadata or
use every runtime prompt option. The Pi catalog lookup respects the resolved
engine kill switch and Node gate. Tests cover all five budget-wrapper operations
and retain both exploration-policy branches.

Targeted diff text composition now lives in `prompt.ts`, with selection in the
planner. A smoke check of the installed offline catalog returned 1,047,576 context
tokens and 32,768 output tokens for `openai/gpt-4.1`, and no limits for an unknown
model or disabled Pi. No injectable registry layer was added solely for tests.

The backend preflight deliberately uses a conservative assembled prompt. Existing
Cline guideline truncation and auxiliary single-shot variants can shorten it;
backend directives fit inside reserved harness capacity, and the Cline argv limit
is checked again after its directive is added. Exact hidden CLI tokenization is
not claimed. Omitted extra finding citations are already listed by
`buildFindingSourceContext`, which accompanies the targeted diff in verification;
no duplicate omission block was added.

Requests to restore an `off` default or disable baseline caller context were not
applied: both changes are explicitly requested behavior. The large-hunk test keeps
its greater-than-four-pages assertion to guard against restoring the former shard
cap; it also checks complete conservation and every final prompt's byte limit.

## Self-review and cleanup

The repository self-review and de-slop skills were applied. Reviewed seams:
planner/assembler/backend dispatch, main/auxiliary failure handling, verification
batch offsets, shard retries/cache identity, concurrency, local preview, hosted
worker, telemetry, read-only sessions and credential handling. No remaining
P1/P2 implementation issue was identified in this follow-up; the release-gate
and dependency-retrieval limits above remain explicit.

Removed unbounded auxiliary diff assembly, duplicate completeness checks,
preview-specific routing and obsolete one-prompt tests. The follow-up comment
audit covered **21 blocks: one kept, four rewritten, 16 cut**. All eight new cases
were retained for distinct failures: late-hunk/argv conservation, assembled
budgets, supporting batch scope, shared-prefix trust ordering, failed queued
pages, actual unchanged caller delivery, no-newline split boundaries and final
verifier batch sizing. Seven older cases were replaced or
folded into those regressions; existing prompt policy assertions remain.

At `cdb449a`, all **1,106 tests** (260 suites), typecheck, lint, formatting
and build passed. The final catalog/workspace fixes passed the same full suite
and focused planner/static/build checks; the default opaque-CLI budget is unchanged. PR CI at `45498eb` independently passed all 1,106 tests,
lint, formatting and typecheck. No dependencies or CLI packaging changed.
Secrets remain outside tracked files.

Follow-up delta relative to `868a476`, excluding these new evidence files:
**+1314 / −623, net +691 lines** across 22 implementation and documentation files.
New evidence files: this audit (267 lines) and the per-run JSON (340 lines).
