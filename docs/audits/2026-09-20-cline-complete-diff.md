# Complete diff coverage for Cline

This corrects the delivery failure documented in the [PR #228 dogfood audit](2026-09-19-pr-228-dogfood-coverage.md).
It is an unconditional correctness fix, independent of `JBOT_REVIEW_EXPERIMENT`.
No experiment or new tool permission is enabled by default.

## Contract

- Cline and Cline-pass receive every assigned textual patch, including late
  hunks. OpenCode's tool-less model fallback now follows the same rule.
- Existing byte-based file sharding and explicit shard counts still apply.
  Primary and retry prompts preserve every assigned patch. A tool-less main
  review cannot accept a truncated or omitted patch.
- Cline's final assembled prompt still must fit its 120 KiB argv limit.
  Oversized prompts fail before launching Cline, with an incomplete-coverage
  explanation and advice to increase `review-shards` or use a backend with
  repository tools. An identical oversized prompt is not retried. A single
  oversized file can still fail: this patch does not split a file's hunks.
- Failed main shards fail the review. Auxiliary failures remain explicit and
  fail open. Existing GitHub-omitted patch recovery and noise-file rules remain
  in place. Backends with repository tools retain bounded embedding plus access
  to recover omitted hunks.
- Logs report assigned, complete, truncated and omitted file counts plus diff
  bytes. Main coverage rows persist those counts under `diff`, including retries
  and cache reuse. These describe assembled input; the separate session state
  distinguishes a completed review from a rejected prompt.

## Live comparison

Native Cline **3.0.62**, model
`cline/cline-free/muse-spark-1.3-contributor`, six fresh CLI sessions. The fixture
is a new TypeScript ownership predicate after 1,000 comment lines, with
`return actorId !== ownerId` contradicting its owner-only contract at line 1004.
The source and patch came from a real Git repository. The control uses the old
12 KiB per-file truncation; treatment embeds the complete patch. Model, review
instructions, auth, fixture and tools-disabled policy are the same.

| Repetition | Old truncated input | Complete input | Seeded root, old → complete |
| ---------- | ------------------: | -------------: | --------------------------- |
| 1          |             23.790s |        15.478s | missed → found              |
| 2          |             11.447s |        16.825s | missed → found              |
| 3          |             20.953s |        11.192s | missed → found              |

Order was control/treatment, treatment/control, control/treatment. The diff
block grew from **12,443 to 64,305 bytes**. All six sessions completed; no repair
or retry was needed. Control found zero issues; treatment identified the seeded
inverted comparison in **3/3** runs. [Per-run data](data/2026-09-20-cline-diff-coverage.csv).

This deliberately simple fixture establishes that restoring missing code can
restore a finding. It is not a representative or blind recall benchmark, and
does not validate the model's P0 severity choice. Mean latency was 18.73s versus
14.50s, but this sample and uncontrolled provider caching cannot establish a
speedup. Complete input can also cost more tokens or time.

The real `runPrReview` pipeline then reviewed the fixture with verification
enabled and experiments off: **22.838s**, one retained root, main and verifier
completed, **zero incomplete sessions**. Main coverage recorded one complete
patch, zero truncated and zero omitted. This was local dry-run output; nothing
was posted to GitHub.

A local full-branch run pinned to one Cline shard exercised the other outcome:
65 assigned patches were assembled completely (486,107 diff bytes), but the
534,961-byte final prompt exceeded 122,880 bytes. The run failed in 112ms before
launching Cline and refused partial main-review coverage. Oversized auxiliary
prompts also failed explicitly. This is a working-tree snapshot during this
fix, not a successful full-branch Cline review. The first invocation accidentally
inherited the local legacy `PROVIDER=devin` pin and failed model selection;
clearing that pin produced the Cline result above.

## Cline tools investigation

Cline 3.0.62 returned valid JSON through ACP in a no-tools smoke test; the older
empty-turn observation is not a sufficient current reason to reject ACP.
However, `@symma/protocol` 0.7.0's shared review permission policy allows shell
execution and unknown tool kinds. The installed client has no strict per-tool
permission callback. Moving Cline onto that route would therefore require more
than changing the launcher.

The CLI's selective desktop-approval bridge was also tested from an empty
launch directory against a disposable repository. With isolated local state,
`read_files` returned **Desktop tool approval IPC is not configured** and no
approval request reached the bridge. Write attempts created no file, but failed
reads mean this was not a working read-only integration. Two earlier bridge
attempts without explicit isolated local state returned empty `run_result`
messages. None counts as successful tool access.

The current [CLI source](https://github.com/cline/cline/blob/main/apps/cli/src/runtime/run-agent.ts)
sets its active session after `start()` returns, while a non-interactive first
turn can execute inside `start()`. The [approval callback](https://github.com/cline/cline/blob/main/apps/cli/src/utils/approval.ts)
reads that active session ID; this is a plausible explanation for the observed
unconfigured bridge, not a separately patched upstream diagnosis.

Production Cline tools remain disabled. The image pin stays at 3.0.60: this fix
changes jbot's input construction, not the CLI contract, and 3.0.62 did not make
the tested selective-approval route usable. Safe reads/search, denial of shell
and unknown tools, and isolation from repository hooks/config still need a
supported integration before tools are enabled. Jev is not involved in either
permission enforcement or diff completeness.

## Validation and cleanup

- 1,105 tests, typecheck, lint, formatting and build passed.
- Regression tests cover Cline/Cline-pass routing, OpenCode tool-less fallback,
  late hunks across single/automatic/per-file shards, rejected truncation,
  UTF-8 argv accounting, oversized main failure without retry, and telemetry.
- Local `cline-pass/default` preview confirms zero truncated/omitted patches
  across eight shards; preview does not prove each assembled prompt fits argv.
- No packaging changes; no Docker rebuild required. No new hosted dogfood result
  is claimed here. The blind core-corpus benchmark was skipped while validating
  the concrete delivery regression; the advisory quality gap remains explicit.
- Self-review found no new P1/P2 issue in this correction. Seams checked: backend
  routing, model fallback, local preview, shard/retry input, auxiliary failure
  handling, cache identity and telemetry. Existing branch experiment findings
  and cleanup are recorded in the earlier audits.
- De-slop: four changed comment blocks — two rewritten (argv limit and ACP
  permissions), two cut (obsolete preview cap and Cline exception). Two new
  tests retained: late-hunk coverage and main failure before CLI launch; routing,
  byte accounting, retry classification and serialization assertions were folded
  into existing cases. Removed an unused optional helper parameter and redundant
  checks around required shard statistics.

Net tracked delta before this audit/data: +179 lines. New files: this audit
(132 lines) and CSV (7 lines).

Local raw artifacts remain under `.jbot-review/cline-coverage/`. SHA-256:

| Artifact                  | Hash                                                               |
| ------------------------- | ------------------------------------------------------------------ |
| `fixture.patch`           | `0f251fe9fbea8b52d5c63502f3f417c0c284bfb955b2bef9fb5ba4c473089373` |
| `experiment-results.json` | `853f647fcd1c545edb298e5bc245c0afaee3a115bc7f3debcae15abc29db177a` |
| `pipeline-result.json`    | `61d4c84a1b361945a2b1dc0486106475a8eccb5b153403f077ef80a4c2b12c17` |
| `branch-overflow.log`     | `107ec02bc2c2eb399f95ab3eae0095acba377f8552fd24937bb383c3d9722d70` |
