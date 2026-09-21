# Bounded review latency: local Cline verification

## Change

Cline now uses the shared cancellable process scope. Abandoned prompts are reaped
before their session slots and credential homes are released. Once main review
finishes, no new auxiliary finder page starts; active pages get at most 60 seconds.
Completed findings survive and incomplete auxiliary coverage remains visible.
Auxiliary pages use the existing path-risk ranking. Every main diff hunk remains
mandatory.

Catalogued free Cline models and paid Muse Contributor / DeepSeek v4/v4.1 Flash
replace the unknown-model 128K fallback. Paid limits were independently checked
through Cline 3.0.62’s live catalog; their inference latency was not benchmarked. The input
ceiling increases from 96 to 120 KiB; Cline reserves another 2 KiB below its 120 KiB
argument guard for the wrapper. Unknown models retain the conservative fallback.
There are no additional public flags. Docker now matches the tested Cline 3.0.62.

Candidate artifacts are written/chmodded to 0644, including previously created
0600 files, so the host uploader can read files produced by container root. The
PR workflow also exports its own GitHub Actions build cache while retaining the
read-only main registry cache. Local warm builds exercise layer reuse; GitHub's
remote cache and artifact-upload service still require hosted confirmation.

## Same-input pair

Both arms reviewed frozen `e4285ec` against merge-base `2d8f923`, with Cline 3.0.62,
`cline/cline-free/muse-spark-1.3-contributor`, concurrency five, two requested
passes, dynamic fanout, verification, diff-batches and a 30-minute run budget.
Control runtime: `e4285ec`; treatment runtime: `1c520a0`. Runs were sequential on
the same host with no other experiment requests running. Local mode does not
include live PR comments or history, and its hunk count differs from GitHub's.

| Measurement                                |   Control |         Treatment |
| ------------------------------------------ | --------: | ----------------: |
| Run time                                   |  615.317s | 283.679s (-53.9%) |
| Main review                                |  366.419s |          200.317s |
| Post-main auxiliary wait                   |  229.213s |           60.002s |
| Final verification phase                   |   15.661s |           21.211s |
| Main tasks completed                       |     53/53 |             21/21 |
| Main hunks delivered                       |   385/385 |           385/385 |
| Auxiliary pages planned                    |        38 |                16 |
| Session executions, including verification |        93 |                29 |
| Main input bytes                           | 4,005,252 |         2,269,589 |

Ten queued auxiliary pages were cancelled in treatment; five pages completed and
one active page was aborted at the grace cutoff. The baseline completed all 38.
This intentionally reduces supplemental review work; complete main delivery does
not establish equivalent recall. Cline's token/cache/cost telemetry is unavailable.
The initial control preflight inherited `PROVIDER=devin` from `.env` and failed
model lookup. It was excluded; both valid arms explicitly clear `PROVIDER`.

[Measured rows, dispositions and hashes](data/2026-09-20-bounded-review-latency.json).
Raw manifests, telemetry, results and the test driver are retained locally under
`.jbot-review/latency-fix/`.

## Finding adjudication

The control retained five findings; treatment retained three. These counts are
not quality scores. Neither arm found an actionable new defect on this frozen
input in manual review:

- The control's shell-prefix concern describes deliberately conservative optional
  source observation. The existing test rejects unsupported chained commands; it
  does not remove mandatory diff coverage.
- A split hunk must span pages. Its file is therefore correctly classified as
  paged on each individual page; comparing only the original hunk hash would
  incorrectly count one part as a complete file.
- The disk-cache concern assumes circular/BigInt/undefined inputs. Its sole
  production writer passes the JSON-compatible parsed evidence index, inside
  fail-open preparation. No reachable failing input was established.
- Wrap-up calls `promptHoldingSlot` recursively, creating its own recording guard.
- `normalizeOptions` supplies the experiment default before dereferences.
- Treatment's regex concern assumes punctuation in symbols; both production
  producers restrict symbols to identifier characters.
- Treatment's P1 capability claim misses `roleTelemetry`'s explicit model-tools
  guard and the runner's configured backend capabilities. It was incorrectly
  confirmed by the verifier, as in the earlier experiment.

This is a latency improvement, not a precision fix. The model still misinterprets
missing caller context, even after verification. No new PR comments were posted
from these local trials.

## Local checks

- 1,119 deterministic tests, typecheck, lint, formatting and bundle build pass.
- The fake-process regression verifies actual Cline wrapper cancellation and PID
  reaping; queue tests verify cancelled/future auxiliary requests cannot dispatch.
- A live free-Muse cancellation settled 2.007s after abort.
- A Docker free-Muse review caught and verified the seeded job-loss defect.
  Executing the fixture returned 201 jobs before the change and only 100 after.
- Full updated-branch Docker review at `ac600a5`: 593.139s, 398/398 hunks and
  21/21 main tasks. The only retained candidate was the false capability claim,
  left inconclusive and therefore withheld from publication. This different
  revision/environment is a smoke test, not a paired latency estimate.
- Native Docker volume: UID 1001 got EACCES on a root-owned 0600 artifact before
  the run, then read the same file after the real pipeline rewrote it to 0644.
- The later `61421ed` edit only adds three paid model limit entries and checks
  their budgets; the free Muse execution path is unchanged. Its bundle and image
  were rebuilt. Cline/ClinePass catalog sections were refreshed through the
  existing generator's loaders; the original Docker/catalog assertion was retained.

Self-review covered process lifecycle, provider routing, page budgets, queue
ownership, complete delivery and the container/host artifact boundary. De-slop:
four comment blocks adjudicated: two kept (catalog provenance and chmod rationale),
two rewritten (workflow cache ownership and stale Cline-version test prose). Two new test cases kept
(process reaping and larger-page delivery); queue assertions folded into the
existing cancellation test. No new dependency or flag. The code, catalog, tests
and operational docs increment is +172 net lines; this audit and its measured
rows are additional evidence. Self-review found no new P1/P2 issue in this increment.

The advisory core corpus was not rerun. The required full-corpus default-policy
gate remains unmet; these local tests do not qualify the whole branch for production.
