# Full self-review and local provider comparison

PR [#228](https://github.com/pgup-ai/jbot-review/pull/228). Reviewed the full branch
against `2d8f9239424ba6644dcc36e0d45433eb74640974`, using both repository review
skills. This follows the [Cline latency experiment](2026-09-20-bounded-review-latency.md).

## Corrections

- Normalize omitted, zero and negative session caps to three. Positive limits
  and tighter gateway capacity still apply. The previous `95a9d98` fix accepted
  a bot's incorrect unlimited-zero interpretation; this restores the documented
  bounded contract in README, Action inputs and the runner option.
- Validate candidate promotion against both the source actually delivered to
  the batch and that candidate's own source/citations. Another candidate's quote
  cannot authorize publication at this candidate's retained anchor.
- Include optional prepared evidence in validation only when it was admitted to
  the prompt, and associate it with its target. Oversized or unavailable packets
  remain fail-open. Verification remains one model call per batch; additional
  bounded source reads run only for proposed promotions. The public presets
  still leave extra verification retrieval disabled.
- Restore shared-prefix assertions lost when planner tests moved files. Correct
  stale five-minute grace, uncertain-advisory and partial-main-review prose.

A quote match is a provenance check, not proof that the model's reasoning is
correct. Ordinary false-positive confirmation remains possible.

## Protocol

Both provider pairs execute the real local review pipeline in dry-run mode,
without GitHub posting. The identical frozen reviewed tree is `e4285ec`, with
merge-base `2d8f923`; control runtime is `e4285ec`, treatment runtime is `75e4e24`.
Later changes add a telemetry-only `--no-pager` classifier correction, tests,
documentation and measured data. They do not alter prompts, scheduling or finding
disposition; the paired timings below remain attributed to `75e4e24`.

Isolated local tools match Docker pins: OpenCode CLI 2.0.5 and CommandCode 1.56.2.
The global older CommandCode installation was not used. Models:
`opencode/muse-spark-1.3` and `commandcode/meta/muse-spark-1.3-contributor`.
Both use `diff-batches`, two requested passes, dynamic fanout, one initial shard,
concurrency five, a 30-minute run budget, medium finder effort and low verifier
effort. OpenCode has the existing read-only repository tools; CommandCode tools
are disabled. Compare within a provider, not between providers.

Each pair runs control before treatment. Provider cache state is uncontrolled;
other-provider trials overlap on the same host. This is one pair per provider,
not a randomized or statistically reliable latency estimate. Manifests, logs,
results, the driver and per-block cleanup inventory remain in the ignored
`.jbot-review/provider-audit/` directory. Published measurements include artifact
hashes and the frozen input hash.

## Measurements

| Measurement                              | CommandCode control | CommandCode treatment | OpenCode control | OpenCode treatment |
| ---------------------------------------- | ------------------: | --------------------: | ---------------: | -----------------: |
| Total seconds                            |             538.466 |      370.928 (-31.1%) |        1,190.547 |   801.389 (-32.7%) |
| Main review seconds                      |             333.895 |               305.092 |          885.212 |            727.404 |
| Post-main auxiliary wait seconds         |             186.264 |                60.001 |          300.005 |             60.002 |
| Main tasks completed                     |               53/53 |                 53/53 |            53/53 |              53/53 |
| Main hunks delivered                     |             385/385 |               385/385 |          385/385 |            385/385 |
| Auxiliary pages completed/planned        |               38/38 |                  5/38 |            31/40 |               3/40 |
| Session usage records, including wrap-up |                  93 |                    60 |               95 |                 61 |
| Main prompt bytes                        |           4,005,252 |             4,005,252 |        4,005,966 |          4,005,966 |
| Observed tool calls                      |         unavailable |           unavailable |            1,032 |                714 |
| Main tool calls                          |         unavailable |           unavailable |              628 |                592 |
| Main model turns                         |         unavailable |           unavailable |              446 |                409 |

[Measured rows, dispositions and hashes](data/2026-09-20-provider-latency-review.json).
Session usage records count prompt executions with usage, not simultaneous
sessions or all underlying model turns. Verification can overlap main/auxiliary
work; its final phase is not its total execution time. Auxiliary pages share a
telemetry label, so their last turn-count snapshot is not an aggregate; those
turn counts are omitted. CommandCode tool/turn observability is unavailable.

The shorter wait accounts for 126.3s of CommandCode's 167.5s total reduction and
240.0s of OpenCode's 389.2s reduction. Main prompts/page counts are identical;
main-phase differences remain confounded by caching and model variability.
The changes bound tail work; these pairs do not establish a general main-review
speedup. OpenCode's reduced tool count mainly comes from less auxiliary work.
The treatment stopped 32 queued CommandCode pages and 33 queued OpenCode pages;
active pages that exceeded grace were interrupted. Completed findings survived.

Both models currently take the conservative unknown-model prompt budget:
128,000 context minus 32,768 output and 8,192 harness reserve, with one byte per
token as the safe upper bound. The effective 87,040-byte budget is below both
old and new global input ceilings. Raising the non-Cline ceiling alone would
therefore not reduce pages in these runs. Supplying verified model limits is a
separate experiment; no new cap, reasoning default or public flag is introduced.

## Finding adjudication

Manual, unblinded adjudication; the full-branch input has no preregistered defect
oracle. Counts below are not a precision/recall estimate.

- CommandCode control retained four candidates. The workspace-capability claim
  misses the caller's explicit model-tools guard; the deletion-line claim mistakes
  a deliberate nearby new-side evidence anchor for a changed-line assertion.
  The two withheld hypotheses miss option normalization and the auxiliary reuse
  contract (prior comments persist; main review still reruns). No actionable
  defect was established in these candidates.
- CommandCode treatment emitted one candidate about mutable forwarded session
  options; verification refuted it. No findings remained.
- OpenCode control retained the claim that zero must mean unlimited. At the
  frozen revision, README and Action inputs already specify zero means three;
  the suggested `??` replacement would violate that public contract. The
  contradictory normalization/dead branches are removed by the correction here.
- OpenCode treatment retained nine findings. Three are actionable: stale Action
  input help, prepared evidence excluded from quote validation, and missed
  `git --no-pager diff` telemetry classification. The evidence defect is already
  fixed in `75e4e24`; the other two received small follow-up fixes. The classifier
  only affects telemetry and retains the original command-variant test.
- The remaining OpenCode findings are not applied: the preset audit describes
  its historical revision; Unicode mention extraction is an optional research
  heuristic limitation, not a demonstrated default-workflow failure; finding
  anchors use the new side, invalidating the proposed old-side deletion example;
  patchless files are filtered before planning; the zero-cap claim again assumes
  the wrong contract; and the hypothetical repeat-result consumer ignores the
  explicit `exactRepeat` flag. Existing aggregate repeat counters are correct.

OpenCode therefore still confidently confirms low-value or unsupported claims.
The deterministic quote check addresses evidence provenance, not this broader
precision problem. Dry-run `posted-inline`/`orphaned` dispositions describe routing,
not actual GitHub posts.

The additional CommandCode working-tree smoke used the updated runtime and
current branch diff: **432.695s, 414/414 hunks, 56/56 main tasks**. Its two retained
hypotheses were inconclusive and withheld. Manual source tracing refutes both:
`symbolPattern` producers restrict symbols to identifiers, and recursive
`promptHoldingSlot` gives wrap-up a separate recording guard. This smoke is not
another timing pair; the input snapshot hash records its initial working tree.
The later telemetry-only classifier fix has its own focused regression coverage;
this smoke predates it.

These counts are not quality scores. Supplemental work intentionally decreases;
complete main delivery does not establish equivalent recall. Separate real
preflight reviews caught and verified the executable 201-to-100 job-loss defect
on both providers (CommandCode 15.074s; OpenCode 18.993s). That narrow positive
control does not establish general precision, recall or severity calibration.

## Self-review and de-slop

Self-review: no remaining P1/P2 implementation issue found.

Seams reviewed: main/aux backend selection, page construction and retry scope,
full assembled-prompt budgets, global/provider queues, process cancellation,
source/cache trust boundaries, verifier parsing and promotion, every publication
route, worker/Arena counts, diagnostics, CLI packaging and generated catalogs.
Historical audit data parses and its relative links resolve. No configured
credential value was found in the changed tracked files.

Removed two narrating comments and an unnecessary single-use source cache from
this increment; folded regression checks into existing cases. No dependency or
flag added. The full-branch inventory includes both current and removed blocks:
67 comment blocks adjudicated: 22 kept, eight compressed rewrites, 37 cut
(including previous branch deletions). Test inventory: 56 added cases kept for
independent failure modes, zero folded/cut; five existing renamed cases received
ordinary assertion review. Existing body edits were checked separately; lost
prefix checks and the invented-quote negative assertion are retained.

Runtime, tests and product documentation relative to `95a9d98`: +112 / -79, net +33
lines before these audit artifacts. No public reproduction wrapper was added;
the existing experiment scripts remain the supported interface.

Validation: 1,119 tests, typecheck, lint, format, build and diff checks pass.
Docker packaging is unchanged in this follow-up; the preceding Cline audit
records its build and real container test. Current external docs were checked
through Context7; CommandCode's model-specific flags were validated against the
pinned CLI and actual runs because its retrieved docs did not cover them.

The already completed [hosted run at `95a9d98`](https://github.com/pgup-ai/jbot-review/actions/runs/35557299607)
passed, delivered 392/392 main hunks, and successfully uploaded diagnostics.
Its three published comments describe the same zero-cap contract mismatch,
corrected here. This is prior-head hosted evidence, not validation of `75e4e24`.

**The required full-corpus default-policy gate remains unmet.** The advisory core
corpus was not rerun. These local trials do not qualify the entire branch for
production, establish equivalent recall after auxiliary cutoff, or eliminate
confident false positives. No passing benchmark ledger row is claimed.

New audit files: report 179 lines; measured data 890 lines.
