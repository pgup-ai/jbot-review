# Native review tools

This branch removes jbot's replacement repository tools. CommandCode now uses
its native CLI tools in plan mode, enabled by default; `JBOT_COMMANDCODE_TOOLS=false`
remains the rollback to embedded evidence only. Pi uses its documented native
`read`, `grep`, `find`, and `ls` tools. OpenCode no longer registers `review_context`.
Other provider routing and existing tool-less backend policies are unchanged.

Deleted the CommandCode mod, Pi read/search/diff replacements, shared byte-page
and literal-search implementations, and obsolete tool tests. No dependencies or
CLI versions changed. Full assigned diff delivery, finding verification and
publication gates remain in jbot. Optional evidence preparation/checkpoint hooks
remain; they do not register repository tools.

CommandCode keeps an isolated home and launch directory. JSON repairs use a
separate temporary home with tools denied, so repairing one response cannot
change permissions for concurrent sessions. Pi withholds mutation/shell tools
through the SDK's native tool selection. Native file tools are not a filesystem
sandbox: untrusted repositories should run in isolated environments.

## Local validation

Used the changed source and installed CommandCode 1.56.2. The small fixture changes
`if (index < 0)` to `if (!index)` after `indexOf`, with an unchanged caller looking
up the first array element. Runs used the real local pipeline with finding
verification explicitly enabled, full diff delivery, and no GitHub posting.

| Run                                                      | Result                                                                                          |                           Time |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | -----------------------------: |
| CommandCode / Muse Spark 1.3 Contributor, low            | Main review and verification completed; retained the seeded bug; verifier made two native reads | 17.8s total; 7.9s verification |
| Pi / OpenRouter Ling 3.0 Flash Fin free                  | Main review and verification completed; retained the seeded bug                                 |                     7.2s total |
| Pi direct verification, same free model                  | Read both files using native tools; confirmed the seeded bug                                    |                           7.0s |
| CommandCode / Muse Spark, nine historical FMS candidates | 25 native calls completed; no final verdict before timeout                                      |                       180s cap |
| Pi / Nemotron 3.5 Lightning free, same nine candidates   | One tool call observed; no final verdict before timeout                                         |                       180s cap |

The first free MiniMax route returned 404 (free route unavailable); that was not
a review result. Initial local pipeline attempts also exposed operator settings:
`PROVIDER=devin` and `JBOT_SDK_ENGINE=opencode` in the local environment. The rows
above explicitly selected the intended provider/engine and verification setting.

The earlier standalone native-CLI experiment completed the nine FMS verdicts in
145.8s versus a custom-tool timeout at 180s, but this repeat did not reproduce
that completion. These runs prove native tool wiring and a simple known-bug
path, not a general latency or accuracy improvement. The fixture's P1 rating is
model output, not an independently validated severity calibration.

Pi's native regex grep, glob find, and bounded line reads were also exercised
directly against the installed SDK. The slim Docker image builds, contains
CommandCode 1.56.2 and Pi's native tools, and no longer contains the custom mod.

Local raw logs are in `.jbot-review/native-harness-validation/` and `/tmp/native-*.log`;
credentials are excluded. Model runs did not change the reviewed checkouts.

## Self-review

- Typecheck, lint, 1,111 tests, build and diff whitespace checks pass.
- Existing recovery tests now check native settings isolation and repair-home cleanup.
- Native Pi event telemetry is covered without replacing tool execution.
- De-slop: removed redundant native-tool descriptions and obsolete experiment arms;
  removed the leftover retrieval metadata wrapper and duplicate tool-list assertion.
  Of the two modified comment blocks, one was shortened and one deleted.
  Of the two reworked test cases, the native-event telemetry test was retained;
  the prompt-wording test was deleted. Repair isolation and explicit opt-out
  behavior remain tested. No new standalone test cases were added.

The full live quality corpus and blind adjudication have **not** been run. Because
CommandCode tools become enabled by default, the repository's full-corpus gate
is still required before merging or deploying this default change. Local smoke
results do not satisfy that gate.

## Dogfood permission failure and correction

Run `35631540323`, job `106438663930`, denied 14 native file reads and eight
searches. Three of five main tasks failed; the coverage guard withheld the
review. The actual CLI stop reason was `permission_denied`; stderr misleadingly
led with the reasoning-effort notice and reported continuation exhaustion.

