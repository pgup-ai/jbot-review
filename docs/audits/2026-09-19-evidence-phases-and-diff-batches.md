# Separating evidence delivery and batching omitted diffs

Continue `codex/jev-evidence-prefetch` after `14c37ba`. The preceding linked
delivery experiment reduced tool calls but increased output bytes; one verifier
returned no `verdicts` array. A malformed model response does not establish a
retrieval implementation failure, and input changes can still affect model output.
This round measures format failures separately from missed or unconfirmed defects.

## Experiments

Revision `ceed7c1` adds two independent, default-off controls:

- `JBOT_READ_EVIDENCE_PHASE=review|verification|all` chooses where the existing
  linked packet is delivered. The default `all` preserves the previous opt-in
  behavior. `review` includes main shards and their retries, excluding auxiliary
  lenses. `verification` selects finding verification, including forked sessions.
  The driver registers labels in its existing temporary session-options file;
  the plugin strips internal labels before applying provider options. No model
  options, verifier prompt or finding disposition policy changes.
- `JBOT_BATCH_DIFF_RECOVERY=1` adds a bounded command plan for small patches
  omitted from the main prompt. It uses the existing omission metadata and safe
  Git diff arguments, exact base/head SHAs and literal path arguments. PR scope
  remains three-dot; local scope remains merge-base to working tree. Each batch
  has at most eight paths and an estimated 8 KiB of output; the plan is at most
  4 KiB and reports unplanned paths. Estimates are not output guarantees, especially
  for path-limited renames. Normal retrieval and truncation recovery remain available.

No Jev call prepares these packets or commands. The deterministic collector is
already sufficient for this selection; adding inference would add work before
there is evidence that it would remove a later review decision.

## Phase protocol

Frozen source and driver revision `ceed7c1`, six existing fixtures, four arms,
three repetitions: 72 reviews in seeded serial order. Same OpenCode route,
`opencode/deepseek-v4-flash`, medium main reasoning, low verifier reasoning,
one review shard, verification enabled. Provider cache state is uncontrolled.
The six fixtures are the clean/defective currency adapters, dependency chain and
webhook receipt contracts from the previous round.

Plans and immutable fixture SHAs are in the ignored directory
`.jbot-review/jev-experiment-v10/phases/`; `quality-contract.json` was written
before starting the runs. Currency roots require confirmed P1; the retry root
accepts confirmed P1/P2. Clean cases should have no findings. Preserve every
scheduled row, with no exclusions, retries or policy tuning during the run.

Compare confirmed roots before latency. Record malformed responses, unverified
retained roots and clean-case noise separately. Compare median total time,
per-case medians, main/verification timing, tools, turns, output bytes, uncached
input, cache-read tokens and reported cost. Verify phase selection from actual
per-session packet counters. Fewer cached tokens alone are not a regression:
fewer requests also consume less cached history.

## Phase results

All 72 processes completed, with no incomplete session, delivery fallback or
phase-routing violation. All 37 finding-verification sessions returned parseable
results: the preceding missing-`verdicts` failure did not recur. This is consistent
with model variability, not proof of its cause or a zero future failure rate.

Sixty retained findings were mapped against the frozen fixture contracts using
arm-masked cards. Live progress and several failures had already been observed;
this was neither independent nor fully blind adjudication.

| Measure                          | Baseline | Main only | Verifier only |    Both |
| -------------------------------- | -------: | --------: | ------------: | ------: |
| Reviews                          |       18 |        18 |            18 |      18 |
| Mean total seconds               |    16.64 |     15.85 |         15.80 |   17.03 |
| Median total seconds             |    11.78 |     15.35 |         14.24 |   17.58 |
| Mean process seconds             |    17.09 |     16.32 |         16.27 |   17.48 |
| Mean tools                       |     9.00 |      8.00 |          9.83 |    8.72 |
| Mean model turns                 |     5.67 |      5.06 |          6.00 |    5.50 |
| Mean tool-output bytes           |    4,156 |     5,085 |         4,823 |   7,081 |
| Mean uncached input tokens       |   41,110 |    41,016 |        39,820 |  44,295 |
| Mean cache-read tokens           |  110,990 |    96,171 |       124,928 | 105,657 |
| Mean reported cost, USD          |  0.00947 |   0.00915 |       0.00969 | 0.00998 |
| Confirmed seeded roots           |    13/15 |     14/15 |         13/15 |   15/15 |
| Findings on clean fixtures       |        2 |         1 |             0 |       2 |
| Unverified clean-case advisories |        2 |         0 |             0 |       1 |
| Delivery packets                 |        0 |        15 |             9 |      29 |
| Added source bytes               |        0 |    26,232 |        14,936 |  48,341 |
| Total preparation milliseconds   |        0 |       569 |           241 |     767 |

