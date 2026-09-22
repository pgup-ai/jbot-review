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

OpenCode's wrap-up agent now retains the same native read-only tools and permission
rules as review sessions. Its prompt still requests a final answer without further
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