Reproduced with CommandCode 1.56.2 in the slim Docker image, DeepSeek V4 Flash
Fast at low effort, an isolated home/launch directory and `/github/workspace`.
Passing `--add-dir` left native session `additionalDirectories` empty. The control
exited 9 after 4.5s, denying both `read_file` and `grep`. Setting the native
`permissions.additionalDirectories` to the checkout completed both calls with
no denials and exit 0 in 5.9s. Muse Spark 1.3 Contributor also completed native
read/search with the setting and no `--add-dir` flag in 12.5s. No custom permission
hook or repository tool was
added. The ineffective flag was removed; repair homes still deny all tools.

Progress now records the native stop reason from a fixed set of known values.
Permission-stopped runs fail before JSON repair, including when the CLI returns
text with a success-shaped frame. Other CLI errors omit the reasoning-setting
notice. Directory telemetry uses the native `read_directory` name.

Pi verification now has a temporary canonical diff file, removed with the
runtime, for native read/grep recovery of omitted or deleted patch lines. A free
Ling verification recovered the old and new guard from a 66,380-byte diff and
confirmed the seeded bug in 10.5s with five native tool calls. This file supplies
evidence; it does not replace mandatory full-diff delivery for main reviews.

Review feedback: native Pi tools already bound text results through their own
truncation/continuation logic. No replacement output wrapper was added. Existing
tests cover native directory telemetry, denied-stop handling, workspace settings
and unfinished Pi tool-event cleanup; no new standalone test cases were added.

Native-tool access is deliberately retained. The filesystem/credential isolation
comments remain unresolved: Pi's in-process tools are not path-confined, and
CommandCode permits reads in its own configuration directory. A disposable
checkout alone does not isolate credentials. No new sandbox or custom tool
wrapper is claimed here. These limitations and the full-corpus gate remain
outstanding; successful tool calls do not establish merge readiness.

An initial full-branch local run used an 8-minute budget, three concurrent
sessions and DeepSeek for both roles. It completed 99 native reads/searches with
zero permission denials, but only five of eight main pages completed before the
allocated main-review deadline (225s). That run is not a completion pass and is
not comparable to CI's 30-minute budget and five-session limit.

The small known-bug Docker pipeline completed main review and finding verification
with DeepSeek V4 Flash Fast at low effort: 1/1 hunks delivered, bug retained,
13.5s review time (15.5s including startup). Those sessions used embedded evidence;
the separate explicit native read/search probes establish tool execution.

With CI's selected main/aux pair (DeepSeek V4 Flash Fast / Muse Spark 1.3
Contributor), low effort, five concurrent sessions, one requested shard group,
two passes and a 30-minute budget, the full local branch review completed all
five main pages: 103/103 hunks delivered. The last main page finished in 413s.
This run includes the local fixes and differs from the original PR prompt, so
it is a completion check, not a matched latency benchmark.

That full run completed in 679.5s (681.4s including startup), including all four
auxiliary pages and finding verification. Native tools completed 160 file reads,
131 searches and one glob with zero read/search denials. Four shell attempts
were denied by native plan mode and four were blocked by native hooks; sessions
continued and completed. The verifier completed in 60.3s with seven reads and
three searches. This confirms functional recovery, not a latency improvement.
The local run found a stale `retrieval` entry in the configuration-matrix test;
it was removed before pushing. Its claimed typecheck failure was not reproduced:
all checks passed before that cleanup too.

### Permission-denied candidate recovery

Denied CommandCode sessions now preserve strictly parsed findings in an error.
Lens and guideline callers retain those candidates through the existing file
clamp and verification pipeline while recording failed coverage. Main review
still rejects the incomplete page. Invalid output is not repaired, and recovery
adds no model calls.

Validation: all 1,111 tests, typecheck, lint and build passed. The local Docker
pipeline with DeepSeek V4 Flash Fast retained the seeded defect and completed in
16.4s including startup. Deterministic denial tests cover candidate recovery and
rejection of prose; the live smoke did not induce a permission failure. No new
standalone tests were added. The one new comment explains why repair is skipped.
The core benchmark was not rerun for this fix; the branch's full-corpus default
rollout gate and documented filesystem-isolation concerns remain outstanding.

### Follow-up review

The incomplete-review footer now includes recovered candidates and explains that
unverified candidates stay in diagnostics. Pi's prompt explicitly permits the
canonical diff file outside the checkout. A separate guideline test verifies
candidate retention, assigned-file clamping and failed coverage.