The verifier-only arm includes one valid currency root labeled P0 instead of the
preregistered P1 (row 32); its exact severity match is 12/15. The extra severity
does not create another detected root. Clean findings all assume unsupported
external dollar-denominated callers of the internal chain. Main-only row 24 and
both-phases row 51 retained this assumption as P2; baseline rows 09/68 and both
row 43 retained it as explicitly unverified P3. All remain quality failures under
the frozen clean-case contract.

Baseline missed the chain root in row 36 and retry root in row 67. Main-only
missed the retry root in row 46; verifier-only missed that root in rows 41/61.
The verifier-only misses happened before verification was invoked, with zero
main delivery packets, so verifier delivery cannot explain them. No row was
retried or removed. All arms fail at least one preregistered quality criterion.

Main-only reduces total mean tools by 11.1%, but main-review tools themselves
are almost unchanged: 106 baseline versus 105 main-only across 18 reviews.
Main turns fall from 75 to 65; mean main time is nearly flat (11.63 versus
11.43 seconds). Much of the total tool difference is in the unmodified verifier
(56 versus 39 tools), so it cannot all be credited to main delivery. Mean total
time improves 4.7%, while the median worsens 30.3%. A baseline clean-case advisory
takes 68.4 seconds, while two missed defects finish in 6.2/7.6 seconds. This
comparison establishes neither a reliable speedup nor a phase winner.

## Diff-batching protocol

Two new executable contract fixtures put eight small changed quote adapters
behind four large UI-label patches in the real default embedding budget. All
eight adapters are omitted, and the proposed plan groups them into one command.
The defective eighth adapter divides an amount already in cents by 100. The
clean oracle passes all eight cases; the defective oracle fails exactly that
adapter. This is an artificial budget-pressure workload, not a representative
production latency benchmark.

The preregistered plan compares baseline and batching across both fixtures,
three repetitions each: 12 reviews, same provider and serial interleaving,
no linked source delivery. Require the billing root at confirmed P1/P2, no
clean-case findings, and evidence of actual batched reads before interpreting
time differences. Retain every run and report truncation or missing evidence.

Before these runs, revision `c56d831` fixes a measurement gap: canonical commands
with leading Git options were classified as `other-readonly`, not `diff-recovery`.
OpenCode now counts returned diff file headers and multi-file diff responses in
numeric tool/session telemetry. These are not unique-file counts or completeness
proof: repeated files and partial outputs still count. The correction changes
telemetry only, and the 72 earlier phase results retain their original revision.

## Diff-batching results

All 12 reviews completed, with no incomplete session. Both arms retained the
three seeded billing defects as confirmed P1 and had no retained finding on the
three clean runs. All six finding bodies were manually checked against the
executable contract. This is not independent blind adjudication or a corpus gate.

| Measure                    | Baseline | Diff batches |
| -------------------------- | -------: | -----------: |
| Mean total seconds         |    24.36 |        24.51 |
| Median total seconds       |    22.70 |        24.90 |
| Mean process seconds       |    24.74 |        24.88 |
| Mean main-review seconds   |    20.07 |        17.09 |
| Mean verification seconds  |     3.21 |         6.42 |
| Mean tools                 |     8.50 |         9.83 |
| Mean model turns           |     7.83 |         8.00 |
| Mean tool-output bytes     |   49,868 |       27,868 |
| Mean uncached input tokens |   72,320 |       70,644 |
| Mean cache-read tokens     |  282,283 |      271,147 |
| Mean reported cost, USD    |  0.01879 |      0.01833 |
| Confirmed seeded roots     |      3/3 |          3/3 |
| Clean-case findings        |        0 |            0 |
| Multi-file diff responses  |        8 |            8 |

Tool-output bytes fall 44.1%, but uncached input falls only 2.3% and total time
is essentially flat (+0.6% mean, +9.7% median). Both arms already retrieve multiple
patches per response. Main turns are 38 baseline versus 37 treatment across six
reviews, and main tool calls rise from 34 to 37. This does not establish removal
of a repeated sequence of reads. Treatment row 01 returns eight diff headers in
2,918 bytes; baseline row 02 returns nine in 55,607 bytes. Header counts establish
multi-file delivery, not exact command adoption or full-file coverage; progress
logs truncate commands, so they cannot reconstruct every path argument.

The treatment's mean main phase is shorter, but verification is longer. In its
clean row 05, the main reviewer produced a candidate that verification rejected;
the extra work still counts despite the final zero-finding result. None of that
verification behavior was changed by the batch switch. This small comparison
supports reducing delivered text, not claiming an end-to-end speedup.

## Full-branch dogfood

