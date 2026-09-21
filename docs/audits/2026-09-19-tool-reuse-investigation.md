# Review retrieval and tool reuse investigation

Date: 2026-09-19. Continues `codex/jev-evidence-prefetch` from `17cd2e5`.
All evidence experiments remain off by default.

## What to borrow from other reviewers

These are documented product approaches, not claims about private implementations
or a comparative benchmark:

- [Codex](https://openai.com/index/introducing-upgrades-to-codex/) describes
  following repository dependencies and validating behavior. Preserve independent
  verification; cache source facts rather than a reviewer's conclusions.
- [Cubic](https://www.cubic.dev/blog/skills-mcp-launch-week-03-day-4) exposes
  architectural wiki context and learned review conventions through focused tools.
  A revision-aware repository map could replace repeated orientation. The existing
  guideline preload already supplies part of this context.
- [Qodo](https://www.qodo.ai/blog/introducing-qodo-aware-deep-codebase-intelligence-for-enterprise-development/)
  describes specialized context tools over indexed code. Prefer queries that return
  a definition and relevant callers together, with provenance and hard bounds,
  over asking an LLM to rediscover each connection through separate calls.
- [CodeRabbit](https://www.coderabbit.ai/blog/context-engineering-ai-code-reviews)
  documents rebuilding a dependency graph for each review, plus static analysis and
  verification scripts. Its emphasis on fresh dependencies supports content-addressed
  syntax reuse, not reusing a stale whole-repository search or narrowing diff scope.

The practical priority is fewer sequential model turns: bounded batched retrieval,
then relevant source handoff, then avoiding redundant host execution. A tool cache
can skip a subprocess while still paying for the model to request and consume it.
Provider prompt caching, host evidence caching, and exact shard-result reuse already
exist and save different kinds of work. A summed tool duration is not a wall-time
prediction, particularly when sessions overlap.

## This continuation

The previous repository dogfood captured one native source-read location even
though most reads used shell tools. Extended the existing opt-in handoff to recognize
literal `cat` and numeric `sed -n` reads, optional initial `cd`, and `&&` chains.
Unknown syntax, shell expansion, pipelines, redirects and unrecognized commands
are ignored. This is location observation only: no shell command or output is
replayed. Current source still passes tracked-file, symlink, size and workspace
checks before bounded selection. No conclusions or verdicts transfer.

Added exact-request/result observations to OpenCode telemetry. Successful requests
are compared by tool name and complete serialized inputs, including offsets and
flags; outputs must also match before being counted as unchanged. Changed results
and failed requests cannot be reported as reusable successes. Digests are computed
before the telemetry adapter and salted again in its bounded per-run map. Only
booleans and counts are persisted. This deliberately undercounts semantically
equivalent requests with different argument order or descriptions.

`unchangedRepeatDurationMs` sums the observed durations of unchanged repeated
requests. It includes tool overhead, can overlap other work, excludes model turn
latency, and is neither an actual cache hit nor a freshness guarantee. No arbitrary
shell-result cache was added. The documented [OpenCode V2 hooks](https://opencode.ai/v2/docs/build/plugins)
observe/modify tool inputs and results; before/after hooks alone do not establish a
safe permission-preserving execution bypass. The installed runtime is 2.0.5.

Existing prompts already instruct lens passes to batch independent reads. Further
experiments worth isolating are a bounded multi-file context tool across main and
verification sessions; a content-addressed symbol map refreshed from the current
checkout; and explicit diff-page metadata to reduce repeated diff navigation.
None should suppress full-diff coverage or require copying a main review's reasoning
into its verifier. Automatic test execution needs an isolated test environment;
it is not appropriate to add to the current read-only review sessions.

## Full branch self-review and de-slop

Reviewed every changed source/test/config/document file against freshly fetched
`origin/main` (`2d8f9239424ba6644dcc36e0d45433eb74640974`), including earlier
experiment stages. Checked local/Action/app environment wiring, source admission,
cache ownership and invalidation, exact Jev request identity, budgets and timeout
floor, prompt assembly, auxiliary fail-open behavior, independent verdicts,
telemetry privacy and experiment reproducibility. No model/provider default or
finding-disposition rule changed. Read-only plugin/permission/environment layers
are unchanged.

The full suite caught raw new measurement fields crossing the telemetry adapter's
privacy boundary. Fixed by hashing at the OpenCode adapter before recording them;
the existing privacy assertion was retained. Reused `evidenceMode` to remove the
runner's duplicate four-arm parsing. A valid P3 from local dogfood identified
background prefetch with no shared consumer; `warm()` now requires shared reads,
and an assertion in the existing shared-read test pins zero inventory work when
shared reuse is disabled. Consolidated source and Jev digest calculations on the existing `evidenceHash`
helper and removed the unused public `SourceIndex` export. Removed two comments
that restated code or already documented option semantics. Historical experiment audits remain intact.

Comment adjudication (each block, including the moved existing source guard):

| Block                                     | Verdict | Reason                                                                    |
| ----------------------------------------- | ------- | ------------------------------------------------------------------------- |
| evidence-cache optional persistence catch | keep    | Explains fail-open policy for an intentionally ignored error.             |
| evidence imports/citations priority       | keep    | Explains why broad matches must wait for scarce read slots.               |
| evidence documentation priority           | keep    | Explains protection against code candidates crowding out contracts.       |
| evidence unsupported syntax catch         | keep    | Explains retained text fallback after parsing failure.                    |
| finding-context symlink guard             | keep    | Explains the credential boundary behind path equality.                    |
| prompt JSON byte cap                      | cut     | Restates the hard limit already enforced by the loop.                     |
| runner shadow option                      | cut     | Repeats public mode documentation.                                        |
| literal shell grammar                     | keep    | Explains why observation never evaluates or replays shell.                |
| moved whole-turn usage comment            | keep    | Explains why one terminal assistant message cannot account for a V2 turn. |

Added-test adjudication (existing-case extensions reviewed separately, with no
weakened assertions):

| Case                                | Verdict and unique failure                                                             |
| ----------------------------------- | -------------------------------------------------------------------------------------- |
| syntax collection/body-only aliases | keep: body edits or aliased calls disappear from discovery.                            |
| prepared-arm candidate parity       | keep: provider selection bypasses protected admission or uses stale parsed source.     |
| invalid docs/timeouts               | keep: preparation fails closed or reports an incorrect model/API activity.             |
| failed/budget-starved preparation   | keep: an evidence failure or deadline prevents independent verification.               |
| shared reads                        | keep: cache accepts same-size edits, removed tracking or a symlink replacement.        |
| handoff revalidation                | keep: observed shell locations do not become current protected source candidates.      |
| persistent indexes/judgments        | keep: stale/corrupt responses are reused or a cache hit is rebilled.                   |
| Jev request budgets                 | keep: escaped/multibyte JSON exceeds bounds or questions lose candidate identity.      |
| Jev ranking                         | keep: unstable ties, duplicate paths or invalid probabilities enter selected evidence. |
| off/shadow integration              | keep: inactive modes change baseline prompts or credentials leak into context/logs.    |
| HTTP/response failures              | keep: provider failures change baseline behavior or expose provider error text.        |
| source completeness                 | keep: a clipped prefix is represented as a complete file.                              |
| deterministic control               | keep: the control calls Jev, invents billing, or differs in candidate admission.       |
| OpenCode callback                   | keep: verification history or tool output feeds back into the evidence handoff.        |
| literal read parser                 | keep: unsupported shell syntax is interpreted or cwd/ranges are lost.                  |
| exact repeat telemetry              | keep: failed/changed results or different read ranges are counted as unchanged reuse.  |

The advisory core corpus (60 cases × 3 repetitions plus independent adjudication)
was not run. Local dogfood and deterministic tests do not establish broad quality
non-regression; no benchmark-ledger pass or default-policy promotion is claimed.

## Local profiling

The first run is profiling evidence, not a complete branch-review validation:
the two newly created parser/test files were still untracked and omitted from
its initial diff (the review did read the parser through an import). The CLI
reported that omission. No source changed during this run. The final dogfood
includes those files in the diff after staging them. Source fixes and diff scope
differ between runs, so the two runs are not a controlled latency comparison.
The first run also overlapped the tail of the deterministic test suite.

Profile: 239.773 s, 43 tools, 41 observed assistant turns across main/guideline/
verification. The four coarse duplicate reads did not become four cache hits:
there was one exact repeated request, whose result changed, and zero identical
request/result repeats. Summed observed tool durations were 18.539 s across
overlapping sessions; unchanged-repeat duration was zero. This trace offers no
evidence for an exact-output cache win and cannot rule out range-level or
normalized-query reuse. Raw inputs and results are not present in telemetry.

Main, guidelines and verification completed. One valid P3 was retained and fixed
(prefetch without a shared consumer). A second hypothesis about an undefined
verification deadline was correctly refuted: undefined means an explicitly
unbounded run; the five-second preparation ceiling remains intentional.

All three branch runs use OpenCode 2.0.5, DeepSeek V4 Flash, medium main/aux effort,
low verification effort, one main shard/pass plus the existing guideline pass,
shared reads and deterministic verification evidence. Prefetch and persistent
cache are off. The later two enable handoff. No Jev API call or GitHub posting is
part of this round. Provider prefix-cache state is uncontrolled.

### Timed handoff run

The second run included the complete source diff and finished in 242.417 s, but
main review was cut short and wrapped up. Guidelines and independent verification
completed. It selected two of three recorded handoff candidates; this proves the
selection path was exercised, not a speedup. The sole retained P3 was rejected
manually: README already explicitly says `injectedBytes` excludes `coverageBytes`
and that both must be added for the full packet; the named consumers preserve
these fields rather than treating one as an aggregate.

A separate accounting defect was exposed by this run: the early wrap-up return
skipped the main turn's tool/usage collection and source observations. Its zero
main-tool row is missing observation, not zero exploration. A subsequent fix
shares turn collection between the normal and interrupted paths before wrapping
up, preserving distinct main/wrap-up billing and transferring completed read
locations. The existing forced-wrap test covers the lost work and double counting.
The recorded interrupted run is retained unchanged and is not included in exact
cache-opportunity totals. A third review has a larger time allowance; it is a
completion check, not a replacement latency sample.

### Completed full-branch review and final corrections

The third run completed in **292.962 s**, with main review, guideline checking
and independent verification completed and no incomplete sessions. The main
model initially returned an empty response; the existing single continuation
path recovered it. That continuation is included in the timing and cost.
The larger allowance changed only this local test, not a shipping default.

It recorded **39 tool calls**, zero exact repeats, and 15.514 s of summed tool
durations across overlapping sessions. Four locations reached handoff candidate
collection; two were selected into verification context. Combined with the first
profile, **82 fully observed calls had zero identical request/result repeats**.
This conservative exact-match measurement does not cover equivalent queries,
overlapping ranges or other repositories, and does not establish that caching
can never help. No review-time speedup is claimed from these differently scoped
and configured runs. The remaining latency is dominated by model work; a faster
local read is not a saved model round trip.

Two P3 comments were retained and manually adjudicated:

- Duplicate SHA-256 implementation: applied the shared helper cleanup, also
  using it for the three Jev digest calculations. Digests and cache keys are
  byte-identical; tests still validate candidate parity and cache invalidation.
- Prefetch snapshot can be taken while warming: retained the non-blocking design.
  `prefetchStatus: running` already makes incompleteness explicit. Awaiting warm
  solely for final statistics would extend fast reviews. Clarified that running
  snapshots are not final reuse/waste totals and pinned the running status in
  the existing test. None of this round's profiles enabled prefetch.

After this frozen review, the accounting fix and mechanical cleanup were applied.
The accounting fix was checked against a real OpenCode 2.0.5 server with a forced
wrap-up over a disposable source-chain fixture: **4 tools / 5 main assistant
messages** and all four tool-input observations survived; the wrap-up used zero
tools and one assistant message. Main usage (22,933 input tokens) and wrap-up
usage (1,184 input tokens) were recorded separately, without double counting.
The shared-source test now also proves prefetch without shared reuse does zero
inventory work. No full paid branch review was repeated for the final accounting
and digest refactor; focused regression tests, the live wrap-up probe and the
complete deterministic suite cover those final changes.

Self-review: no remaining P1/P2 issues found.
Cut: duplicate mode parsing, duplicate digest implementation/chains, unused type
export, two repetitive comments, and background preparation without shared reuse.
Comments: 9 adjudicated — 7 kept, 0 rewritten, 2 cut.
Tests: 16 added cases adjudicated — 16 kept, 0 folded, 0 cut. The existing forced-
wrap case now additionally pins tool counts, source observations and separate
usage; existing assertions were preserved.
Validation: all 1,084 tests; typecheck; lint; Prettier; build; diff checks; three
local branch reviews with the limitations above; real forced-wrap smoke test.
Residual risk: narrow profiling sample, one cut-short dogfood attempt, conservative
exact identities, deliberately limited literal-shell grammar, and no advisory
core corpus or independent blind quality gate. No defaults were promoted.

## Local artifacts

Ignored `.jbot-review/jev-experiment-v6/` retains each run's manifest, review JSON,
log and sanitized transcript, plus the live wrap-up result. `handoff/reviewed.diff`
and `complete/reviewed.diff` preserve the full frozen inputs. The new audit was
written after those runs and manually reviewed. Runtime identity was
`17cd2e5-dirty`; each manifest records the source-diff hash, and the final changes
are distinguished above. The first profile's source omitted the two untracked
files and its full patch was not separately archived.

- `baseline/review.json` SHA-256: `1232b283f259dca56a1e6bf43c6fa239edcabf0a558ba9b19f06c47e0a70f37f`
- `handoff/review.json` SHA-256: `b127f40a9d836413e8afd45e06b880c4eacbc3805808659b9df9cc83913a0a76`
- `complete/review.json` SHA-256: `42b5f9aaedc32dffa3329f0b7e9705bc53ecccdd429961ad1d75a4fb03ce0e9b`
- `wrap-probe.json` SHA-256: `07d59c390231969f3bbd286719127b5eb948bcb5f42c3dcea1c4288a293ee48c`

Continuation net line delta: +472 across 14 tracked files; no untracked source files.