All 1,112 tests, typecheck, lint and build passed. Free-model Pi verification
recovered the removed guard from the 66 KB diff and confirmed the seeded defect
in 8.6s. The core corpus was not rerun. The latest dogfood artifact's one withheld
candidate correctly identifies the still-outstanding full-corpus rollout gate.
Cline remains tool-less; its CLI's global auto-approval was not enabled.

### CommandCode prompt capacity

Run 35640189001 reviewed the full PR, not just the +3/-2 follow-up commit.
It delivered 118 hunks through seven main pages and five joint auxiliary pages.
The native session cost estimate was $1.4279; auxiliary interactions accounted
for $1.0987. These are estimates, not additional GOAT-plan billing.

The planner used a 128,000-token fallback for Muse Contributor and DeepSeek
Flash Fast. CommandCode 1.56.2's bundled catalog gives them 1,048,576 and
1,000,000 tokens respectively. Both main and auxiliary planning now use those
known capacities. The 256 KiB assembled-prompt ceiling, output reserve, unknown
model fallback and mandatory hunk coverage checks remain unchanged.

A deterministic replay of fd67fa1's local Git diff, using the logged guideline
and core byte counts as placeholder context, reduced seven pages to one and
assembled prompt bytes from 501,783 to 192,290. All 122 Git-parsed hunks remained
assigned. This is a planner comparison, not an exact replay of GitHub's 118-hunk
input or evidence of equivalent model recall.

All 1,112 tests, typecheck, lint and build passed. The existing capacity test now
checks CommandCode paging and complete delivery too; no standalone test was
added. The cheap-model local smoke completed in 21.0s including startup, found
the seeded defect and retained it after native-tool verification. The one added
comment records the source of the model limits. Dead experiment-plan retrieval
branches were removed; legacy retrieval plans fail explicitly.

No arbitrary native turn cutoff or cross-head cache reuse was introduced.
Neither has quality evidence sufficient to replace the existing coverage
contract. The core corpus was not rerun; the branch's full-corpus rollout gate
and filesystem-isolation concerns remain outstanding.

The two withheld findings in that run were inconclusive verdicts about Pi and
CommandCode filesystem isolation. Verification executed native reads/searches,
but lacked authoritative evidence about dependency internals. Tool availability
does not guarantee a conclusive verdict or justify publishing a hypothesis.

The full local branch run then completed in 545.3s (547.3s with Docker startup):
one main session, one joint auxiliary session and one verifier. It delivered all
130/130 hunks with no incomplete tasks. Main review took 504.5s, auxiliary work
255.1s and verification 36.9s. Estimated session costs totaled about $0.308.
Main used Muse Contributor, auxiliary/verification DeepSeek Flash Fast, all at
low effort. The CI comparison used medium main effort, different context and
cache state, plus summary/addressed sessions absent locally; this is functional
validation, not a matched latency or recall benchmark.

The run confirmed a small telemetry defect: native Pi `ls` was classified as
`other-readonly`. It now maps to `list`, with an assertion folded into the existing
classifier test. This does not alter model input or tool execution.

Follow-up de-slop: one new comment kept for catalog provenance; assertions folded
into two existing tests, no new standalone cases. Removed the dead retrieval
plan field and branches. No new P1/P2 issue found in these follow-up changes.

### Model-pool coverage

Added CommandCode Luna (1,050,000), Qwen3.8 Omni Flash (1,000,000) and GLM 5.3
FlashX (1,000,000) from the pinned CLI catalog. Both requested DeepSeek entries
were already present. CommandCode lookups now accept canonical or lowercase IDs.
The published CLI package has no importable catalog API; its entry point launches
the CLI, so importing bundled internals would not simplify this integration.

OpenCode budgets now reuse model limits returned by the existing SDK startup
readiness call. A live local server returned 1,048,576 context tokens for both
Muse Contributor routes and 1,000,000 for Go DeepSeek V4.1 Flash. No extra request
or hardcoded OpenCode model table is needed. Metadata only applies to sessions
served by that OpenCode runtime; other backends retain their own catalog lookup.

Self-review/de-slop: no new comments, helpers, dependencies or standalone tests.
The existing readiness test now asserts returned model limits as well as retry
behavior. The existing capacity test covers the added CommandCode entries.
The corpus benchmark was not rerun; the previously documented rollout gate
remains outstanding.

Validation: all 1,112 tests, typecheck, lint, formatting and build passed. The
free OpenCode Muse Contributor Docker smoke completed in 19.9s including startup,
used the SDK's 1,048,576-token limit, delivered its full diff and retained the
seeded defect after verification. This is a smoke test, not a recall benchmark.