Two local, non-posting reviews covered `2d8f923...c56d831` in the same detached,
clean worktree. The seeded order was baseline then batching; both used the same
frozen source, provider settings and one main shard, with the repository's
guideline session enabled. No linked evidence, Jev selection or other retrieval
treatment was enabled. The driver rejected source changes between runs. Its
telemetry revision carries `-dirty` because the final README/audit were pending
in the driver checkout; the reviewed worktree stayed clean at `c56d831`.

| Measure                    |  Baseline | Diff batches |
| -------------------------- | --------: | -----------: |
| Total seconds              |    206.73 |       289.49 |
| Main execution seconds     |    181.46 |       179.82 |
| Verification seconds       |     24.22 |       108.60 |
| Main tools / turns         |   23 / 24 |      20 / 21 |
| Verification tools / turns |     5 / 5 |      23 / 17 |
| All tools / turns          |   52 / 54 |      57 / 53 |
| All tool-output bytes      |   369,263 |      362,142 |
| Uncached input tokens      |   232,704 |      238,913 |
| Cache-read tokens          | 4,006,912 |    3,426,048 |
| Reported cost, USD         |   0.16164 |      0.14745 |
| Retained P1/P2 findings    |         0 |            0 |
| Retained P3 findings       |         1 |            2 |

Both completed without incomplete sessions or a verifier format failure.
The additional 82.8 seconds came from verification (+84.4 seconds), while main
execution stayed nearly flat. Different candidates caused different verification
work; this single pair cannot attribute that difference to batching or establish
a latency/accuracy effect. The treatment recorded just one exact repeated tool
call, taking 210 milliseconds. Memoizing that call alone cannot explain or remove
the observed delay. Auxiliary-session and provider variability remain uncontrolled.

Manual disposition of retained findings:

- Baseline's prefetch-mode resolver suggestion: not applied. The inline switch
  intentionally prevents duplicate prefetch; README already says exploration
  evidence supersedes the older caller-prefetch arm. Another resolver would add
  indirection without changing behavior.
- Treatment's combined tool-output cap concern: unconfirmed. Our appended packet
  is bounded, but the finding assumes a later OpenCode cap that drops the appended
  content. No such drop was demonstrated. Packet counters measure hook delivery,
  not a guarantee that every byte survives later model-context handling. Retain
  this as a measurement limitation rather than inventing a harness output cap.
- Treatment's missing benchmark disclosure: documented here. No core-corpus run
  was completed in this round, and no PR was opened. The focused fixture tests
  are not a substitute for the advisory core, three-repetition, blind-adjudicated
  quality gate. No default policy was changed or ledger pass claimed.

The verifier also rejected two candidates about wrap-up status and lost metrics.
The code preserves the wrap-up flag and persists numeric telemetry independently
of human-readable console summaries. Neither required a code change.

## Prompt caching

