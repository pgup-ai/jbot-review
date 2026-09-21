# Selective source delivery after a review read

Continue `codex/jev-evidence-prefetch` from `d0e0dbe`. The preceding experiment
delivered evidence but did not reliably replace sequential reads. This round
tests a narrower selection policy before considering another latency claim.

## Hypothesis and implementation

`JBOT_READ_EVIDENCE=linked` supplies at most two directly import-linked source
files around the requested source range. It excludes the seed, unresolved text
matches and paths already requested or delivered in that session. This is a
syntactic approximation of the current investigation, not an inference about
the model's private reasoning or a complete call graph. Original reads and
unrestricted follow-up exploration remain available.

The existing tracked-source collector, freshness checks, byte budgets and
fail-open behavior remain. Native read ranges and literal numeric `sed` ranges
identify relevant definitions; literal multi-file `cat` is observed without
evaluating shell syntax. Native reads are bounded to the installed OpenCode
version's 2,000-line default and cap, not proof that the provider returned every
requested line. Path suppression
can omit useful unseen portions of a previously requested file; ordinary reads
remain the recovery path. Two attempts per session, four seconds per preparation
and 7,000 added bytes per result are unchanged. No model call prepares evidence.

Augmentation is serialized within a session so simultaneous reads cannot both
inject the same dependency. Cross-session source caching retains freshness
checks; findings and reviewer conclusions are not shared. New counters record
delivered files, observed reads, subsequent requests for delivered files,
unclassified shell calls, excluded candidates and empty packets. A subsequent
request is not necessarily waste: it can seek lines outside a supplied excerpt.
Unclassified calls prevent absence of an observed reread from proving avoidance.

The broad arm remains available as `JBOT_READ_EVIDENCE=1`; default remains `0`.
The run/cache configuration distinguishes all three settings. A plan with
`"readEvidence": "linked"` compares baseline, broad delivery and linked delivery.

## Mechanism probe

Three live sessions answered the same source-dependent arithmetic question.
`a.ts` imports `rate` from `b.ts`; the rate is absent from the prompt. The prompt
requires reading `a.ts` first but does not instruct the model to reuse a packet.
All three returned the correct result, 386.

| Arm      | Source reads | Total tools | Model turns | Delivered packets |
| -------- | -----------: | ----------: | ----------: | ----------------: |
| Baseline |            2 |           5 |           6 |                 0 |
| Broad    |            2 |           4 |           5 |                 2 |
| Linked   |            1 |           3 |           4 |                 1 |

Linked delivery supplied only `b.ts`, 1,379 added bytes, in 20 ms; no subsequent
read of `b.ts` occurred. Broad delivery supplied 3,183 added bytes, and the model
still requested `b.ts`. This is evidence of one removed dependency read in a
controlled task, not a review-quality or latency result.

The initial probe assertion incorrectly equated one source read with one total
tool call. The linked session also made a failed read and a file-discovery call.
The retained raw run failed that assertion; post-run adjudication checks actual
source reads and preserves every tool call. Files are under the ignored
`.jbot-review/jev-experiment-v9/` directory, including `probe.json`, transcripts,
the original `probe.log` and `probe-adjudication.json`.

## Natural review protocol

The adoption pilot uses the four existing clean/defective fixtures, one review
per arm per fixture (12 reviews), in seeded serial order. Keep all results,
including failed or slow runs. All arms use the same OpenCode route and effort,
full diff, verification and finding policy. Earlier preloading, checkpoints and
standalone retrieval remain disabled. Provider cache state is uncontrolled.

Only continue to repeated latency trials if delivery occurs naturally and the
tool traces support some replacement of later reads without losing seeded
defects. Before confirmation, add an unseen clean/defective contract pair and
freeze source, fixture SHAs, seed and settings. Compare findings against concrete
fixture contracts before interpreting time. A small synthetic comparison cannot
establish broad quality equivalence or justify a default-policy change.

## Pilot and confirmation decision

Pilot revision `cd923e2`; all 12 reviews completed, no incomplete session. Each
arm retained all four seeded P1 defects and produced no clean-case finding.
All 12 retained findings were manually checked in an arm-masked list against
the fixture contracts; this is not independent blind adjudication.

| Pilot mean        | Baseline |  Broad | Linked |
| ----------------- | -------: | -----: | -----: |
| Total seconds     |    22.37 |  16.44 |  13.95 |
| Tool calls        |    13.50 |  10.75 |   6.75 |
| Model turns       |     6.00 |   5.75 |   5.00 |
| Tool-output bytes |    5,996 | 11,181 |  7,671 |

