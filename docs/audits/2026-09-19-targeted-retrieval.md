# Targeted retrieval and exploration checkpoints

## Protocol and implementation

Continue on `codex/jev-evidence-prefetch`; no default-policy change. The complete
base...head diff, independent verification, finding filters, read-only session
rules and existing wall-time/finalization budgets remain in force.

`JBOT_TARGETED_RETRIEVAL=1` adds OpenCode's `review_context(path, line)` tool.
It reuses `EvidenceStore`, including tracked-file/symlink checks, current-source
revalidation, syntax indexes, bounded import/reference collection and source
hashes. Each request selects at most four excerpts / 6,000 bytes, plus the
bounded coverage notice. Collection admits at most 64 source files / 2 MiB and
has a four-second cancellation deadline. It does not execute reviewed source,
read untracked files, evaluate shell input, or replay another agent's conclusions.
Ordinary search/read tools remain available for omissions and deeper dependencies.

`JBOT_EXPLORATION_CHECKPOINTS=1` adds a soft reassessment instruction after eight
model requests, 32 KiB of successful tool output, or two repeated result bodies
since the previous checkpoint. At least two requests separate checkpoints.
The instruction preserves changed-hunk coverage and unresolved failure-path
investigation. This is neither a depth cap nor a forced early-finalization rule.
The thresholds are experimental, not calibrated defaults. Repeated result bodies
are only a pressure signal, not proof that an investigation is unnecessary.

Both switches are OpenCode-only. They participate in the run configuration and
shard-result cache identity. Counters distinguish checkpoint triggers, retrieval
calls/fallbacks, candidate counts and preparation time. Counter files contain
only numbers and are stored in the server's private temporary data home; the
parent reads per-prompt deltas, including continuations and interrupted work.
No new dependency, API key, Jev call or external service was added in this round.
The earlier Jev ranking experiments remain available separately.

