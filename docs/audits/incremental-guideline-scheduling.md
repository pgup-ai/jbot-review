# Incremental guideline checks and finder scheduling

This change gives finder preparation priority over summaries and addressed-thread
checks, and reuses completed guideline checks on eligible incremental follow-ups.
It adds no Action inputs or production flags.

## Behavior

Bookkeeping enters the existing session limiter after enabled finder pages have
been submitted, or their preparation has failed. It does not wait for finder
results. Existing priorities, fairness, global concurrency and provider caps remain
in effect. Deferred bookkeeping cannot start after run teardown.

Guideline checks on follow-ups depend on applicable rules and completed coverage,
not just diff size. An enabled pass remains eligible even for a small follow-up.
Reuse requires the same base and policy, a completed guideline baseline matching
the incremental main baseline, and complete global guidance delivered in main.
Scoped rules matching affected files, including selected callers, retain the pass.
Unknown scopes, omitted or truncated guidance, changed policy and missing baselines
also retain it. The first-review fan-out policy is unchanged.

Only explicit supported path scopes can be excluded. This does not infer relevance
from arbitrary guideline prose or add another rules configuration file. Main still
receives every selected file's complete base...head patch; verification is unchanged.
When guidelines share an interactions session, reuse need not remove a whole session.
Logs record the scheduling decision, reason and reused head.

## Local evidence

The initial development comparison used native OpenCode with
`opencode/muse-spark-1.3-contributor-free`, low reasoning, a three-minute run budget,
two configured passes, dynamic fan-out, verification and concurrency three. The
fixture contained eight utility files, a global payment invariant and a scoped
batching rule. Both arms used the same incremental diff. The control omitted the
previous guideline completion marker; treatment retained it.

| Follow-up                | Control | Treatment | Outcome                                   |
| ------------------------ | ------: | --------: | ----------------------------------------- |
| Clean display-label edit |  9.805s |    4.769s | Both complete, no findings                |
| Negative-payment defect  | 15.918s |    8.288s | Both complete, same P1 found and verified |

These are single pairs from a development worktree, before the final conservative
fallback refinements. They are not a production speed estimate or a final-version
quality gate. The original full baseline completed in 22.717s.

The scoped batching case correctly ran its dedicated check and main delivered both
hunks. Main found the seeded P1, but auxiliary work and verification did not finish;
the candidate was withheld. Its 150.077s result is incomplete, not a quality pass.

Final-version repeats with free Muse (`1fb4a55`) and free MiMo
(`opencode/mimo-v2.6-flash-free`, `3437a30`) failed to finish their full baselines
within the main review budget. Neither comparison matrix completed. A direct
native Muse smoke test bypassing the modified runner, with a one-line diff and no
guidelines, also timed out after 30 seconds. These failures do not establish a
specific provider cause, but they leave final-version live quality and latency
unverified.

A deterministic replay against `3437a30` used the successful treatment's actual
review metadata, committed another display-label edit, and ran the Git-backed
incremental and reuse planners. It selected one of eight files, advanced the
baseline and returned `global-guidelines-in-main` again.

Local artifacts (gitignored): `.jbot-review/guideline-scheduling/`, including
`results/`, `final/`, `mimo/`, `chain-replay.json` and `native-smoke.log`.

## Validation and remaining limits

Unit tests cover matching baseline requirements, scoped and unknown rules,
truncation and byte budgets, small follow-up eligibility, queue ordering while
finders are still running, and release after failed or abandoned preparation.
The full suite has 1,127 passing tests. Typecheck, lint, formatting and build pass.

The full quality corpus remains deferred per the earlier user instruction; no
passing corpus ledger row is claimed. The PR stays draft because the final live
comparison did not complete. Before promoting the default policy, repeat the
matched cases with a responsive model and assess scoped-rule recall.

Self-review found and fixed small-follow-up suppression after an incomplete
baseline and deferred bookkeeping launching after teardown. No remaining P1/P2
issue was found in static review. The cleanup cut an obsolete comment and reduced
a six-line comment to one line. Both added test cases were retained: one prevents
unsafe guideline reuse, the other catches queue ordering and preparation deadlocks.
