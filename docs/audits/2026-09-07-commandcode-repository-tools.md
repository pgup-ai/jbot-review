# CommandCode repository tools

PR #205 is the baseline (`8987ddf`). This change enables repository investigation in
CommandCode main and auxiliary sessions by default. `JBOT_COMMANDCODE_TOOLS=false`
disables tools; full-diff embedding and model selection are unchanged.

## Runtime and boundaries

Validated with CommandCode 1.44.0, Node 24, on macOS and in the Linux slim image.
The CLI starts in an empty directory with an isolated HOME. Project/operator
settings, hooks, mods, and skills cannot be discovered there. The only loaded
mod belongs to J-Bot; its bootstrap exits if initialization fails.

The exposed tools are `jbot_read_file`, `jbot_list_files`, and
`jbot_search`. Reads resolve paths and symlinks before checking repository
confinement. The reader and Git tools reuse J-Bot's paginated output helpers;
there is no new aggregate tool-call or read quota. Listing includes tracked and
non-ignored untracked paths; search covers non-ignored files. Git search disables
text conversion and fsmonitor, and pins the worktree.

The first default-on dogfood run exposed a Docker ownership gap: the Action's
global `safe.directory` entry was invisible inside CommandCode's isolated HOME.
A checkout owned by UID 1001 reproduced list failures (Git exit 128) and failed
file-visibility checks. Every tool Git call now trusts only the canonical checkout
path through `-c safe.directory`; global configuration remains isolated. A startup
Git check stops the mod if repository access fails. The regression test simulates
foreign ownership, and the rebuilt Linux image passes with an actual UID 1001
checkout while still rejecting ignored secrets.

