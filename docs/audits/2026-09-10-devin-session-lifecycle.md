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
- Replace Devin's forced serialization with the shared provider limiter at two
  concurrent sessions. Leave global concurrency and auxiliary grace unchanged.
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

## Validation limits

The full unit suite passes: 1,027 tests. Typecheck, lint, formatting, and build
pass. Regression coverage checks independent homes, credential permissions,
label cancellation, remaining-session teardown, descendant pipe cleanup, and
the distinction between empty catalogs and unsupported models.

The full, adjudicated quality corpus has not run. Enabling concurrent Devin
sessions changes the default, so the repository's full-corpus merge gate remains
outstanding; these live checks do not satisfy it. No prompt, severity policy,
verification selection, or review-scope change is included.

Self-review traced provider limiting, all Devin prompt methods and recovery
launches, credential cleanup, and the unchanged CommandCode callers. Cleanup
rewrote one five-line comment to two lines (0 kept, 1 rewritten, 0 cut) and kept
two new regression cases (2 kept, 0 folded, 0 cut). They distinguish session
state/cancellation failures from catalog-retry failures. Existing process tests
were renamed with their implementation, with no assertions removed.
