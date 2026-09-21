# Auxiliary scheduling within the run budget

PR [#228](https://github.com/pgup-ai/jbot-review/pull/228). This correction supersedes
the one-minute auxiliary cutoff in the earlier latency experiments.

## Change

Main completion no longer cancels queued auxiliary pages or starts a fixed
one-minute abort timer. Remaining auxiliary work uses the same finder deadline
as main review, with verification and posting time reserved. A zero run budget
means no post-main cutoff. Completed findings survive deadline/provider failures;
incomplete coverage stays explicit and unresolved candidates stay unpublished.

The existing concurrency cap remains in force. Main work cannot starve the first
auxiliary page; auxiliary pass groups rotate. At caps above one, auxiliary work
leaves a slot for main/early verification. Verification outranks finder requests.
After main and early verification settle, that reservation is released at both
the global and provider queues so remaining pages can use the full cap. Serial
providers alternate main/auxiliary work and give verification the next slot;
an active call is not preempted.

No new user-facing flag, provider default, prompt, evidence budget, or publication
rule is introduced. Existing queue/execution, page coverage, and finding telemetry
remain available. Logs also show the remaining auxiliary budget and release of
reserved capacity.

## Local validation

| Measurement                                          |   Control | Corrected |
| ---------------------------------------------------- | --------: | --------: |
| Total seconds                                        |   395.695 |   543.164 |
| Main seconds                                         |   337.056 |   439.332 |
| Post-main auxiliary wait seconds                     |    51.634 |    97.331 |
| Main hunks delivered                                 |   417/417 |   417/417 |
| Main pages completed                                 |     59/59 |     59/59 |
| Auxiliary pages completed                            |      6/44 |     44/44 |
| Main pages completed before first auxiliary dispatch |        55 |         1 |
| Verification queue milliseconds                      |     2,296 |         0 |
| Observed peak simultaneous prompts                   |         5 |         5 |
| Main prompt bytes                                    | 4,430,924 | 4,408,223 |
| Estimated cost USD                                   |  0.160029 |  0.233442 |

Completing 38 additional auxiliary pages took another **147.469 seconds** and
an estimated **$0.073413** in this pair. Main review also took longer while
sharing capacity with auxiliary work. This restores coverage; it is not a
wall-clock speedup over cancelling work. No pages failed in the corrected run.
The remaining post-main wait exceeded one minute and still completed normally.

[Measured results and hashes](data/2026-09-20-budget-aware-scheduling.json).

On the final `7b01d02` runtime, free Cline Muse reviewed the seven-file scheduling
increment in **104.424 seconds**, completing **25/25 hunks**, the interaction pass,
and the joint guideline pass, with no findings. The same free model found and
verified the known P1 job-loss fixture in **18.228 seconds**. The exact hosted
`cline/deepseek/deepseek-v4-flash` route also found and verified that fixture in
**30.966 seconds**, within a two-minute test budget. Those small-fixture successes
do not explain or rule out the earlier hosted large-prompt timeout. Cline token
usage and cost telemetry are unavailable.

Both large-input runs use the same frozen `b251904` checkout and base `2d8f923`.
The control runtime is `b251904`; the corrected runtime is `7b01d02`.
They use CommandCode 1.56.2 with `commandcode/meta/muse-spark-1.3-contributor`,
`diff-batches`, two requested passes, dynamic fanout, a five-session cap,
30-minute budget, medium finder effort and low verifier effort. Repository tools
remain disabled for this backend; all mandatory hunks are embedded.

These are local dry runs with no GitHub posting. The control ran first. An initial
treatment at `82419b6` was intentionally interrupted to return the reserved slot
when early verification finishes; it is excluded from the completed comparison.
Cache state and model variability are uncontrolled. Prepared caller evidence
differed on five main pages (22,701 fewer bytes in treatment), so the assembled
prompts were not identical even though the frozen diff and mandatory coverage
were. Free Cline checks, a small DeepSeek probe, and local deterministic checks
overlapped parts of this experiment. This is a
coverage/scheduling validation, not a statistically reliable latency or recall
benchmark. `posted-inline` in local telemetry means publication eligibility,
not an actual posted comment.

Manual adjudication found no actionable retained defect in the frozen large
input. Both arms wrongly confirmed that `symbolPattern` needs to escape arbitrary
regex syntax: its current callers supply lexical declaration/export identifiers,
not qualified expressions such as `foo.bar`. The control's missing-title crash
claim misses validation in `parseFindingVerdicts`. Withheld zero-cap claims miss
option normalization and the semaphore's zero semantics; the treatment's withheld
file-header claim misses hunk-only patches from the input boundary. These are
unblinded judgments, not a precision/recall benchmark. Scheduling does not fix
verifier precision; no findings from these local trials were posted.

## Self-review and de-slop

The repository self-review and de-slop skills were applied. Reviewed global and
provider queues, the serialized backend, cancellation/slot ownership, disabled
verification/overlap, unlimited run budgets, and main/auxiliary coverage and
publication boundaries. No new P1/P2 issue remains in this increment.

- Removed the fixed-grace constant, obsolete queue-closing API/state, and its
  one-use helper. Existing abort/deadline handling remains.
- Consolidated README scheduling guidance behind one cross-reference.
- Comments: three blocks adjudicated; one retained for the serial-provider
  reservation exception and two obsolete blocks removed.
- Tests: three new cases retained for cross-queue verifier access, finder
  starvation/reserved capacity, and serial fairness. Two existing cases were
  renamed to assert the corrected contracts. Unlimited-wait and capacity-release
  assertions extend existing cases. Removed only assertions for the deleted
  queue-closing API.
- Code/documentation delta before this audit: +230/-115 lines across seven files.
- 1,122 tests, typecheck, lint, formatting, bundle build and diff checks pass.
  No CLI packaging changed, so no new Docker image build was needed.

The full-corpus default-policy merge gate remains unmet; the advisory core corpus
was not rerun. These local checks do not establish unchanged recall or qualify
all experiments in this branch for production. Hosted behavior must still be
checked on the resulting run.