The OpenCode V2 [plugin contract](https://opencode.ai/v2/docs/build/plugins)
was checked through Context7 and the official documentation, then exercised
against installed version 2.0.5. Explicit `codemode: false` is necessary to put
the composite tool on the native tool list. An initial smoke probe without that
setting could not call the tool. The corrected probe successfully retrieved two
source excerpts in 15 ms. The frozen comparison below exercised three
checkpoints without removing ordinary tools. Tool availability alone does not
establish natural adoption or a review-speed improvement.

## Frozen comparison

The guided comparison runs revision `a902b54`, serially, with a seeded order,
three repetitions and three arms: current behavior, retrieval plus its usage
instruction, and retrieval plus checkpoints. Every arm disables the earlier
Jev/exploration/verification preloading experiments. Model:
`opencode/deepseek-v4-flash`, medium reviewer effort and low verification effort,
one main pass/shard, dynamic auxiliary fan-out, ten-minute run budget.
Provider prompt-cache state is uncontrolled. Internal repair/continuation prompts,
failed checks and incomplete sessions count toward time, tokens and quality.
No result is retried or excluded for being slow or incorrect.

Four fixtures are reviewed at immutable Git base/head pairs:

- Existing clean readonly-parameter change; no expected findings.
- Existing defective invoice/credit/refund conversion change; three expected
  double-conversion findings in unchanged consumers.
- New clean multi-hop payment change; both the producer and final consumer
  migrate to cents, preserving the checkout contract.
- New defective multi-hop payment change; `amount` converts dollars to cents,
  which passes through checkout, dispatch, queue, worker and payment before
  `processor` multiplies by 100 again. `checkout(2.50).chargedCents` is 25,000
  instead of 250. The fixture assertion passes on the clean head and fails with
  that exact mismatch on the defective head.

The manifest records all fixture revisions, model settings, source revision,
source-diff hash, seeded schedule and serial execution. Fixtures and raw artifacts
remain under ignored `.jbot-review/jev-experiment-v7/`; `fixtures.py` reproduces
the two new repositories. The complete plan is `guided/plan.json` and results
are `guided/runs/`. Labels are checked against the actual fixture contracts;
this narrow synthetic experiment is not the advisory core corpus or an
independent quality gate.

An earlier adoption pilot at `5cb7531` is retained separately in `runs/`.
Its first two treatment runs used the tool zero times, despite successful live
integration. That motivated the short tool-usage instruction. Four pilot runs
completed before the driver's source-change guard stopped the schedule; the
fourth was already running when the instruction was edited. None of those pilot
rows enter the guided comparison. The new schedule starts from a fresh directory.

## Self-review and deletion pass

Base inspected: `2d8f9239424ba6644dcc36e0d45433eb74640974`. Reviewed branch source,
configuration, packaging, prompt, telemetry and cache seams against AGENTS.md.
The existing full-branch audit is `2026-09-19-tool-reuse-investigation.md`; this
round additionally checks the custom tool, hook lifecycle, internal counter files,
per-prompt deltas, cache identity and fallback behavior. No source bodies, keys,
commands or provider options are copied into the new counter files.

Eight added/moved TypeScript comment blocks across the branch were adjudicated:

| Block                                  | Verdict | Reason                                                     |
| -------------------------------------- | ------- | ---------------------------------------------------------- |
| Optional disk persistence catch        | Keep    | Explains fail-open storage behavior.                       |
| Imports/citations before broad matches | Keep    | Explains scarce collection-slot priority.                  |
| Documentation candidate reservation    | Keep    | Prevents losing the external-contract evidence class.      |
| Unsupported syntax catch               | Keep    | Explains continued text fallback.                          |
| Tracked-source symlink guard           | Keep    | Documents the credential boundary.                         |
| OpenCode per-step usage aggregation    | Keep    | Explains the SDK accounting mismatch.                      |
| Literal shell observation grammar      | Keep    | Explains why general shell parsing/evaluation is excluded. |
| Internal experiment telemetry catch    | Keep    | Keeps instrumentation failures from breaking reviews.      |

Twenty added tests across the branch were adjudicated, all kept for distinct
failure modes. The preceding audit records the sixteen earlier cases. The four
new cases cover checkpoint pressure/runway, composite-tool wiring and guarded
source refresh, hook isolation/counter-only persistence, and preventing duplicate main-turn
accounting when wrap-up fails. Existing timeout, telemetry
and policy-identity cases were extended rather than adding parallel cases.
Existing assertions were preserved. No additional cleanup was justified in this
round; the earlier deletion pass's applied removals remain in place.

## Results and decision

All 36 scheduled reviews finished. There were no process failures; one baseline
verification timed out and failed open. All rows remain in the comparison.

| Metric (12 reviews per arm)          | Baseline | Retrieval | Retrieval + checkpoints |
| ------------------------------------ | -------: | --------: | ----------------------: |
| Median total seconds                 |    19.86 |     20.69 |                   22.02 |
| Mean total seconds                   |    45.42 |     21.64 |                   24.96 |
| P90 total seconds (nearest rank)     |    47.50 |     35.28 |                   47.99 |
| Mean observed tool calls             |    9.75* |      9.92 |                   12.50 |
| Mean observed model turns            |    6.00* |      6.25 |                    7.00 |
| Mean observed input tokens           |  39,369* |    43,575 |                  48,353 |
| Mean reported cost, USD              | Unknown* |   0.01047 |                 0.01178 |
| Composite retrieval calls            |        0 |         0 |                       0 |
| Checkpoints injected                 |        0 |         0 |                       3 |
| Expected defects retained            |   12/12† |     11/12 |                   12/12 |
| Unsupported clean-case P3 advisories |        0 |         2 |                       1 |
| Incomplete verification sessions     |        1 |         0 |                       0 |

\* The baseline timeout took 313.536 seconds, including a 300-second verifier
wait. Before the subsequent accounting fix, hard timeouts lost the interrupted
prompt's token/tool observations. Baseline counts are therefore lower bounds and
mean cost is unknown; the elapsed time is still recorded. The timeout dominates
the baseline mean. It is not evidence that either treatment halved review time.

† Baseline retained eleven confirmed P1 defects and one unverified P3 defect
when verification timed out. Both treatment arms' matched defects were confirmed
P1s. Retrieval missed the multi-hop defect once (trial 24); its fast result must
not count as a quality-preserving improvement. There is no hard exploration cap
in any arm. The three clean-case extras hypothesized undocumented external
callers; verification already marked them unconfirmed and downgraded them to P3.
They are unsupported advisories, not confirmed blocking false positives.

Findings were shuffled and arm-masked before manual contract adjudication.
The investigator also authored fixtures, so this is not independent blind
adjudication. `guided/runs/adjudication.json` records each disposition and reason;
`summary.json` contains aggregate and per-fixture phase measurements. On the
multi-hop clean fixture, treatment main-review exploration averaged 28.54/30.85
seconds versus 20.01 seconds, and extra advisories added verification work.
Neither checkpoint pressure nor tool availability ensured less work.

**Do not graduate either flag.** Median latency and observed turns increased;
retrieval had zero natural adoption, and this small fixture set cannot establish
quality equivalence. Keep both defaults off. An explicit live invocation proved
the tool works, but these runs tested availability and prompting, not the
performance of an adopted composite retrieval path. Further work should first
prove that bounded evidence delivery actually replaces sequential reads, then
compare quality and end-to-end latency on a broader corpus. Jev ranking should
only enter that experiment after the deterministic retrieval path is useful.

## Timeout accounting follow-up

After freezing all comparison results, record partial assistant messages and
experiment counters on prompt-submit failure, wait failure/timeout and provider
error. Make turn recording idempotent so failed wrap-up cannot recount the main
turn. Existing timeout assertions now pin retained tool/token observations; a
separate regression pins the failed-wrap-up case. Do not backfill the frozen
comparison or claim it ran with this subsequent fix.

## Final validation

Validation passed: `npm run format`, `npm run typecheck`, `npm run lint`,
`npm test` (1,088 passed), `npm run build`, and `git diff --check`. Built the
`slim` Docker target as `jbot-review:retrieval-experiment` and successfully
imported `/app/dist/review-retrieval.js` inside the image. No image was published.
Configured credential values were absent from the full branch diff; `.env` stays
ignored with mode 0600.

The built local pipeline reviewed all 40 branch files, including staged changes,
against the recorded base. It exited zero with no incomplete sessions. Local
artifacts are `dogfood/manifest.json`, `reviewed.diff`, `review.json`, `review.log`
and `.jbot-review/telemetry.jsonl` beneath that directory. This observational
run overlapped the Docker build and is not a controlled timing comparison.
Main review took 172.784 seconds; the parallel guideline pass took 114.734
seconds; verification took 51.706 seconds. Across the three sessions: 46 tool
calls, 47 model turns, seven checkpoints, zero composite retrieval calls and
$0.15097 reported cost. One exact repeated tool result represented 298 ms.
This also provides no case for broad tool-result caching as the main speed lever.

Three candidates became two retained P3 findings and one refuted finding:

| Candidate                    | Manual disposition          | Evidence                                                                                                                                                                                                                                                                                        |
| ---------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deletion-line numbering      | Not applied                 | Deleted lines do not advance the new-side cursor. Executing the real helper on a valid delete/context/add hunk yields `[6, 7]`: line 6 marks the deletion boundary and the actual addition is line 7. Advancing for deletions would introduce the claimed offset.                               |
| Separate tool evidence store | Documentation clarified     | The plugin runs in a different process. Its store persists source/index caches across calls; rechecking tracked inventory does not make those caches cold. Runner handoff and persistent-cache options are separate and now explicitly documented. No unmeasured cross-process cache was added. |
| Parsing emitted telemetry    | Refuted by verifier; agreed | Rows are serialized by `JSON.stringify` and the parsed array is used for multiple measurements. The alleged malformed-row trigger was unsupported.                                                                                                                                              |

The shell guardrail has a pre-existing documented limitation: the model wrote
two scratch scripts under `/tmp` during dogfood. No reviewed-workspace changes
were observed. This run does not establish OS-level read-only isolation; the
existing shell policy is an accident filter, as `shell-policy.ts` documents.
No shell-policy change is part of this experiment.

Self-review: no remaining P1/P2 issue found in branch changes. Cut: no further
code removal justified this round. Comments: eight kept, zero rewritten/cut.
Tests: twenty kept, zero new-case folds/cuts; existing timeout coverage extended.
The four current-round cases each pin a separate failure: checkpoint pressure
and spacing; guarded composite retrieval/source refresh; hook isolation and
numeric persistence; duplicate accounting after failed wrap-up. Earlier cases
and removals are adjudicated in the preceding audit. Remaining source changes
after the frozen comparison are only the timeout accounting fix; dogfood used
that fix. Subsequent edits only record results and clarify README cache scope.

Round delta from `4ab30e6`, excluding this audit: +604/-47 lines across 19 files.
No untracked deliverables remain.

No default policy changed. The advisory core corpus (git fixtures,
three repetitions, independent adjudication/rescore) was not run; these synthetic
fixtures do not satisfy that quality gate and no benchmark-ledger pass is claimed.
