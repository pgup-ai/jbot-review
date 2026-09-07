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

## Evidence access and cancellation (`e160ecc`)

The 80 KiB threshold was an optional attention experiment, not a model context
limit. In [run 34155441989](https://github.com/pgup-ai/jbot-review/actions/runs/34155441989),
the embedded full diff alone exceeded it, causing scope, focus and caller hints
to be dropped without reaching the threshold. Those blocks now survive; only
prior-thread hints remain optional. Per-block budgets still apply.

The changes-since summary's separate 8 KiB prefix cap caused the reported
164,468-byte omission. Its cap is now 256 KiB, with a bounded file overview and
an explicitly summary-only omission label. A regression test covers a later file
in a roughly 176 KiB delta; larger deltas still disclose partial summary evidence.
The full main-review diff remains independent of this summary.

Pi and tool-capable OpenCode verifiers now use the investigative prompt and their
existing read-only tools. Pi's file, search and diff output streams into 128 KiB
continuation pages; it no longer fails before paging at 64 MiB. The large-output
test reads search results beyond an 80 MiB offset. Continuations have no aggregate
output or call-count quota; per-command and session deadlines remain.

Queued cancellation now removes either provider or global semaphore waiters
before they can start the backend. Time-budget policy moved out of the runner.
Windows cancellation uses `taskkill /PID … /T /F` and awaits its completion plus
child pipe closure; POSIX retains process-group TERM/KILL escalation. The shared
subprocess test no longer skips Windows, but this work was validated on macOS;
native Windows execution remains unverified. Contracts were checked against
[Node 24 child processes](https://nodejs.org/docs/latest-v24.x/api/child_process.html)
and [Microsoft taskkill](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/taskkill).

Validation: 1,023 tests passed, plus formatting, typecheck, lint, build and diff
checks. Self-review removed unused drop priorities and a redundant timeout
calculation. Across the branch, 113 comment blocks were adjudicated: 3 kept,
7 rewritten and 103 cut; 11 new tests retained for distinct regressions, with
37 obsolete cases removed. Existing tests were extended for verifier permissions,
large search output, protected context and the expanded summary budget.

### Pinned main-configuration screen

Twelve sequential full-pipeline calls ran at `e160ecc` with no source edits during
the screen: two configurations × defect/clean pair × three repetitions, in a
fixed shuffled order. Each invocation used a fresh session, one main pass,
one shard, medium requested reasoning, no verification, no prompt cache,
context trimming enabled, and a 20-minute budget. Telemetry confirms main was
the only model session. Inputs contained neither reviewer answers nor expected
outcomes. A preliminary run during implementation is excluded.

Both fixtures remove the same timeout fallback from `review.ts`; only the
unchanged `process.ts` differs. Its default is zero in the defect and twenty
minutes in the clean counterfactual. The changed diff cannot distinguish them.

| Observation                          | Pi / Muse 1.2 contributor | CommandCode / Muse 1.3 contributor |
| ------------------------------------ | ------------------------- | ---------------------------------- |
| Defect returned as a grounded P1 bug | 3/3                       | 0/3                                |
| Clean case returned no findings      | 3/3                       | 0/3                                |
| Unresolved investigate advisory      | 0/6                       | 6/6                                |
| Repository tool calls per run        | 4–9                       | 0                                  |
| Median wall time                     | 23.025 s                  | 23.030 s                           |

Pi cited the actual helper default; CommandCode explicitly said it needed to
check the unavailable helper. The latter's conditional advisories are not
false factual claims, but they do not distinguish a harmless cleanup from a
real defect. This compares the complete configurations, including different
models and tooling; it cannot attribute the difference to tools alone or
establish a model ranking. No routing or concurrency default was changed.
Raw manifests, logs and telemetry remain at `/tmp/jbot-quality-screen-pinned`.

This is one targeted counterfactual pair, not the required full corpus or its
blind adjudication/rescore. The full three-repetition merge gate remains open;
this PR must not be called merge-ready based on these screens.

### Live verifier contract checks

Four direct verifier sessions used the same Muse 1.2 contributor model and
identical candidate finding on the defect/clean pair: one pair through Pi and
one through OpenCode. Both refuted the clean case by reading the helper's
20-minute default and confirmed the zero-default regression. Telemetry records
two successful file reads in every session (three tools per Pi session and
three/four through OpenCode). This confirms actual evidence access and verdict
behavior in both installed backends, not just an enabled flag. It is a contract
smoke, not a repeated verifier-quality comparison. Results remain at
`/tmp/jbot-quality-verifiers`.

### Whole-branch dogfood

The final local review used `e160ecc` plus the audit update, Pi Muse 1.2
contributor, medium effort, three passes, verification enabled, one shard,
context trimming, a twenty-minute budget and concurrency five. It completed in
260.929 seconds with all enabled passes finishing, 1 ms teardown, and no forced
exit. The verifier made 23 successful repository calls and refuted two of four
blocking candidates, retaining the known full-corpus gate and one false positive.

The retained P2 claimed removal of the timeout floor introduced negative values
for a 0.4-minute budget. It did not: for window `w`,
`max(w, min(60000, w))` is exactly `w`. Both revisions return −6000 for that input;
the simplification changed no behavior. This is not a newly introduced defect,
so no defensive clamp was added. The gate finding came from already-present
audit guidance, not independent defect discovery. Main and the interactions
lens returned no findings; the integrity lens produced the timeout false positive.

This run confirms repository investigation and completion, while showing that
a verifier with tools can still make a reasoning error. It does not establish
an overall precision improvement. Captured output and telemetry remain at
`/tmp/jbot-quality-dogfood`. No routing/default-model changes were made on the
strength of these limited results.

## Verification coverage and uncertainty (`7380761`)

The previous implementation selected at most ten P0/P1/P2 findings. P3 and nits
bypassed verification. The updated pipeline selects every finding in stable
severity order, verifies batches of ten within the shared verification budget,
and follows up on findings arriving after an overlapping verification. A failed
batch preserves its findings and successful sibling verdicts, with incomplete
coverage reported. Uncertain findings retain their hypothesis as quoted text,
receive an explicit unverified title, low confidence, and an investigate kind.
Nits remain nits; blocking findings become P3. Finder summaries are omitted when
they could repeat claims left uncertain by verification. Telemetry records
uncertainty directly rather than inferring it from a severity change.

The same revision fixes contradictory incomplete-review merge guidance, bounds
Cline changes-since context to its argv transport, streams the delta file overview
with an omission count, preserves the summary when that optional overview fails,
and records Git output deadlines as timeouts.

Validation: 1,025 tests passed; subsequent focused checks passed after cleanup.
Typecheck, lint, formatting, build, and diff checks passed. An isolated Cline
transport probe submitted 122,706 UTF-8 bytes under the 122,880-byte limit, retained
the output reminder and omission notice, and parsed the result. A real timed
child was killed after 30,006 ms and classified as a timeout.

Incremental self-review/de-slop: 15 comment blocks adjudicated (2 kept, 5 rewritten,
8 cut, including an inline transport-budget explanation); 3 new tests kept for
separate regressions (batch failure isolation, advisory uncertainty presentation,
and advisory uncertainty telemetry). One obsolete verification-cap test was
removed. Existing tests cover late advisory verification, incomplete guidance,
and bounded file-overview output. Implementation commit: +348/-242 lines.

### Repeated configuration comparison

Twelve runs pinned to `73807612fe95c930f5e731cd45f736786aa1e575`, using the same
unchanged-helper defect/clean pair described above: three repetitions per case
and configuration, one main pass, verification enabled, fresh sessions, fixed
shuffled order, and no expected answers or reviewer comments in prompts. Source
and HEAD were checked before each run. Artifacts:
`/tmp/jbot-quality-screen-7380761/{manifest.json,runs.jsonl,00..11.json}`.

| Configuration                                        | Defect                     | Clean counterfactual       | Median elapsed |
| ---------------------------------------------------- | -------------------------- | -------------------------- | -------------- |
| Pi / OpenCode Go Muse 1.2 Contributor, tools enabled | Grounded P1 in 3/3         | No findings in 3/3         | 22.325s        |
| CommandCode / Muse 1.3 Contributor, tools disabled   | Unverified advisory in 3/3 | Unverified advisory in 3/3 | 39.125s        |

All six CommandCode advisories went through verification and were visibly marked
uncertain. They still did not distinguish the defect from the clean case. These
are different model/tool configurations, not a causal tools-only comparison or
an overall quality ranking.

### Whole-branch Pi review

A full-branch local review at `7380761` used Pi / Muse 1.2 Contributor, medium
requested effort, three review passes, and verification. It completed in 169.592s
with all enabled sessions finished and no forced exit. Main used 12 repository
calls; verification used 23. Four deduplicated findings were verified: the false
undefined-CommandCode-timeout claim was refuted, but two false positives survived
(the unchanged negative-timeout behavior and the already-tested UTF-8 page
boundary), alongside the known full-corpus merge requirement, overclassified P1.
No code changes were made to satisfy those false positives. Artifacts:
`/tmp/jbot-quality-dogfood-7380761/{result.json,run.log}`.

This demonstrates working investigation and broader verification coverage, not
sufficient overall precision. The full three-repetition corpus and blind
adjudication/rescore remain outstanding; the branch is not merge-ready.

### CommandCode minimum-tool feasibility

The [tools](https://commandcode.ai/docs/reference/tools) and
[CLI](https://commandcode.ai/docs/reference/cli) documentation were checked against
installed CommandCode 1.44.0. `--tools-enable` re-enables headless-withheld tools;
it is not a restrictive allowlist. The documented
[mod API](https://commandcode.ai/docs/mods) provides `setActiveTools`, which hides
other tools and refuses their execution.

An isolated fixture with a temporary HOME and trusted mod exposed exactly
`read_file`, `read_directory`, `glob`, and `grep`. Muse 1.3 Contributor followed an
import with two successful reads and returned the correct helper value. Artifacts:
`/tmp/jbot-205-commandcode-minimal/`. The initial probe mistakenly supplied the
whole configured key pool; the corrected probe selected one existing key.

This is feasibility evidence, not a sandbox/security certification or review
quality comparison. Production CommandCode tooling remains disabled. Its
project settings/hooks/mod discovery must be isolated before adopting this
allowlist for arbitrary PR checkouts; plan mode alone is insufficient.
