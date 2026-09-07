# Addressed-comment context and prompt measurement

This records the initial addressed-context experiment. PR #205 later expanded
to restore repository investigation; see [the follow-up audit](2026-09-07-review-investigation.md)
for discovery changes and the outstanding full-corpus merge gate.

The addressed-comment check now receives revision scope, the same bounded commit
list and prior threads/replies, and the same diff block it previously received.
It no longer receives finder-only PR prose, linked issues, check summaries, flat
review comments, focus notes, or caller manifests. Missing evidence explicitly
requires leaving a thread open. Main review, guidelines, verification, and
posting rules are unchanged.

## Fixed-case screen

Control was captured from `88a5223`; treatment used this branch's focused context
and clarified evidence instructions. The disposable Git fixture's reviewed head
was `a688ab2eafe2750523e18e255ea536aa75d08d95`. Seven prior threads covered a
fixed null guard, a fixed cross-file authentication check, an unfixed division
by zero, an unfixed empty-list crash with a declined reply, a malformed-JSON bug
falsely claimed fixed in PR prose, an unfixed null trim, and unavailable worker
code. Manual comparison with the fixture establishes two fixed issues and five
threads that must stay open; returned thread IDs were scored against that set.
The full diff includes both the authentication caller and predicate.

Six CommandCode Muse 1.3 contributor calls ran sequentially in control,
treatment, treatment, control, control, treatment order. Every call used a fresh
CLI home, the existing read-only/no-tools configuration, and a 90-second timeout.
No call failed. Both arms found both fixes and made zero false closures in all
three repetitions. This is a seven-case resolution screen, not a finding corpus.

| Arm     | Prompt bytes | Durations (s)       | Median input tokens | Median cache-read tokens |
| ------- | -----------: | ------------------- | ------------------: | -----------------------: |
| Control |       18,030 | 8.943, 9.418, 8.858 |              18,027 |                      241 |
| Focused |        6,422 | 5.927, 7.008, 7.722 |              15,544 |                        0 |

Submitted bytes fell 64.4%, reported input tokens 13.8%, and median call time
21.6%. Provider load and cache state were not controlled. These results support
smaller inputs with preserved resolution accuracy on this fixture; they do not
prove an overall review speedup or improved precision/recall.

A separate OpenCode Muse 1.3 free smoke pair used the same fixture, with repository
tools available and the clarified instructions in both arms. Both returned exactly
the two fixed threads. Prompt bytes fell from 17,559 to 5,801, but elapsed time
increased from 15.046 to 16.063 seconds. Reported input/cache-read tokens were
1,486/31,473 and 291/29,681. One pair establishes neither latency nor cache benefit.

## Measurement contract

OpenCode, Pi, and CommandCode now attach submitted text bytes to reported usage;
repair calls carry their own payload sizes. The existing session row also retains
cache-write tokens. The performance report keeps these measurements tied to each
run and call, while absent prompt sizes stay absent for other backends. Calls without provider
usage retain prompt bytes without inventing token counts.

Byte counts exclude engine-added prompts, tool definitions, and history. Reported
input tokens can cover different turn ranges and cache accounting across backends.
No bytes-to-token conversion or subtraction is labeled engine overhead. This is a
partial TASK-058/062 measurement step, not full engine-context attribution.

## Validation and limits

The initial implementation committed as `7c3346c` passed `npm test` (1,050 tests),
`npm run format`, `npm run typecheck`, `npm run lint`, and `npm run build`. The new context
case checks retained scope, cross-file diff evidence, replies, and omission
notices. Existing tests check independent repair payload sizes and missing metrics.
A local CommandCode Muse 1.3 review completed in 32 seconds with zero findings;
its telemetry and performance report retained prompt bytes and cache-write tokens.
Local mode skips addressed-thread checks, which the separate probes exercised.

The advisory core three-repetition finding benchmark was skipped: it does not
exercise prior-thread resolution. No model, concurrency, or verifier default was
changed. Broader resolution cases and a production re-review remain useful follow-up
validation. Raw probe artifacts are retained outside the repository.

Follow-up self-review also decoupled addressed commit loading from enhanced finder
context. Basic-context runs fetch commits only when prior threads exist; lookup
failure leaves the review running with its existing evidence.
