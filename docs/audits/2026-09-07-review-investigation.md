# Restore repository investigation

PR #205 now includes a selective rollback of discovery restrictions alongside
its addressed-context and prompt-measurement work. It keeps inspected cross-file
citations, verification source excerpts, fail-open verdict handling, severity
filtering, and read-only enforcement.

## Changes

Discovery prompts encourage following callers, defaults, tests, and dependencies
as far as needed. Material unknowns can become explicitly conditional investigate
advisories; unavailable code is not proof of a defect. Pi no longer stops reads
based on call counts, output totals, distinct files, repeats, or recovery quotas.
Its obsolete exploration planner and tests are removed.

Pi's old `read_file` returned only the first 48 KiB, with no offset or search.
It now accepts a starting line or continuation offset. Repository search finds
literal text in tracked files; search, read, and diff responses use UTF-8-safe
128 KiB pages. Repository confinement, disabled built-ins, session deadlines,
and per-command process limits remain. Model context windows come from the
provider catalog rather than the response-page size. The installed Pi catalog
reports 1,048,576 tokens for the Muse 1.2 model used below.

OpenCode retains its existing repository tools. CommandCode remains in its
read-only, no-tools mode; enabling its tools is separate work.

## Paired evidence-access screen

Twelve sequential calls used `opencode/muse-spark-1.2-contributor-free` through
Pi, medium thinking, embedded-first prompts, fresh sessions, and 180-second
limits. Control was `e3e44a4`; treatment was the uncommitted rollback/tools change.
Each arm ran three repetitions on a defect and its clean counterfactual, with
arm order alternating between repetitions. No call failed.

Both fixtures change `policy(user, false)` to `policy(user, true)` in `canDelete`.
The unchanged helper appears after 14,000 lines in a roughly 574 KB file. In the
defect it bypasses an admin check; in the clean version the boolean does not
change authorization. The visible diff alone cannot distinguish them.

| Observation                                   | Control  | Treatment |
| --------------------------------------------- | -------- | --------- |
| Defect calls inspecting and citing the helper | 0/3      | 3/3       |
| Clean calls returning no findings             | 1/3      | 3/3       |
| Median call time                              | 45.950 s | 14.231 s  |

Control still reported the defect in all repetitions, but explicitly admitted
it could not inspect the helper and speculated about the boolean's meaning.
Its clean-case flags were one P1 and one P2 investigate advisory. Treatment
inspected the helper and separated both cases, but labeled all three defects
P0; the fixture does not establish P0 urgency. This is evidence-access validation,
not a passed precision/recall or severity-calibration benchmark.

Both arms called the Pi driver directly without the runner's exploration plan.
The comparison therefore covers prompt and tool access together, not the effect
of removing main-session quotas, nor PR #202 in isolation. It does not exercise
verification or final publication. Raw results remain in the ignored local
`.jbot-review/rollback-probe` directory.

## Validation and remaining gate

The first local full-pipeline review found inconsistent quota handling between
search and reads and incomplete quota recovery across diff pages. Removing the
quota machinery addressed both. A subsequent Muse 1.2 Pi review completed with
zero findings; this does not establish recall. The implementation committed as `e939df2` passed `npm test` (1,018 tests),
`npm run format`, `npm run typecheck`, `npm run lint`, `npm run build`, and
`git diff --check`.
Functional tests cover paging, late-file evidence, literal search, and refusing
outside-repository symlinks.

The full three-repetition corpus and blind adjudication have not run. Because
this changes default investigation policy, the full corpus merge gate remains
outstanding. The paired screen and clean dogfood do not substitute for it.

## Auxiliary completion follow-up (`ce45a38`)

Auxiliary passes now get up to ten minutes after main review, bounded by the
remaining run budget with 30 seconds reserved for posting and five minutes for
enabled verification. Each lens settles independently, retaining completed
findings when another lens expires. Failed or abandoned coverage is visible in
reports and prevents clean reactions and automatic approval, including reruns.

CommandCode cancellation now reaches its session's process group and awaits
stdio closure before deleting its temporary home. Escalation continues when the
parent exits but descendants retain the pipes. The ten-second last-resort exit
watchdog remains unchanged. Models, routing, tool permissions, and concurrency
defaults are unchanged.

`npm test` passed 1,022 tests on the implementation committed as `ce45a38`;
`npm run format`, `npm run typecheck`, `npm run lint`, `npm run build`, and
`git diff --check` passed. Real subprocess tests cover descendant-held pipes,
independent concurrent sessions, timeout cleanup, and cancellation before spawn.
The process-group test runs on POSIX; Windows retains single-process signalling.
Node 24.15.0 and CommandCode 1.44.0 were installed for these checks.

### Completed runtime screens

A local run at HEAD `e939df2` with uncommitted grace/cancellation changes used
this command (credentials came from the existing local environment):

```sh
PROVIDER='' MODEL='opencode/muse-spark-1.2-contributor-free,commandcode/meituan/longcat-2.0:free' JBOT_SDK_ENGINE=auto JBOT_REVIEW_PASSES=2 JBOT_TIME_BUDGET_MINUTES=30 JBOT_MAX_CONCURRENT_SESSIONS=5 JBOT_CONTEXT_TRIM=true npm run review:local -- --base origin/main
```

Routing confirmed Pi Muse 1.2 for main and CommandCode LongCat 2.0 free for
auxiliary work, matching the earlier GitHub run's pairing. The run completed in
8m 9s: main and interaction lens returned zero findings; the guideline pass
returned the already-known missing full-corpus benchmark. Both auxiliary passes
completed, with no forced-exit warning. Verification was disabled by the local
`.env`. The two new process-lifecycle files were executed but still untracked
when this screen captured its review diff. This is a runtime completion screen,
not an identical-input comparison with GitHub run `34152657823`. Per-session
telemetry was overwritten by a concurrent test fixture, so only the captured
log's whole-run duration and outcomes are reported. An earlier misrouted local
launch is excluded.

After including the new files, a separate Pi-only three-pass run finished in
2m 3s. It reported two false positives: an undefined timeout allegedly reaching
`setTimeout`, and an abort allegedly interleaving between the synchronous check
and listener registration. `runCommandCodePrompt` supplies a 20-minute default
before spawning; the signal belongs to the same event loop, with no yield in
that interval. Neither proposed defensive check was added.

A subsequent run explicitly enabled verification, with the same single Muse 1.2
model, three review passes, a 15-minute budget, context trimming, and concurrency
five. All passes completed: main 45.100s, integrity 60.140s, interactions 78.818s,
guidelines 101.286s; verification took 18.341s and teardown 1ms. Whole-run time
was 2m 0s. Both false positives survived verification. Pi verification currently
uses a tool-less session; this suggests investigating verifier evidence access
before increasing concurrency, but does not establish the cause by itself.
These runs reviewed the working tree committed as `ce45a38`, apart from a removed
comment. Captured logs/results remain outside the repository under
`/tmp/jbot-grace-*`.

The full corpus gate above remains outstanding. These screens establish runtime
completion and expose a precision concern; they do not demonstrate improved
precision or recall. The separate review comment about searches exceeding the
64 MiB subprocess buffer is also still open; this batch does not change Pi output
collection.