Linked delivered eight packets, 13,908 added bytes, with 126 ms preparation and
no fallback. In chain-defect trial 04 the main reviewer used native reads,
received two packets, and omitted the separate checkout/queue reads present in
baseline trial 02. It retained the downstream defect. Its verifier used an
unclassified shell loop, so not all of the total tool reduction can be credited
to injection. In trial 05 a shell loop preceded the first packet: path-level
suppression cannot recognize source supplied by arbitrary shell programs.

The pilot supports replication, not a speedup claim. Before confirmation the
subsequent-read counter was tightened to count only reads completed in a later
model request than delivery. Same-turn completions can belong to an already
running tool batch. A regression assertion covers both cases. Selection,
rendered prompts and packet budgets are unchanged by this instrumentation fix.

Confirmation uses six fixtures, three arms and three repetitions (54 reviews),
seed `linked-read-confirmation-2026-09-19`. The added pair exposes `recordId` in
a webhook receipt: the clean adapter keeps `ok: true`; the defective adapter
uses `record.inserted`, causing an existing duplicate to return 503/retry instead
of 204/no-retry. Both have identical supported entrypoints and test contracts.
Their local executable oracle passes the clean version and fails the defect.
The pair is held out from the pilot and selection-policy development.

The expected currency defects must retain confirmed P1; the new retry defect
accepts confirmed P1/P2. Clean-case assumptions about unsupported external callers
do not qualify as defects. Frozen expectations are in
`confirmation/quality-contract.json`; fixture SHAs and settings are in the plan
and generated manifest. All scheduled rows remain in the results.

## Frozen confirmation results

Revision `68fcfa0`, 18 reviews per arm. All 54 processes completed; one linked
verification session was incomplete. None were retried or excluded. All 44
retained findings were manually checked in arm-masked form against the fixture
contracts, then mapped to their runs. This is not independent blind adjudication.

| Measure                         | Baseline |   Broad |  Linked |
| ------------------------------- | -------: | ------: | ------: |
| Median total seconds            |    16.98 |   15.09 |   15.42 |
| Mean total seconds              |    24.44 |   14.68 |   13.39 |
| Mean tool calls                 |     9.83 |    7.83 |    7.11 |
| Mean model turns                |     5.39 |    4.44 |    4.67 |
| Mean tool-output bytes          |    4,166 |   7,854 |   6,554 |
| Mean uncached input tokens      |   40,943 |  40,331 |  41,239 |
| Mean cache-read tokens          |  105,088 |  81,749 |  86,471 |
| Mean reported cost, USD         |  0.00927 | 0.00850 | 0.00875 |
| Seeded roots retained           |    15/15 |   14/15 |   15/15 |
| Roots at required confirmation  |    15/15 |   14/15 |   12/15 |
| Unverified P3 roots             |        0 |       0 |       3 |
| Findings on clean cases         |        0 |       0 |       0 |
| Incomplete verification batches |        0 |       0 |       1 |

The linked arm used 27.7% fewer tools and 13.4% fewer turns; its median elapsed
time was 9.2% lower. These are sample observations, not an established general
speedup. Baseline row 24 spent almost 149 seconds before its first model reply
without logged tool activity; baseline row 41 took 51 seconds. Both remain in
the mean. Their cause is unresolved, and the mean difference must not be
attributed entirely to evidence delivery. Provider cache state is uncontrolled.

Case medians show the mixed result more clearly (three repetitions each):

| Fixture                  | Baseline seconds | Broad seconds | Linked seconds |
| ------------------------ | ---------------: | ------------: | -------------: |
| Clean currency adapter   |             4.62 |          5.19 |           5.30 |
| Defective adapters       |            20.60 |         24.29 |          17.65 |
| Clean dependency chain   |            13.38 |         17.73 |          17.04 |
| Defective chain          |            24.31 |         20.09 |          18.14 |
| Clean receipt contract   |             5.92 |          6.33 |           5.62 |
| Defective retry contract |            18.49 |         14.50 |          13.85 |

In linked row 49 the verifier returned no `verdicts` array. All three currency
roots survived as explicitly unverified P3 concerns, so this arm **fails the
preregistered confirmed-severity criterion**. In broad row 53 the reviewer read
the adapter, store and handler but returned no finding for the retry regression;
the failing executable oracle establishes the missed root. These observations
do not establish that either selection policy caused its quality failure.

Linked delivery produced 36 packets / 59,804 added bytes, with 740 ms total
preparation and no delivery fallback. It supplied 37 distinct paths summed
across sessions, observed two later-turn requests for supplied paths, excluded
281 candidates and returned 12 empty packets. There were 13 unclassified shell
calls, versus six in the broad arm. Baseline observation counters are absent
because its hook is disabled; zeroes in the raw summary are not evidence that
baseline made no shell calls. Packet counts and absence of recognized rereads
cannot prove how many calls were saved.