In [run 34170413510](https://github.com/pgup-ai/jbot-review/actions/runs/34170413510/job/101889494845),
the image build took 1m 59s and both Muse auxiliary sessions finished within two
minutes with failed file/list calls. LongCat's main session hit its 1,770-second
deadline; the run failed without posting incomplete review coverage. Tool counts
are emitted only after successful session completion, so the log cannot establish
whether LongCat was retrying tools, generating, or waiting on the provider.

After the ownership fix, default-on Linux reviews of the defect fixture on a
UID 1001 checkout retained the verified P1 with Muse 1.3 in 32s and LongCat in
220s. Logs are at `/tmp/jbot-206-foreign-muse` and
`/tmp/jbot-206-foreign-longcat`. LongCat repeated completed searches, used regex
syntax with literal search, requested an offset beyond the output, and needed
one JSON repair. These probes validate access and expose model inefficiency;
they do not establish the cause of the full-PR timeout or its resolution.
The ownership-fix self-review kept one concise rationale comment and extended
existing tests without adding cases. All 1,028 tests and the standard checks pass.

Native plan-mode tools alone were insufficient in the isolation probe: all
three models could read an outside canary through a direct path or a symlink.
Inspection showed the CLI's native grep fallback can also follow symlinks, and native file reads
interpret brackets as globs. The trusted tools avoid those paths. Native shell,
write, grep, glob, and file-read tools are absent from the active tool set.

With the final tools, all three models read a bracketed `[id].ts` import, received
explicit errors for direct and symlink escapes, found no outside canary through
search, and listed repository files successfully. A hostile project mod and
SessionStart hook did not execute; the repository was not mutated. Unit tests
also cover a malicious Git fsmonitor setting and redirected `core.worktree`.

A follow-up self-review reproduced an escape when an uncommitted directory
symlink replaced an indexed directory: index-based Git grep followed the parent
symlink. Search now walks the filesystem with `--no-index --exclude-standard`,
which skips symlinks and includes non-ignored untracked files. Tracked files
matching ignore rules remain available through direct reads. The existing
isolation test covers the escape and search scope. The
bundled Linux tool also passes the same escape probe. The 36-run matrix below
preceded this change.

The follow-up also blocks Git metadata and ignored untracked files from direct
reads, including symlink aliases. Native directory listing was removed because
the filtered file-list tool already covers discovery. Tool descriptions now live
in `prompt.ts`; malformed searches are checked in the existing isolation test.

## Paired quality screen

The same counterfactual pair used in the [PR #205 investigation](2026-09-07-review-investigation.md)
removes a twenty-minute fallback from `review.ts`. The unchanged `process.ts`
uses zero as its default in the defect fixture and twenty minutes in the clean
fixture. Both changed diffs are identical; reading the unchanged helper is
necessary to distinguish them.

| Fixture | Base                                       | Head                                       |
| ------- | ------------------------------------------ | ------------------------------------------ |
| Clean   | `edf8c878ae7e7c20f555b0f070939836c91d009b` | `cba92e51625951db2f526b8270cae4a4bf3e6401` |
| Defect  | `55ef3075c7d627ab4574e35ca5c07da25bf110d3` | `bdd72520e9226ba7c47b1fa99959af6decdd68bd` |

Each model runs with tools off and on, three repetitions of each fixture:
36 runs through the real local review pipeline. There is one main pass, one
shard, verification enabled on the same model, no lens passes or repository
guidelines, and a one-session limit per review. Trial order is seeded and
randomized; three independent reviews run concurrently. This compares complete
configurations, including their tool instructions. Wall times are observations
on a shared host, not isolated performance measurements.

| Model                | Tools | Grounded defect | Clean with no findings | Median wall time |
| -------------------- | ----- | --------------- | ---------------------- | ---------------- |
| Muse 1.2 Contributor | Off   | 0/3             | 0/3                    | 37.0 s           |
| Muse 1.2 Contributor | On    | 3/3             | 3/3                    | 53.4 s           |
| Muse 1.3 Contributor | Off   | 0/3             | 0/3                    | 37.1 s           |
| Muse 1.3 Contributor | On    | 3/3             | 3/3                    | 27.9 s           |
| LongCat 2.0 Free     | Off   | 0/3             | 0/3                    | 62.0 s           |
| LongCat 2.0 Free     | On    | 2/3             | 3/3                    | 113.2 s          |

All 36 runs completed. All 18 tool-less runs retained an unverified P3 advisory,
including every clean run. Enabled-tool runs retained eight grounded P1 defects
and no clean-case findings; LongCat returned no finding in one defect trial.
The main reviewer returned zero findings in that trial, so verification did not
run. This is not evidence that tools alone make every model reliable.

An earlier LongCat pilot repeatedly advanced search offsets by one byte despite
receiving the end-of-output marker. The final schema explicitly identifies byte
offsets and permits continuation only from a next-page notice. All enabled-tool
trials were rerun with that schema. Twelve completed no-tools baseline trials
were reused because their prompt and execution path were unchanged; six no-tools
trials ran anew, giving 18 no-tools trials plus 18 enabled-tool trials. No final
trial was excluded. The reused trials' original source manifest is saved
alongside the final one, and `runs.jsonl` marks them with `reusedBaseline`.

An unverified P3 hypothesis is counted separately from a grounded defect. An
advisory on clean code is unnecessary review noise, even when its conditional
wording avoids a false factual claim. Main discovery and subsequent verification
are both included in the retained result.

## Response parsing

The matrix preceded the final parsing changes. Investigation reproduced a
separate failure: `Calling review(command, {}) ...` before a valid JSON review
could make the parser select `{}` and silently return no findings. Strict mode
now requires the array expected by each pass: `findings` for main/guideline
reviews and `addressedPriorComments` for addressed checks. An addressed-only
object cannot satisfy a main review. Empty arrays remain valid, and auxiliary
repairs still fail open.

A controlled probe injected that malformed first response into the actual local
pipeline. Muse 1.3 repaired it, read the helper, and verified the resulting P1.
This is recorded at `/tmp/jbot-cc-repair-probe`. The original LongCat miss's raw
response was not retained, so its cause remains unproven; a separately traced
rerun returned a valid P1 (`/tmp/jbot-cc-trace-results`). These probes are not
added to the 36-run matrix or presented as proof of a model-quality improvement.

## Validation and rollout

Self-review: no P1/P2 issues remain. Reviewed seams include Action/app/local
configuration, backend limiting, CLI lifecycle, repository tools, response
repair, telemetry, and packaging. Cleanup removed duplicate credential removal
and file-stat checks and shortened the default-capability comment.
Comments: seven blocks reviewed; two kept, one rewritten, four removed.
New tests: three kept, none folded or removed; existing tests cover added wiring
and parsing assertions.

- Three focused regression tests; 1,028 existing and new tests pass in total.
- Formatting, typecheck, lint, bundle build, and slim Docker build pass.
- A real Linux-image review and verifier both used repository tools and retained
  the timeout defect as P1.
- A whole-branch Muse 1.3 review completed with no main or guideline findings,
  using 30 main and 17 guideline tool calls. It used a temporary worktree without
  local credentials or ignored files. This preceded the final paging-description
  clarification; it is a smoke test, not an independent quality score.

Raw manifests, per-trial results and logs are local at
`/tmp/jbot-commandcode-quality-release-20260907`. The manifest records the
reviewer source hashes and fixture commits. Isolation results are at
`/tmp/jbot-commandcode-isolation-validated`; Linux-image output is at
`/tmp/jbot-commandcode-docker-smoke`. These are diagnostic results, not a committed
corpus ledger entry. The final self-review changes were checked with regression
tests and the rebuilt Linux bundle; the model matrix was not repeated.
Two final Linux-image Muse 1.3 smoke reviews stayed quiet on the clean fixture
and retained the verified P1 on the defect fixture. Both main sessions and the
defect verifier used repository tools. Results are at
`/tmp/jbot-206-final-clean` and `/tmp/jbot-206-final-defect`.

The full/core corpus and blind adjudication were not run. This pair tests one
specific cross-file evidence gap; it does not establish general review precision
or a model ranking. The sole consumer explicitly approved enabling tools by
default and waived the full-corpus gate for this switch. This is an accepted
rollout limitation, not a passed benchmark gate. The dogfood workflow forwards
`JBOT_COMMANDCODE_TOOLS`: unset or blank enables tools; explicit `false` disables
them. No repository variable needs to be created.
A Linux Muse 1.3 review with the flag unset used repository tools in both main
review and verification and retained the P1 defect (`/tmp/jbot-206-default-on`).
Default and opt-out assertions pass with all 1,028 tests.

## Latest dogfood and review follow-up

[Run 34172342765](https://github.com/pgup-ai/jbot-review/actions/runs/34172342765/job/101894916823)
completed successfully at `0a9a840`. CommandCode Muse 1.2 made 22 successful tool
calls (17 reads, four searches, one listing) and finished main review in 228s.
Pi/Muse 1.2 auxiliary discovery took about 32s in parallel, followed by 32s of
verification. Two findings were posted: the valid worker opt-out omission and
optional Git locks. The latter is useful consistency hardening; the run does not
demonstrate index mutation by these specific Git commands. The main review missed
the independently reproduced file-replacement race. This run confirms functioning
tool access, not complete recall or a controlled model comparison.

The follow-up forwards the worker opt-out, disables optional Git locks, and reads
through the validated file descriptor. The replacement regression fails on the
previous implementation by returning outside-file content and passes on the fix,
including in the rebuilt Linux image with a foreign-owned checkout. Existing
tests also cover failed Git visibility checks and nested search scope. Nested
source remains searchable; ignored files and Git metadata remain excluded.

Arena now consumes `reviewConfig.commandCodeTools`, defaulting missing legacy
fields to true independently of ambient environment. The companion Arena change
freezes the repository variable at preparation and retains it in result
provenance. Producer/consumer checks pass for both Boolean values. Deploy the
core image before enabling the companion workflow's opt-out.

Self-review and de-slop found no further issues in these fixes. No new comment
blocks or test cases were added; existing cases cover the regressions. All 1,028
core tests and 18 Arena tests pass, along with formatting, typecheck, lint, and
both builds. The Linux image passes read/list/search, ignored-file, and replacement
checks. No new live corpus run was made for these fixes; the rollout limitation
above still applies.

[Run 34173141823](https://github.com/pgup-ai/jbot-review/actions/runs/34173141823/job/101897219507)
used Pi/Muse 1.2 for main review (109s) and CommandCode/LongCat for auxiliary
work. Three auxiliary sessions started concurrently: summary finished in 21s,
addressed checks in 35s, and guideline checking was abandoned after 709s. The
verifier then timed out after 300s. The job succeeded with incomplete coverage;
its sole unverified P3 was false: ordinary `git check-ignore` exempts tracked
files, including those matched by ignore rules. The existing test and Linux
probe confirm this. More auxiliary slots would not have addressed this run's
bottleneck. The existing opt-in `verifyOverlapGrace` can overlap verification
with the auxiliary tail; it does not make LongCat complete successfully.

The next fixes strictly validate the requested array after OpenCode/Pi repairs
and check file visibility before and after opening, then compare path/descriptor
identity after Git validation. The regressions fail on the previous code and
pass on the fixes; the ignored-file replacement probe also passes in Linux.
Self-review/de-slop rewrote one stale comment and retained one new Pi regression
case for its independent repair/session-disposal path. Existing cases cover the
other changes. All 1,029 tests, formatting, typecheck, lint, bundle build, and
slim-image build pass. No concurrency/default policy changed, and no new live
corpus run was made.

## Main-session guideline experiment

[Run 34174490400](https://github.com/pgup-ai/jbot-review/actions/runs/34174490400/job/101901090780)
used OpenCode/Muse 1.3 for main review and CommandCode/LongCat for auxiliary
work. Main finished in 230.5s with no findings. Summary and addressed checks
finished in 16s and 35.5s, but guideline checking was abandoned after 835.7s,
including ten minutes after main finished. No findings meant no verification.
The job succeeded with incomplete coverage. The log does not establish whether
context size caused the guideline timeout; adding concurrency would not fix a
session that already ran concurrently.

`JBOT_GUIDELINE_SWEEP` is an opt-in experiment, enabled in this repository's
dogfood workflow. OpenCode, Pi, and CommandCode continue each main session for a guideline
sweep using its existing diff and investigation, plus the full bounded guidelines.
Other backends retain the separate pass. Verification still creates a fresh
session. The sweep stays within the main attempt's remaining deadline, capped
at ten minutes; failures retain main findings and record incomplete coverage.
Cache identity includes the sweep guidelines, and incomplete sweeps are not
cached. Arena comparisons retain their existing policy.

Live probes used a committed fixture with a removed subprocess-timeout fallback:

| Actual backend/model               | Result                                                                                 |
| ---------------------------------- | -------------------------------------------------------------------------------------- |
| OpenCode/Muse 1.3 contributor free | Same-session sweep completed; fresh verifier retained the seeded defect; 76s total.    |
| Pi/Muse 1.2 contributor free       | Same-session sweep completed; separate verifier retained the seeded defect; 47s total. |

An additional Muse 1.3 probe requested Pi but routed through OpenCode; it is not
Pi evidence. Local artifacts are under `/tmp/jbot-guideline-sweep-opencode`,
`/tmp/jbot-guideline-sweep-pi`, and `/tmp/jbot-guideline-sweep-pi-native`.
Both sweeps returned zero additional findings. These probes demonstrate session
reuse and retained findings, not improved recall or latency versus a control.
The Pi finding also included an unnecessary speculative alternative about zero
being interpreted as disabled; retaining the real defect does not establish
perfect precision. No core/full corpus or blind adjudication was run for this
experiment, and the global default remains off.

The unresolved race-test feedback was valid. The existing regression now also
replaces the path during the second visibility check, after opening. Removing
descriptor revalidation makes the test fail. Self-review and de-slop retained
three new cases for session reuse/fail-open behavior and cache separation, with
no new TypeScript comment blocks. All 1,032 tests, typecheck, lint, formatting,
bundle build, and slim-image build pass. Later test-only extensions for policy
fingerprinting, capability forwarding, and changed-guideline cache identity
passed the focused 81-test suite and typecheck.

### CommandCode continuation

The same experiment now covers CommandCode main models. CLI 1.44.0 resumes the
explicit main session ID with `--resume`, retaining the isolated launch directory,
model, permissions, and repository mod. JSON repair also resumes that session when
the experiment is enabled. Verification starts without a resume argument. Missing
or mismatched session IDs and invalid sweep output fail open with incomplete
coverage. Resumed calls report token usage but omit the transcript-based dollar
estimate: subtracting transcript totals produced misleading zero estimates in the
live probes, so no per-turn dollar accuracy is claimed.

Live CommandCode Muse 1.2 and 1.3 Contributor runs on the same fixture completed
in 52s and 83s. Both resumed sweeps returned a duplicate of the seeded defect;
dedupe removed the extra finding and fresh verification retained the defect.
Repository tools succeeded in main review and verification. Artifacts are in
`/tmp/jbot-commandcode-sweep-native-1.2` and `-1.3`. These runs validate continuation,
not better recall. An initial probe accidentally inherited another model from the
launch directory's environment and was stopped; it is excluded from the results.

Latest feedback also removed the sweep's dependency on auxiliary availability
and fan-out, retained the explicit guideline opt-out, removed a duplicate prompt
rule, and pinned the sweep's read-only tool map directly.

Self-review found no remaining P1/P2 issues. De-slop retained one new subprocess
regression case: it tests concurrent session identity, JSON repair, fail-open
continuation, permissions, fresh verification, and cost omission. No TypeScript
comment blocks were added. All 1,033 tests, formatting, typecheck, lint, and the
bundle build pass. Packaging is unchanged. No additional corpus benchmark ran;
the experiment remains opt-in globally.

### CommandCode live progress

Run 34176488426 completed main review in 199s and the resumed guideline sweep in
130s, both with no findings. The concurrent Muse 1.3 interactions pass ran for
929s before the auxiliary grace cutoff aborted it; its queue wait was 1ms.
Buffered output left no tool or usage metrics for that pass, so the evidence
cannot distinguish active investigation from a stalled model or tool.

The update consumes NDJSON metadata as it arrives and logs one-minute snapshots.
Final snapshots are emitted on success, error, timeout, or abort and retained as
`commandcode-progress` rows, separate from token-bearing session rows. Only
allowlisted tool names and outcome categories are retained; unknown names become
`other`. No arguments, results, paths, or generated text enter progress output.
Malformed and oversized metadata frames mark counts incomplete. Token totals are
retained only when emitted in a result or run-end frame; no per-turn usage is
inferred. Hard termination of the entire runner can still prevent the final
artifact, but earlier heartbeat logs survive.

Self-review and de-slop retained one new parser case for chunk boundaries,
metadata privacy, dropped frames, and absent usage; existing process/provider
cases cover live delivery, timeout preservation, and unchanged failure behavior.
No new TypeScript comment blocks. All 1,034 tests, formatting, typecheck, lint,
and bundle build pass. A live CLI 1.44.0 Muse 1.2 probe retained the seeded defect
and emitted tool-progress snapshots (`/tmp/jbot-commandcode-progress-1.2`). Each
prompt completed within a minute; deterministic subprocess tests cover streaming
before exit, periodic reporting, timer cleanup, and retained metadata on timeout. No prompt, finding policy, deadline,
concurrency, or packaging changes; no additional quality benchmark was run.

References: [CommandCode CLI](https://commandcode.ai/docs/reference/cli),
[mods](https://commandcode.ai/docs/mods), and
[tools](https://commandcode.ai/docs/reference/tools). Installed-version probes,
rather than plan-mode claims alone, establish the boundaries above.

### Scoped search and review-feedback fixes

CommandCode and Pi share literal search argument validation and schema. `query`
accepts one string or an array matching any literal; optional `paths` restricts
search to literal repository-relative files or directories. Paths cannot escape
through traversal, Git metadata, or pathspec magic. Existing backend visibility,
symlink handling, worktree reads, and pagination remain intact. No index, regex,
new configuration knob, or tool-policy change is introduced. OpenCode keeps its
existing native search tools.

CommandCode addressed-comment and standalone guideline checks now require the
expected array and attempt one repair within the original deadline. Repairs reuse
the returned session ID when available; unrepaired output reaches the existing
auxiliary fail-open handling. Result-only successful CLI responses now produce
complete progress snapshots even without optional event frames. Malformed or
dropped frames still mark progress incomplete. Existing telemetry uses role
labels for `session`, so the progress field retains that convention.

A local interactions-lens ablation used CommandCode 1.44.0 and
`meta/muse-spark-1.3-contributor`, three fresh sessions per arm, interleaved with
at most two concurrent sessions and a 180s deadline. The fixed fixture diff was
`c21389c0ccc32fbb2d8bd90950f992c08873c625...0b31c5e1184b95571e330903567984138f28877c`:
`review()` stopped supplying its 1200000ms default while unchanged `execute()`
still converted an undefined timeout to zero. Only the changed wrapper was
embedded; tools could inspect the unchanged callee. The same interactions prompt
was used in all arms, with the existing tool/no-tool directive appropriate to
each arm. The read/search-only arm changed the local mod's active tool allowlist;
no production setting was added.

| Available tools    | Durations (seconds) | Findings adjudicated against fixture                                           |
| ------------------ | ------------------- | ------------------------------------------------------------------------------ |
| Read, search, list | 13.8, 24.1, 22.7    | 3/3 identified immediate child termination as P1                               |
| Read, search       | 14.9, 21.0, 25.1    | 3/3 identified immediate child termination as P1                               |
| None               | 18.7, 17.6, 21.2    | 3/3 returned uncertain P3 investigations; none established the callee behavior |

Adjudication was manual and not blind; this is a one-fixture finder smoke test,
not an end-to-end quality benchmark or evidence of general latency improvement.
There was no separate verifier in this ablation. Retain all three tools: these
trials show loss of concrete evidence without tools and no consistent benefit
from removing listing. Raw local results are retained under
`/tmp/jbot-search-ablation-measured`; credential homes were deleted. Preliminary
CLI effort/authentication setup failures were excluded before the nine successful
trials; the measured runs use the existing key-pool selector and native effort.

Validation: all 1,034 tests, focused backend regressions, typecheck, lint,
formatting, and bundle build. New assertions were folded into existing tests;
no additional cases or source comments were needed. Self-review/de-slop found no
remaining P1/P2 issue. Core/full corpus and blind adjudication were not run for
this incremental change; no default-policy flip is included.

### Independent auxiliary scheduling

Dogfood now sets `JBOT_GUIDELINE_SWEEP=false` and
`JBOT_VERIFY_OVERLAP_GRACE=true`. Main, guideline compliance, and interactions
start independently. Main findings enter a fresh verifier without waiting for
auxiliary settlement; the existing merge sends newly arriving findings to a
later verification batch. An early verification failure now falls back to the
normal final verification path instead of publishing survivors without another
attempt. Global concurrency and consumer defaults for these experiments remain
unchanged; consumers can opt into the same environment settings.

The shared session scheduler limits interactions to ten minutes after slot
acquisition, including retries and repair calls. The absolute run deadline also
bounds execution and queued work. Expiry invokes backend cancellation, rejects
the pass, and records incomplete coverage through the existing lens handler.
Completed main findings survive. Other pass deadlines remain unchanged.

Validation: all 1,035 tests, typecheck, lint, formatting, and bundle build. The
new scheduler case uniquely covers execution allowance after queueing, queued
run-deadline expiry, cancellation, the 600s cap, and timer cleanup. Existing
verdict-merge tests cover late findings. Self-review/de-slop removed the obsolete
fail-open comment (one block cut; no new comments) and retained one new test case.
No packaging or external API contract changed. Core/full corpus was not run for
this scheduling change; the live fixture probes below are not a general quality
or latency benchmark.

Live CommandCode/Muse 1.2 probes used the same committed timeout-defect fixture.
A five-minute run exercised actual auxiliary cancellation when the existing
five-minute verification reserve left no settle grace; it retained the verified
P1 and correctly reported incomplete interactions coverage. A ten-minute run
started all three finder roles independently: guidelines finished at 15.4s,
main at 20.4s, and interactions at 22.1s. Verification started after main while
interactions was still running. The run completed in 37s with the verified seeded
P1 retained and full finder coverage. Local logs and results are retained under
`/tmp/jbot-independent-scheduling-1.2` and
`/tmp/jbot-independent-scheduling-full-1.2`.
