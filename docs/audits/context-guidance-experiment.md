# Guideline sections and OpenCode wrap-up

Only guideline-section selection was retained from the context experiments.
The contract-question prompt, companion-repository packet and multi-arm driver
were removed. Their raw results and source snapshot remain locally under
`.jbot-review/context-experiment/`.

## What the experiments established

The original full-PR pilot reduced guideline text from 24.6 KB to 13.5 KB
and the assembled prompt from 98.1 KB to 87.0 KB. Cline returned no findings
in any arm; MiMo's four 180-second cells timed out. The corrected Cline
control/treatment pair also returned no findings. These samples establish
neither a recall improvement nor a reliable latency gain.

In the compact calibration, Cline found and verified the seeded baseline-gate
bug with every arm. Review plus verification took 33.4s with existing guidance,
33.8s with scoped guidance, 46.9s with contract questions, and 69.4s with companion
context. The latter additions did not improve recall. The synthetic negative
fixture omitted a real consumer, so it cannot establish false-positive rates.

## Applied section loading

The existing `.pr-governance/review/rules-for-diff.yaml` accepts
`docs: ["AGENTS.md#Exact heading"]`. Matching sections include their children,
combine across matching routes, and disclose omitted headings. Source reads,
injected text and omission metadata remain bounded.

Unconfigured files keep ordinary discovery. Missing or ambiguous headings fall
back to whole-file loading. Whole-file routes take precedence, including aliases;
mixing named-heading and numbered-rule routes keeps the whole file.

This repository selects its invariants, review-quality gate, conventions and code
hygiene. It still loads the referenced quality-corpus policy. Finder guidance
measured 24,550 bytes on the preceding checkout and 16,091 bytes with this route
(about 34% smaller). The implementation also updates one invariant to describe
wrap-up tools, so these byte counts are not an identical-source A/B experiment.
They are not a wall-time or review-quality claim.

## Main wrap-up compatibility

The previous native MiMo run investigated for 510 seconds, then failed immediately
when main-review finalization switched to a tool-less agent:

> OpenCode's free tier can only be used from within OpenCode

That run did not use Pi. Free-model exclusion from Pi remains unchanged.

OpenCode's wrap-up agent retains native tool schemas for model compatibility.
Its permission-evaluation hook denies shell execution during finalization.
Its prompt still requests a final answer without further
investigation. The remaining deadline is enforced and wrap-up cannot recursively
reserve another wrap-up. Single-shot repair and formatting remain tool-less.
No alternate model, new setting or custom tool was added.

Local tests used the complete real fix diff `84ff078...1ec3221` in a clean checkout.
Both native main sessions were interrupted after 60 seconds and given a 90-second
finalization budget:

| Model                                      | Completed finder tools | Total main + wrap-up | Result                      |
| ------------------------------------------ | ---------------------: | -------------------: | --------------------------- |
| `opencode/mimo-v2.6-flash-free`            |                      1 |               125.9s | Valid JSON, `partial: true` |
| `opencode/muse-spark-1.3-contributor-free` |                      5 |                63.3s | Valid JSON, `partial: true` |

Both exercised actual native investigation and interrupted-session recovery.
Neither returned the free-tier rejection. These are compatibility tests, not
completed reviews: a partial mandatory main page still fails coverage before
posting and cannot establish an incremental baseline.

Local inputs, driver, logs and results are in `.jbot-review/wrapup-validation/`.
The SDK's documented interrupt and agent-switch behavior was checked against
[OpenCode V2](https://opencode.ai/v2/docs/build/plugins) and installed version 2.0.5.

A Cline free Muse review of the same real fix diff with the new section routing
also completed in 50.6s with zero candidates. Its guideline block
was 16,091 bytes. This checks the tool-less adapter with the selected
guidance; an empty result does not prove the diff has no bugs.

## Validation

- 1,125 unit tests passed; typecheck, lint, build and diff checks passed.
- Regression coverage checks heading boundaries, fallback behavior, alias
  precedence, mixed routes, retained read-only tools and non-recursive deadlines.
- Self-review and de-slop found no new P1/P2 issue in these changes. Two new
  guideline tests remain: subtree/fence parsing and discovery/fallback integration.
  Wrap-up checks extend existing cases. The one added code comment explains why
  mixed route types retain the whole file; the obsolete tool-less wrap-up
  comments were removed.
- No full quality-corpus run was performed. The local checks do not establish
  production latency, missed-bug rate or provider reliability across repeated runs.

Final pre-push cleanup consolidated a duplicate import and removed the redundant
invalid-baseline comment. Across the branch, six changed comment blocks were
adjudicated: three kept for non-obvious fallback behavior and three removed.
All five new tests were retained for distinct failures: baseline provenance,
aliased impact, real-Git fallback behavior, heading parsing and routed discovery.
No remaining P1/P2 issue was found.

## Dogfood run 35748828510

The [job](https://github.com/pgup-ai/jbot-review/actions/runs/35748828510/job/106817286213)
on `583dca5` succeeded, but its posted review correctly reports incomplete
auxiliary coverage:

- CommandCode Muse completed main review in 195.4s with all 22 files and 50/50
  mandatory hunks delivered. It returned no candidates. Native tools ran in
  batches of up to three, with no repeated tool calls recorded.
- Both Cline DeepSeek V4 Flash interaction pages failed at 428.9s and 550.6s with
  “Model reached the maximum output token limit before completing the turn.”
  Guideline compliance shared these pages, so it was incomplete too.
- Total review time was 562.1s, including 356.0s waiting after main review.
  This was not the configured timeout: 1,267 seconds of auxiliary budget
  remained when main finished. The adapter does not report Cline token usage,
  so the artifact cannot distinguish reasoning from visible-output consumption.
- `unverified-findings.json` contained no candidates. Verification was skipped
  because there was nothing to verify, not because findings were hidden.
- Guideline input was 16,091 bytes as expected. Scope was full because the latest
  prior review was incomplete. No new reusable baseline was emitted. Neither
  OpenCode nor MiMo ran, so this job did not exercise their wrap-up change.

The shell-access review comment was applied to wrap-up only: the existing
OpenCode permission hook denies shell execution while preserving native tool schemas.
The runner extraction suggestion was declined; scope planning already lives in
`incremental-review.ts`, and moving collected configuration and telemetry into
another wrapper would not correct an observed defect.

Follow-up validation of the shell restriction:

- Removing the shell schema, or denying it through configured session permissions,
  reproduced the free-tier rejection with both MiMo and Muse. Those approaches
  were discarded. The native permission-evaluation hook preserves the schema and
  rejects execution instead.
- Both free models completed a real review interrupted after 10 seconds, with a
  90-second wrap-up allowance: MiMo in 30.4s total and Muse in 12.7s. Both returned
  valid JSON marked partial. This checks recovery compatibility, not review recall.
- A separate native Muse wrap-up attempted `pwd`; the SDK tool event recorded
  `permission.rejected` before execution.
- All 1,125 tests passed. The existing permission-hook test now covers wrap-up
  shell denial while preserving normal review shell access and wrap-up reads. No
  new test case or code comment was added. The full quality corpus remains deferred.

Local evidence: `.jbot-review/wrapup-shell-hook-validation/`.
