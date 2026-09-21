# Jev evidence reuse: second experiment

Date: 2026-09-19. Continues `e90683a` on `codex/jev-evidence-prefetch`.
The experiment remains off by default.

## Change and hypothesis

The first pilot supplied source windows, but reviewers often read those same
lines again. Version 2 labels evidence completeness and tells the reviewer to
use supplied lines directly for caller checks, investigating missing or
conflicting evidence as needed. It includes complete tracked source files when
their numbered contents fit 2,048 bytes; larger sources use bounded windows.
The source reader propagates truncation metadata so a short prefix of a large
file cannot be mislabeled complete. The 6,000-byte total context cap still
applies. Logs record `version: 2` and `completeFileCandidates` alongside the
existing timings, costs, tokens, tools, turns, and findings.

The hypothesis is fewer expensive reviewer reads and turns, not merely a fast
Jev API call. Neither Jev scores nor completeness labels remove callers or
changed hunks from review. Independent finding verification remains enabled;
all existing filtering, permissions, and failure fallback behavior is retained.

This tests the combined evidence packaging and reuse instructions. It does not
isolate Jev ranking from deterministic prefetch, nor compare version 1 and 2
on identical inputs.

## Method

Two frozen synthetic repositories each contain three changed exported total
functions (invoice, refund, credit) and twelve unchanged reference files:
three 17-line behavioral consumers and nine metadata-only mentions. Each
consumer treats totals as dollars and multiplies by 100 before sending cents
to its processor. The defect variant changes the producers to return cents,
creating three independent 100x amount errors. The clean variant only widens
input parameters to readonly arrays, preserving dollar results.

Each scenario uses three repetitions per arm, serially ordered
`off/on/on/off/off/on`. Both arms use `opencode/deepseek-v4-flash`, OpenCode
2.0.5, one shard, one review pass, verification enabled, and a five-minute run
budget. Separate OpenCode servers are started per run. Provider cache state
and model sampling are not controlled. The first defect baseline overlapped
local automated checks. It is retained as a warm-up observation but excluded
from the primary comparison; an additional off run after the six scheduled
defect runs replaces it. That repeat decision was made before its result.
Exclusion does not change the conclusion: including it also shows no speedup.

Artifacts are in the ignored `.jbot-review/jev-experiment-v2/` directory:
`compare.mjs`, frozen `defect/` and `clean/` Git repositories, manifests with
fixture SHAs and driver diff hashes, runtime source hashes, and each run's
logs, JSONL telemetry, and Markdown report. Repeat locally with
`node .jbot-review/jev-experiment-v2/compare.mjs defect` and then
`node .jbot-review/jev-experiment-v2/compare.mjs clean`; preserve artifacts before
rerunning because those commands overwrite the scenario's previous results.

Elapsed time includes context preparation and teardown. Tool calls and turns
are observed counts, separated by session role when interpreting savings.
Findings must be checked against all three seeded errors and the clean control;
fewer tool calls alone do not establish a useful improvement.

## Results

| Run                    | Seconds | Main tools | Main turns | All tools | All turns | Findings |
| ---------------------- | ------: | ---------: | ---------: | --------: | --------: | -------: |
| defect-1-off (warm-up) |  30.147 |          8 |          4 |        11 |         6 |        3 |
| defect-2-on            |  25.631 |          3 |          2 |         3 |         3 |        3 |
| defect-3-on            |  46.782 |          5 |          2 |         9 |         4 |        3 |
| defect-4-off           |  33.845 |          9 |          4 |         9 |         6 |        3 |
| defect-5-off           |  24.283 |          6 |          3 |         6 |         4 |        3 |
| defect-6-on            |  32.633 |          9 |          2 |         9 |         3 |        3 |
| defect-repeat-1-off    |  24.942 |          6 |          2 |        10 |         5 |        3 |
| clean-1-off            |   2.939 |          0 |          1 |         0 |         1 |        0 |
| clean-2-on             |   5.437 |          0 |          1 |         0 |         1 |        0 |
| clean-3-on             |   5.948 |          1 |          2 |         1 |         2 |        0 |
| clean-4-off            |  11.373 |          7 |          3 |         7 |         3 |        0 |
| clean-5-off            |   5.073 |          3 |          2 |         3 |         2 |        0 |
| clean-6-on             |   5.462 |          0 |          1 |         0 |         1 |        0 |