The preceding linked runs already averaged about 86,000 cache-read tokens.
DeepSeek manages prompt caching automatically and reports cache hits and misses;
the application can improve reuse by preserving stable prefixes and avoiding
unnecessary changing context. Cache residency and hits remain best-effort.
Caching does not eliminate response generation or a subsequent tool decision.
See the current [DeepSeek context-cache guide](https://api-docs.deepseek.com/guides/kv_cache/).
This repo also has an independent opt-in shared-prefix prompt experiment; it is
held constant here so phase delivery can be measured without another treatment.
The new runs confirm cache use: the full-branch pair reports 4.01 million and
3.43 million cache-read tokens. Those are repeated tokens served from the cache,
not the size of one prompt. A higher cache-hit percentage is not the objective;
removing requests can reduce both cached tokens and time. Stable prefixes and
smaller necessary context are application responsibilities, while KV-cache
residency and matching are provider responsibilities.

Context7 was consulted for DeepSeek caching and Git path/revision semantics;
the [Git manual](https://git-scm.com/docs/git#Documentation/git.txt---literal-pathspecs)
also confirms literal path handling.
Literal filenames, quoted shell metacharacters, PR scope and uncommitted local
changes were also exercised against the installed Git executable. Reference
responses remain in the ignored experiment directory.

## Decision and next test

Keep both controls off by default. Phase selection did not produce a reliable
quality/latency winner. Diff batching reduced bytes in the artificial stress case
with preserved seeded-defect detection, but did not remove enough decisions to
improve total time. The full-branch pair supports that distinction.

The next useful hypothesis is delivering small omitted patches directly within
a fixed prompt budget, reserving space that is currently consumed by larger
patches. Compare that with the existing command-plan arm: the mechanism must
remove a retrieval turn, preserve the complete missing/truncated-file inventory,
and retain defect detection on both small and large omitted patches. Reusing the
same frozen candidate findings in a separate verifier comparison would help
isolate verifier delivery from discovery variability. Neither is implemented or
claimed as an improvement here.

## Self-review and cleanup

Self-review: no confirmed P1/P2 issues found. Reviewed the complete branch against
the fetched `origin/main`, including source/cache trust boundaries, Jev response
validation, full-diff/shard/retry ownership, prompt budgets, provider options,
forked verifier labels, read-only enforcement and telemetry. No external API
contract or CLI packaging changed in this round.

Cut: no further code deletions justified; the proposed resolver abstraction was
not added. New telemetry assertions were folded into existing cases. Reordered
README experiment instructions so the linked arm stays next to its controls.
Comments: 10 added/modified TypeScript blocks adjudicated — 10 kept, 0 rewritten,
0 cut. Tests: 28 added branch cases adjudicated — 28 kept, 0 folded, 0 cut; four
were added in this round. Each records a distinct failure in the local
adjudication artifacts. Existing test-body edits were reviewed separately.

Net line delta for this round, since `14c37ba`: +803 / -89.
Full branch against `origin/main`: +7080 / -102. No untracked files remain.

Validation: `npm run format`, `npm run typecheck`, `npm run lint`, `npm test`
(1,096 passed, zero failures/skips), `npm run build` and `git diff --check` passed.
The final format check is also recorded with the local validation artifacts.
Focused routing/Git/telemetry tests preceded the 84 fixture reviews and two
full-branch dogfood runs. No Docker build was needed: packaging is unchanged in
this round. A local exact-value scan found zero configured credential matches
in 296 tracked/pending files; `.env` and raw experiment artifacts remain ignored.

Residual risk: one model route, small synthetic workloads, uncontrolled provider
cache state, non-independent adjudication, no core-corpus gate and no proof of
downstream preservation of appended tool bytes. The batching output estimate is
not a hard output bound. These limitations preclude a default-policy change.

## Artifact hashes

Paths below are relative to the gitignored `.jbot-review/jev-experiment-v10/`.
Plans/contracts were frozen before their runs. SHA-256 hashes bind the results
and manual adjudications to those local artifacts; they do not make the
adjudication independent. Source revisions are recorded above and in manifests.

| Artifact                              | SHA-256                                                            |
| ------------------------------------- | ------------------------------------------------------------------ |
| `phases/plan.json`                    | `ce12be5361db3b409ebfb74c0b0daaa44620c69a3fa6dd8be41431548e31ca22` |
| `phases/quality-contract.json`        | `da72e552b141ca4ace9b47f28f7ef794dc3e5269309fa5cf64a8e3ddc9037b66` |
| `phases/runs/manifest.json`           | `8c3ecd7293e7c041d2a6ace39e976abf2d1d087f6735466311c5601b67b9191a` |
| `phases/runs/results.json`            | `81a36e2aa2fe0e5e4f69ded6bb9497763bda94904960e9e4f7ef48b791880978` |
| `phases/runs/adjudication.json`       | `f3769c5f1e6cab5882971e424289b838baf1f70b2d867e951d5b047fff40febd` |
| `phases/runs/quality-summary.json`    | `3bae0a5e2c40ad4d3c1349dc0a24d8ff63128bee938aa897750ce1a7378ec919` |
| `diff-batches/plan.json`              | `2b2667dfe453660ac2eeee8cea5cc80f4c4f5211f0c2bb1fc6765904099fee1e` |
| `diff-batches/quality-contract.json`  | `03e0bcaa17f9f7d83995d9b58eaabe106affba7aeab68765f4c6dbf2c433aea6` |
| `diff-batches/runs/manifest.json`     | `036242f66bbc639018fd3c4be8e5c2a000b77f5b991d8ce7f4284892e1f37030` |
| `diff-batches/runs/results.json`      | `2a9656b1caeb07ac8338392e5c709dadf7dc3efae04b4828d0317550463feecd` |
| `diff-batches/runs/adjudication.json` | `8b6a4a2af30c42e61b57c3023c09451abeb0ef3759ed9d4f498550c4026f1ca9` |
| `diff-batches/runs/mechanism.json`    | `d86c6cd2f36a64d566f91116ecca552a18ac7f926ebceff535c0ba5b59c38578` |
| `dogfood-pair/results.json`           | `98f7ec429a41bd2868019fbcc5e97b29bc0eb07b945e2a9552bc2aeb10b594ea` |
| `dogfood-pair/adjudication.json`      | `b10164ff2d60683fe04940b74acd54b9e3317b3444ea3738c04ac856949d419f` |
| `comment-adjudication.json`           | `fcbb8ccac7922ec4fdf1bae916c035566665411704a1cc11d2dadd6cb18a2d4e` |
| `test-adjudication.json`              | `62969d009a2ac669b0bfcd1d32bdc88f4db915d1cfeb0feeb15ff94849774146` |
