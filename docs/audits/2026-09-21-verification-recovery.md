# Bounded OpenCode verification recovery

Recovery uses the current verifier model and settings. There is no separate
model configuration or automatic paid fallback. The native verifier keeps its
tools; recovery forks its history, denies tools, and gets one attempt to finish
incomplete verdicts. Completed judgments cannot be overwritten. Missing evidence
must remain uncertain, and recovery failure preserves existing verdicts.

A five-minute verification budget reserves the last minute for recovery. Early
format repair uses at most that minute too. Unbounded runs skip recovery.
OpenCode free models also skip recovery and retain their investigation budget:
MiMo Free and Muse Contributor Free reject jbot's tool-less request setup.
Auth, usage-limit and provider errors do not trigger recovery. Pi and CLI
verifiers are unchanged.

## Local evidence

Tested with OpenCode CLI/SDK 2.0.5 at low effort. The fixture contains two seeded
bugs (100x overcharge and owner/tenant confusion) and a false claim that an audit
call is absent.

| Test                                                          | Result                                                                                                                                           |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| MiMo Free native verification                                 | 16.3s; both bugs confirmed and false claim refuted; no recovery                                                                                  |
| MiMo Free tool-less request                                   | Rejected with `OpenCode's free tier can only be used from within OpenCode`                                                                       |
| MiMo Go verification with a five-second injected wait timeout | 8.5s total; same-model recovery took 3.4s, returned two uncertain verdicts for missing evidence and refuted the false claim; zero recovery tools |

A full local pipeline rerun delivered both assigned hunks and found both seeded
bugs, but MiMo Free returned unusable verification output. Both candidates
remained unverified; no recovery or paid fallback was attempted. This reproduces
the remaining production limitation rather than validating a fix for it.

The timeout test shortened the SDK wait to five seconds against a live native
session. Production code then interrupted that session and forked it for
recovery. This tests the interruption/recovery path without waiting five minutes;
it is not a production latency comparison. An explicit external cancellation
returned `Step interrupted` and did not trigger recovery.

Earlier experiments switched from MiMo Free to paid MiMo Go for recovery and
succeeded, including a full local pipeline run. That model-switching design was
removed; those results do not establish recovery support for MiMo Free.

All 1,118 tests passed, along with typecheck, lint and build. The retained recovery
tests cover history and permission handling, unchanged model identity, preserved
judgments, timeout recovery, recovery failure, unsupported free models, unbounded
runs and usage-limit errors. The model-selection test was removed with its code.

The quality corpus was not run, as previously requested. These targeted checks
do not establish general recall or precision. MiMo Free recovery remains unsolved.
Local results are under `.jbot-review/mimo-verification/` in
`same-model-normal`, `same-model-free-repair` and `same-paid-model-timeout`.