All seven defect reviews retained the three distinct seeded errors. Manual
inspection confirmed the changed producer, unchanged consumer, and double
conversion in each finding. All six clean reviews retained zero findings.
This is manual, unblinded fixture adjudication, not a corpus quality-gate pass.

In the primary defect comparison (three runs per arm):

- Mean main-review calls: **7.00 off → 5.67 on**; mean main-review turns:
  **3.00 → 2.00**. Direct consumer-file reads fell from nine across baseline
  runs to two across treatment runs; two treatments used all three supplied
  consumer files without rereading any of them.
- Mean total time: **27.690 s off → 35.015 s on**; medians **24.942 → 32.633 s**.
  This sample is slower overall despite fewer main-review turns. It does not
  demonstrate an end-to-end latency benefit.
- Mean review/verification input tokens: **54,229 → 55,049**; output:
  **3,178 → 3,330**; cache-read: **83,541 → 37,973**. These are provider-reported
  quantities, not an inferred cache hit rate. Jev usage is separate.
- One baseline needed a response-repair session. Verification time varied
  independently from **3.3 to 21.7 seconds** across compared runs. Main-review
  execution itself also varied, so verification alone does not explain the
  absent speedup.

Clean controls: mean main calls **3.33 → 0.33**, turns **2.00 → 1.33**.
Mean total time **6.462 → 5.616 s**, but median **5.073 → 5.462 s**. These small,
variable samples do not establish a reliable clean-review speedup either.

The direct-read traces support evidence reuse, with unchanged fixture recall.
They do not establish that fewer tools always means lower latency, nor prove
that this ranking method is better than a simpler prefetch baseline. No rollout
or default-policy change is warranted by these measurements.

All six Jev calls succeeded and selected three complete consumers each. Total
overhead ranged **209–293 ms**, and per-call estimated cost
**$0.00017657–$0.00017997**. Each treatment injected
a **3,300-byte** block.

Fixture identities: defect `aed334356bb71a8b3fbe75655710dc1d2dd258c7` →
`8ceaf92cd729e498d5ecda005141af63af357445`; clean `aed334356bb71a8b3fbe75655710dc1d2dd258c7` →
`7510ecbeaec8cbc1084d01747f7b04f0f787841c`.

## Validation and review

Validation: 1,073 tests passed, including a new regression that distinguishes a
complete small file from both a normal partial window and a byte-clipped file.
Typecheck, lint, full formatting, build, and `git diff --check` passed. Runtime
source hashes were unchanged across measured fixture runs. Existing off/shadow
parity, byte budgets, error fallback, and credential-isolation tests still pass.

Manual self-review found no remaining P1/P2 issue. Checked seams: guarded source
reading, completeness metadata, excerpt/ranking budgets, prompt assembly,
telemetry/export, and default-off behavior. No review stage or disposition rule
was replaced. The source reader's verifier caller preserves its existing text
and excerpt behavior.

Cleanup: no speculative options or dependencies were added. This continuation
adds no code comment blocks. The one new test was kept because it uniquely
catches truncated source being asserted to be a complete file; assertions added
to the existing integration test verify the new labels and telemetry. Existing
assertions were retained. The three comment blocks and four new tests from the
first commit retain the individual adjudications recorded in its audit.

The advisory core corpus (60 cases, three repetitions) was not run. This is a
bounded default-off experiment, not evidence of general review-quality
non-regression or an adoption gate. A real-PR repeated latency comparison,
broader bug classes, and a deterministic-prefetch control remain unmeasured.

Full-branch local dogfood completed in **208.796 s**, with main review,
guideline check, and independent verification all completing. Zero findings
were retained. One P3 telemetry-parsing concern was refuted: the parsed rows
are internally JSON-stringified metadata, so the alleged malformed-row crash
had no concrete trigger. Manual inspection agreed; no speculative catch was
added. Jev skipped this branch diff with `no-candidates`, so this run validates
the integration and fallback, not prefetch latency. Logs and telemetry are
saved as `self-review-1-on.*` with a separate manifest. The run used a ten-minute
budget; it is excluded from the fixture comparison.

Continuation net line delta: +229 lines across six files; no untracked source files.
