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
