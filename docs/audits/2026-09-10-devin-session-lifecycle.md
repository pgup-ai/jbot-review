# Devin session lifecycle investigation

## Cause

The attached local run used `devin/swe-2` with verification disabled. Main
executed for 359.3 seconds, guidelines waited 359.3 seconds and executed for
263.4 seconds, and interactions waited 622.7 seconds before getting only
36.7 seconds of execution. It exhausted the five-minute post-main auxiliary
grace, not the overall 30-minute budget.

Commit `c5d9987122c283915bd77eefd640c49cf41902e9` (#152) introduced both
shared Devin state and a one-slot semaphore. The history suggests a shared-state
precaution; it does not establish a CLI requirement for sequential sessions.
Devin also lacked label cancellation, so abandoning an auxiliary result left
its process running until the local driver's forced exit.

## Change

- Give every CLI invocation its own temporary HOME, config, and credential copy
  beneath the backend's auth directory. The existing read deny covers the source
  and every sibling copy. Keep native tools and the repository working directory
  unchanged.
- Reuse the existing CommandCode process lifecycle as `cli-process.ts`.
  Cancel by review label, including recovery launches, and await process cleanup
  before removing credentials during backend teardown.
- Replace Devin's forced serialization with the global session limiter.
  Leave its default of three and auxiliary grace unchanged.
- Retry an unknown-model error once only when the CLI returns an empty model
  catalog, within the original invocation deadline. A populated catalog that
  lacks the requested model remains an error.

## Evidence

Installed CLI: Devin `3000.10.21 (611c1cba)`; model: `devin/swe-2`.

| Experiment                                                           | Result                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Two concurrent focused repository investigations, separate CLI homes | One completed in 90.1 seconds; the other hit the experiment's 180-second timeout. Demonstrates overlap, not reliable completion.                                                                                                                                                 |
| Two concurrent native reads of `package.json`, separate CLI homes    | Both returned the correct package name in 5.2 and 6.3 seconds; total 6.3 seconds.                                                                                                                                                                                                |
| Cancel one real native review, then await backend stop               | One session aborted; stop took 8 ms; no remaining `ProcessWrap` handles.                                                                                                                                                                                                         |
| Three fresh-home model-catalog probes                                | All listed `swe-2`, taking 367–420 ms. The empty-catalog error's underlying cause remains unknown.                                                                                                                                                                               |
| First local pipeline, seven reviewable files                         | Main and guidelines queued for 0 ms. Main took 405.1 seconds, guidelines 282.6 seconds, and verification 195.1 seconds. Interactions failed at startup with an empty catalog. Total 600.2 seconds; correctly reported incomplete coverage and exited without forced termination. |

With the final state layout, two concurrent calls through one backend read
different random markers available only in their respective files (not in the
prompts). Both returned the correct marker, finishing in 5.4 and 6.6 seconds;
total time was 6.6 seconds.

The first pipeline ran before the empty-catalog recovery was added. Its
credential-path finding led to preserving the existing read deny for both the
source auth directory and the per-invocation copy.

A second pipeline used base `884fc22` and the eight-file implementation patch,
with verification enabled. Main and guidelines again queued for zero time;
interactions started after guidelines freed a slot:

| Session      |   Queue | Execution | Outcome                                      |
| ------------ | ------: | --------: | -------------------------------------------- |
| Main         |       0 |   325.2 s | Completed                                    |
| Guidelines   |       0 |   183.5 s | Completed                                    |
| Interactions | 183.5 s |   441.8 s | Cancelled at the five-minute post-main grace |
| Verification |       0 |   108.2 s | Completed                                    |

Total: 733.5 seconds (12m14s), exit code 0, with explicit incomplete coverage.
There was no forced-exit warning or remaining review CLI process. Interactions
passed startup without needing the catalog retry, but still needed more time
than the grace allowed. Queue starvation and cancellation are improved; this
does not demonstrate a full-review latency improvement.

The second review identified the sibling credential-copy gap. Moving session
homes under the shared protected auth directory addressed it after that run;
the final layout is covered by the focused tests and a separate live native
state check. Its escaped-daemon pipe concern was left unmodified: a process
that leaves the process group while retaining stdio could prevent `close`, but
neither the native cancellation check nor the pipeline reproduced that trigger.
The shared helper's existing descendant-pipe regression test still passes.

These are lifecycle and concurrency checks, not a controlled speed comparison:
the original attachment covered 37 files on a different branch with verification
disabled. The first pipeline
used main `884fc22` plus the working changes and base `0c75310`.

## Incomplete-review reporting and Docker follow-up

The [FMS #3751 review](https://github.com/integral-xyz/fms/pull/3751#pullrequestreview-5170033936)
corresponds to Depot job `bw00w06sqn` in workflow `sk45z90v19`. Its log records
zero main findings, zero guideline findings, and no verification call.
Interactions alone exceeded the five-minute post-main grace. No findings were
withheld because that pass failed. An earlier review on the same PR already
published a concern with an unverified disclaimer when verification failed.

The notice now states that main completed and findings from completed passes
are included. It mentions unverified concerns only when finding verification
is incomplete, including the late-verification path. Finding retention,
severity, verification selection, and incomplete-coverage markers are unchanged.
The existing review-body test covers the distinction without another test case.

Docker now pins Devin `3000.10.21` instead of `3000.4.25`, with the matching
installer SHA-256. Both full and slim inherit that pin from the runtime stage.
The missing-CLI installation hint uses the same release and Bash, as required
by the installer. This aligns CI with the tested CLI; it does not establish
that the older release cannot run `swe-2`.

The slim image built for both Linux ARM64 and AMD64. Each image advertised
`swe-2` and passed a live native-file-read check with a random marker omitted
from the prompt. These capability checks took 5.4 seconds on ARM64 and 21.4
seconds on AMD64 under local emulation; they are not comparable performance
benchmarks. The first AMD64 build failed at Debian package signatures, before
the Devin installer, and the retry passed.

## CommandCode model support

CommandCode 1.53.0's changelog adds `deepseek/deepseek-v4.1-flash`.
An authenticated comparison found it absent from 1.44.0 and present in 1.53.0.
The shared Docker runtime now pins 1.53.0, and its catalog snapshot is refreshed.
The J-Bot model value is `commandcode/deepseek/deepseek-v4.1-flash`.

The new model found a seeded arithmetic regression through J-Bot with tools
disabled (2.4 seconds) and enabled (5.3 seconds; one read and one search).
These small compatibility checks do not establish review-quality or speed gains.
The updated slim image built and reports CommandCode 1.53.0 and Devin 3000.10.21.
A tools-enabled local pipeline inside that image completed in seven seconds,
found the seeded bug, and recorded successful list/search calls. The first
attempt supplied only an exhausted key; the rerun used the configured key pool.

## Focused lens follow-up

Devin uses `JBOT_MAX_CONCURRENT_SESSIONS` without a separate provider cap.
At the global default of three, main, guidelines, and interactions can start
concurrently. Higher configured limits are honored but heavy-review throughput
above three has not been tested. Three native file-read sessions
through one backend returned separate hidden markers in 5.8, 6.2, and 6.7 seconds.
That establishes concurrency support, not heavy-review throughput.

Lenses retain the complete diff and changed-symbol guidance, but no longer receive
the general review checklists. They omit explicitly titled development-procedure
sections from guidelines, with a bounded disclosure. Unknown headings, nested
sections, code examples, domain rules, and existing larger tool-less budgets are
retained. Main/compliance retain the procedure guidance. Generated
`.jbot-review/last-run.md` reports are excluded from discovery, including aliases.
The lens prompt encourages batching independent reads without guessing dependent
lookup inputs or limiting investigation depth.

For this checkout, lens guidelines shrink from 22,144 to 18,825 bytes. Removing
1,819 bytes of general checklists and adding 309 bytes of batching guidance gives
a net reduction of 4,829 bytes with the diff unchanged.

A paired `devin/swe-2` probe compared commit `d621bf4` with this treatment on the
same seeded producer/consumer field rename. Both found the P1 break in the
unchanged caller and cited its location. Prompts were 16,200 versus 10,703 bytes;
elapsed times were 7.5 versus 12.5 seconds. The smaller prompt was slower in this
single pair; it does not establish a latency improvement or satisfy the corpus.

The two added regression cases cover generated-report rediscovery (including a
symlink alias) and conservative section selection with fenced/nested domain
rules and the tool-less budget fallback. Existing routing and prompt checks
remain intact. Self-review keeps the one-line explanation for retaining unknown
and nested sections; no other new code comments were needed for this follow-up.

## Validation limits

The full unit suite passes. Typecheck, lint, formatting, and build
pass. Regression coverage checks independent homes, credential permissions,
label cancellation, remaining-session teardown, descendant pipe cleanup, and
the distinction between empty catalogs and unsupported models.

The full, adjudicated quality corpus has not run. Enabling concurrent Devin
sessions changes the default, so the repository's full-corpus merge gate remains
outstanding; these live checks do not satisfy it. The lens follow-up changes prompts, but severity policy, verification
selection, and full-diff scope remain unchanged.

The initial lifecycle self-review traced provider limiting, all Devin prompt methods and recovery
launches, credential cleanup, and the unchanged CommandCode callers. Cleanup
rewrote one five-line comment to two lines (0 kept, 1 rewritten, 0 cut) and kept
two new regression cases (2 kept, 0 folded, 0 cut). They distinguish session
state/cancellation failures from catalog-retry failures. Existing process tests
were renamed with their implementation, with no assertions removed.

## Review feedback validation

Fatal-signal shutdown now awaits CLI process teardown before removing session
and parent credential homes. A subprocess regression sends SIGTERM to the driver,
checks that the CLI can still see its HOME during termination, then confirms the
CLI is gone and the credentials have been removed. Continuation and JSON repair
share the original review deadline; a deterministic clock advance verifies
neither recovery launches after that deadline expires.

The concurrent-session test uses a 60-second prompt deadline while retaining its
five-second readiness bound. The shared Markdown parser recognizes indented ATX
headings and closing hashes; the existing lens test covers these forms while
retaining nested and fenced contract evidence. CommandCode's refreshed catalog
section has its own date because the other provider snapshots were not refreshed.

Self-review kept the async-cleanup rationale comment and both new regression
cases: they detect distinct fatal-teardown and deadline-reset failures. Markdown
coverage was folded into the existing lens case. No extra provider cap, repair
time cap, or finding-disposition change was introduced. The full adjudicated
corpus remains outstanding. The hosted app's static model catalog requires a
separate repository update and deployment.

## Incomplete auxiliary responses

The local Devin run returned narration from guideline-compliance, but permissive
parsing converted it to zero findings and recorded completed coverage. Guideline
and addressed-thread responses now require their respective result arrays via
the existing strict parser. Malformed replies reach the runner's existing
fail-open handlers, which record incomplete coverage and retain completed
findings. Explicit empty arrays remain valid.

One regression case exercises both methods with narration, non-object JSON,
missing arrays, and explicit empty results. Self-review kept this case because
it catches the observed false-success path; no new comments, retries, prompts,
or deadlines were added. The full suite, typecheck, lint, and build pass.
A new live model run was not used for this deterministic parsing fix; the
previously documented full-corpus merge gate remains outstanding.

## Shutdown follow-up

Fatal shutdown allows five seconds for graceful CLI cleanup, then re-raises the
signal even if an escaped descendant keeps pipes open. A repeated fatal signal
forces termination immediately. Normal cleanup preserves host-owned signal
listeners; forced termination overrides them. A forced exit can leave temporary
homes or escaped descendants for the disposable environment to reclaim.

All CLI-home cleanup paths now stop the managed backends first, including setup
failures, so Devin's signal registration is released before credentials are
removed. One subprocess regression covers stuck cleanup, repeated signals, and
the surviving-host-listener path. Self-review kept the one-line rationale and
this regression; the existing deadline test remains deterministic and restores
its clock override. Full-suite totals are reported only in the PR update to avoid
conflicting counts as coverage grows. No model prompts or defaults changed in
this follow-up; the previously documented corpus gate remains pending.

## Current Devin catalog error format

Devin 3000.10.21 can report an empty catalog through
`session/set_config_option (model) failed: Resource not found`, with a JSON
`uri` containing `Model not found: swe-2-high. Available models: `.
The startup retry now recognizes this form as well as the older `Unknown model`
message. Both require an empty available-model list, retry only once, and use
the remaining invocation deadline. Nonempty catalogs still fail immediately.

The existing regression now covers both formats, repeated empty catalogs, real
unsupported models, and the observed empty-main → continuation-error → recovered
result sequence. Three concurrent live `devin/swe-2` probes on the pinned CLI
correctly read distinct random file contents in 6.8, 7.1, and 6.1 seconds.
These smoke tests did not reproduce the transient error and do not establish
full-review reliability or explain the original empty response. No fresh full
review or adjudicated corpus was run for this classification fix.

## Medium default and local-review follow-up

J-Bot resolves the unqualified `devin/swe-2` and `devin/swe` aliases to
`devin/swe-2-medium` before pool selection, so all entry points and telemetry
report the effective variant. Explicit High/Max IDs and `devin/default` are
preserved. Three concurrent Medium file-read probes succeeded in 5.2, 5.4,
and 5.6 seconds; the earlier High probes took 6.8, 7.1, and 6.1 seconds.
These small, sequentially conducted probe sets do not establish full-review
speed or quality, and the default-policy full-corpus requirement remains unmet.

The attached local run finished main and guideline passes, retained four
findings, and timed out only interactions at ten minutes. Its valid feedback
led to separate once-only onboarding/catalog retries within the same deadline,
a capability-aware omission note for tool-less lenses, and removal of dead
imports in the signal test's generated script. The complete diff and existing
context budgets remain intact.

The PR's repeated-signal regression now exits with a distinct failure code
after one second if the second signal is ignored; a later five-second forced
exit cannot make the test pass. Self-review kept two new cases for model
resolution and mixed startup recovery, and extended existing context/signal
cases. No new comments or abstractions were needed.