The mechanism probe and pilot trace demonstrate that selective delivery can
replace a dependency read. Confirmation supports continuing that direction but
does not clear a quality gate or justify enabling it by default. The next useful
check is a larger real-repository review with retained transcripts, including
whether the verifier actually reuses supplied evidence and still returns usable
structured verdicts. Do not add a retry or weaken verification merely to improve
this experiment's score.

## Installed read contract correction

After the frozen confirmation, the native range observer was aligned with the
2,000-line default/cap in installed OpenCode 2.0.5. Source was checked at
[`79169fe` read tool](https://github.com/anomalyco/opencode/blob/79169fe966d58fb0e0a5e41133716184a0ab4ca6/packages/core/src/tool/plugin/read.ts)
and [filesystem implementation](https://github.com/anomalyco/opencode/blob/79169fe966d58fb0e0a5e41133716184a0ab4ca6/packages/core/src/tool/read-filesystem.ts),
alongside the [current tool documentation](https://opencode.ai/v2/docs/tools).
Previously an omitted limit was observed as an unbounded file request. An
existing regression case now covers default, zero and capped explicit limits.
All confirmation source files are at most 18 lines, so the correction cannot
change their selections; the timing results still refer to `68fcfa0`, not the
later corrected revision. Earlier byte truncation remains possible.

## Full-branch dogfood

The built local pipeline reviewed `2d8f923...58863d3` in a clean throwaway
worktree: linked first, then baseline, with identical diff hash, model route,
effort and other experiment settings. One run per arm; provider cache state and
model generation are uncontrolled. The guideline pass and independent verifier
ran in both. The worktree stayed clean and was removed after both completed.

| Measure                  |  Baseline |    Linked |
| ------------------------ | --------: | --------: |
| Total seconds            |    194.02 |    138.29 |
| Main phase seconds       |    150.21 |    111.27 |
| Verification seconds     |     42.77 |     25.79 |
| Tool calls               |        46 |        38 |
| Model turns              |        46 |        36 |
| Tool-output bytes        |   313,596 |   301,416 |
| Uncached input tokens    |   219,883 |   213,607 |
| Output tokens            |    55,153 |    38,007 |
| Cache-read tokens        | 3,196,928 | 2,151,424 |
| Reported model cost, USD |   0.13574 |   0.10079 |
| Retained P3 suggestions  |         3 |         3 |
| Incomplete sessions      |         0 |         0 |

Linked delivered five packets / 25,522 added bytes, with 453 ms preparation,
no fallback and one observed later-turn request for a supplied path. The
verifier received two packets and returned usable verdicts. This confirms the
feature runs on the full branch; it does not erase the confirmation failure or
establish a general 29% speedup. The arms produced different low-priority
suggestions and different output-token counts, so the timing difference cannot
be attributed solely to delivery. There is no known-defect recall oracle for
this branch diff.

Sanitized transcripts preserve tool/turn sequences but redact tool inputs,
outputs and metadata. Therefore they cannot establish which supplied source
lines were reused. The separate mechanism probe retains source-read locations;
the full-branch evidence is limited to numeric counters and bounded progress
logs. Many logged calls retrieve diff sections and are outside this feature's
source-read grammar. Batching omitted diff recovery is a separate candidate for
the next experiment, alongside isolating main-review and verifier delivery.

## Self-review and de-slop

Applied `jbot-review-pr-self-review` and `jbot-review-de-slop` against the fetched
base `2d8f923`. Reviewed all branch source/test/config changes, current docs and
prior audit decisions. Rechecked guarded source admission, freshness, budgets,
concurrent delivery, failure paths, prompt ordering, configuration identity,
numeric-only counters and read-only plugin behavior. Full-diff scope and
independent verdict handling remain unchanged; the runner is unchanged this
round. No remaining P1/P2 issue was found.

All six dogfood suggestions were adjudicated:

- **Applied:** the generated plugin now lets `installReviewRetrieval` read its
  options through the existing `explorationExperiment` helper. A cheap import
  gate remains so disabled experiments do not load the retrieval module.
  Existing checkpoint coverage now exercises the omitted-options entry point.
- **Applied:** the two symbol-boundary expressions share `symbolPattern`, with
  two production callers. Matching semantics are unchanged; the collector
  compiles the pattern once before scanning lines.
- **Not applied:** moving Babel to dev-only dependencies would break runtime
  experiments. The eager-load concern is plausible, but the reported 2 MB parser
  is not the measured source size (513,377 bytes), and no startup penalty was
  established. A packaging split needs its own measured tradeoff.
- **Not applied:** accepting a prefix of an unsupported shell chain changes the
  observer's deliberately conservative contract. Unknown grammar is recorded
  as unclassified; original commands still run. The existing regression rejects
  `cat a.ts && git diff`. No shell grammar expansion was folded into this trial.
- **Not applied:** the parser pin and cache-key version currently agree. The
  suggested future upgrade hazard does not demonstrate a current invalidation
  failure; keep them synchronized when upgrading the parser.
- **Not applied:** required legacy counters and optional newer counters have
  separate validation for compatibility. All current producer fields are read;
  no missing counter was identified. A generalized schema is unnecessary here.

These two cleanup refactors follow the frozen timing runs. They do not change
the selection policy, prompts or budgets; no measured speedup is attributed to
them. The native range correction above also follows confirmation. Existing
assertions were preserved, with default/capped range checks folded into the
existing read-parser case.

Comment adjudication for the final branch (two moved blocks count once):

| TypeScript block                 | Verdict and reason                                      |
| -------------------------------- | ------------------------------------------------------- |
| Optional persistence catch       | keep: explains fail-open storage errors                 |
| Imports/citations priority       | keep: explains scarce read-slot ordering                |
| Documentation priority           | keep: protects contract evidence from a full code pool  |
| Unsupported syntax catch         | keep: explains retained text fallback                   |
| Tracked-source symlink guard     | keep: explains the credential boundary                  |
| Whole-turn usage accounting      | keep: explains V2's per-step assistant messages         |
| Literal shell grammar            | keep: explains why syntax is never evaluated            |
| Counter-file write catch         | keep: explains why telemetry cannot interrupt review    |
| Attempt reservation before await | keep: explains the concurrent budget race               |
| Serialized packet preparation    | keep: explains duplicate dependency delivery prevention |

All eight added `.env.example` comment blocks are kept as operator-facing mode,
credential, cache and documentation-path instructions. One was added this round.

The 16 cases adjudicated in
[the tool-reuse audit](2026-09-19-tool-reuse-investigation.md#full-branch-self-review-and-de-slop)
were rechecked and retained for the same distinct failures. The other eight
branch-added cases were individually retained:

| Case                       | Unique failure caught                                                               |
| -------------------------- | ----------------------------------------------------------------------------------- |
| Source admission budget    | A ninth oversized source is indexed/persisted outside the budget                    |
| Failed wrap-up accounting  | Failed nested wrap-up counts the main turn twice                                    |
| Checkpoint decision        | Pressure is ignored or a second checkpoint fires without runway                     |
| Linked candidate selection | Seed/known/unbound paths or duplicate files consume selection slots                 |
| Retrieval integration      | Tool registration returns stale or unsafe source despite valid inputs               |
| Checkpoint plugin          | Hook targets tool-less agents, ignores mode options or persists source text         |
| Automatic read evidence    | Parallel calls exceed the attempt cap or mutate original result/metadata            |
| Linked delivery            | Concurrent packets repeat dependencies or same-turn reads inflate later-read counts |

Cut: duplicate execution-option parsing and duplicate symbol regex construction.
Comments: 10 TypeScript blocks and eight configuration blocks kept, none rewritten
or cut in this round. Tests: 24 branch-added cases kept, no new-case folds or
cuts; two cases were added this round. Existing cases received additional
assertions without weakening prior contracts.

Validation after cleanup: all 1,092 tests pass, including 28 focused tests;
formatting, typecheck, lint, build and diff checks pass. A scan of 381 changed
files and local artifacts found no configured credential values; `.env` remains
ignored. The two full-branch dogfoods precede the final
refactors and are not claimed as reruns of the final source. No packaging entry
point or dependency changed this round; the preceding audit records the Docker
slim build/import check. The advisory core corpus with three repetitions and
independent adjudication was not run. These selected fixtures and local dogfoods
do not establish broad quality equivalence or a benchmark-ledger pass. All
experiment defaults remain off.

Local artifacts are retained in `.jbot-review/jev-experiment-v9/`: fixture recipe
and executable oracles, probe data, pilot, confirmation manifest/results/labels,
dogfood manifests/reviews/sanitized transcripts and validation logs. Confirmation
SHA-256: `manifest.json` =
`879c94a97b4876d414729df6da6919e7ba3b1d1f80e4624e0c289e30d26ca605`;
`results.json` =
`2f1049fd14f19e33581b76306e660ba48121acc0783bbc51ccd3971b27567c26`;
`adjudication.json` =
`5804c4fa8680e36a9511a84a9910e565d9ce5a2e40a0582d1a88fd84ffe93dcd`.

Round diff from `d0e0dbe`: 694 additions, 64 deletions (net +630) across 14 tracked files. No untracked deliverables remain.
