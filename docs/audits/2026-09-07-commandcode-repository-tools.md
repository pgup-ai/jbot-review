# CommandCode repository tools

PR #205 is the baseline (`8987ddf`). This change adds opt-in investigation to
CommandCode main and auxiliary sessions with `JBOT_COMMANDCODE_TOOLS=true`.
The default remains off; full-diff embedding and model selection are unchanged.

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
were retained because their prompt and execution path were unchanged; their
original source manifest is saved alongside the final one.

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
or a model ranking. Keep the rollout opt-in pending broader corpus evaluation.
The dogfood workflow forwards the repository variable `JBOT_COMMANDCODE_TOOLS`;
this PR does not set that variable or enable tools globally.

References: [CommandCode CLI](https://commandcode.ai/docs/reference/cli),
[mods](https://commandcode.ai/docs/mods), and
[tools](https://commandcode.ai/docs/reference/tools). Installed-version probes,
rather than plan-mode claims alone, establish the boundaries above.
