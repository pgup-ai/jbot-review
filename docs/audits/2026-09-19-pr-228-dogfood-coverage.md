# PR #228: dogfood coverage and reviewer comparison

The latest empty dogfood result was not evidence of a clean diff. Its Cline
sessions could not read the checkout, and most changed hunks were not embedded.
Earlier attempts also had runtime failures. These are concrete limits of this
comparison; the logs do not establish that one underlying model is worse.

## Runs inspected

This covers all five workflow runs on the branch through `ee5d4a5`, including
both attempts of the first run. Times are review-pipeline time, excluding image
build and workflow setup. Counts are raw finder candidates, before filtering.

| Head / attempt                                                                                  | Main / auxiliary backend        |   Time |                         Candidates | Outcome                                                             |
| ----------------------------------------------------------------------------------------------- | ------------------------------- | -----: | ---------------------------------: | ------------------------------------------------------------------- |
| [2fb93cc / 1](https://github.com/pgup-ai/jbot-review/actions/runs/35480207182/job/105996538884) | Cline DeepSeek / Cline DeepSeek | 808.7s | Main failed; compliance reported 3 | Both main attempts hit the model output-token limit; nothing posted |
| [2fb93cc / 2](https://github.com/pgup-ai/jbot-review/actions/runs/35480207182/job/105999320323) | OpenCode Muse / Cline DeepSeek  | 679.9s |              2 main + 1 compliance | 3 unverified concerns posted; interactions pass abandoned           |
| [ff350a6](https://github.com/pgup-ai/jbot-review/actions/runs/35482093056/job/106001602529)     | CommandCode Muse / Cline Muse   | 148.1s |                             1 main | Verification failed with `spawn cline ENOENT`; concern still posted |
| [c4d310a](https://github.com/pgup-ai/jbot-review/actions/runs/35483146870/job/106004465915)     | Cline Muse / OpenCode Muse      |  95.0s |                                  0 | Main, interactions and compliance each returned zero                |
| [d4b115f](https://github.com/pgup-ai/jbot-review/actions/runs/35483467989/job/106005357172)     | CommandCode Muse / Cline Muse   | 101.4s |                                  0 | Main, interactions and compliance each returned zero                |
| [ee5d4a5](https://github.com/pgup-ai/jbot-review/actions/runs/35485719468/job/106011590145)     | Cline Muse / Cline Muse         |  57.5s |                                  0 | Main, interactions and compliance each returned zero                |

The runs selected both roles from a five-model pool, so they are not controlled
comparisons. All used one main shard, one interactions lens, and a guideline
pass. All had Jev, evidence reuse, linked evidence and diff batching disabled.
`maxFindings=0` and `minSeverity=nit` imposed no publication count/severity cap.
Context7 was unavailable because no key was configured.

## The largest coverage gap

At `ee5d4a5`, the log reports 57 reviewable files and a 42,987-byte diff block.
Reconstructing that block from the committed three-dot diff, the existing noise
filter and `buildDiffHunksBlockWithMetadata` reproduces the byte count exactly:

- `package.json` is the only complete file patch.
- Four patches are truncated: `scripts/jev-prefetch-experiment.ts`,
  `src/shared/evidence.ts`, `src/shared/jev-prefetch.ts`, and
  `src/shared/review-retrieval.ts`.
- The other 52 file patches are omitted and listed for retrieval. Their absence
  from this block does not mean their filenames are absent from the prompt.
- The driver excerpt stops inside the `runCliProcess` argument list. The later
  `if (logError) throw logError` and result persistence code are not included.

All three finder roles at that revision used Cline. `buildClinePromptArg` adds
`NO_TOOLS_REVIEW_DIRECTIVE`, which prohibits file reads, searches and Git
commands. `backendCanReadWorkspace` correctly reports Cline as embedded-only,
but `backendRequiresCompleteEmbeddedDiff` excludes it, so the runner still
uses the normal 40 KiB total / 12 KiB per-file diff budgets. Omitted hunks cannot
be recovered. These routing functions and the Cline directive predate this PR.

This explains why the current late-log-flush defect was unavailable for an
independent code check in the latest finder input. Earlier review bodies can
appear as untrusted claims, but are not a replacement for the missing code.
It does not prove that supplying the code alone would make a model find it.

CommandCode was also configured without repository tools in both of its runs,
but it received complete diff blocks instead: roughly 435/443 KB of diff and
492/501 KB final prompts. That is a different limitation: a large single
context without follow-up investigation. Attention dilution is plausible, but
the runs do not isolate it as the cause of their misses.

## What fewer comments means here

The last three runs had zero candidates from every finder and skipped finding
verification. No downstream confidence gate, severity filter, deduplication or
prior-thread suppression removed hidden findings in those runs. Earlier broken
verification also preserved findings as unverified concerns, as intended.

The first successful attempt spent 172.5 seconds on its OpenCode main review,
then 427.5 seconds waiting for auxiliary work and 73.8 seconds on late
verification. Its three concerns comprised one valid optional-docs failure and
two claims rejected during PR feedback review. The next run repeated the docs
failure. Four J-Bot comments therefore represented three hypotheses, with one
validated defect, not four independent bugs.

At the investigation snapshot there were 54 review threads: 32 Cubic, 16 Qodo,
4 J-Bot, 1 Greptile and 1 CodeRabbit. Of the 50 non-J-Bot threads, 14 had explicit
`Not applied` replies; others included repeated findings, documentation fixes
and test suggestions. The current three open threads themselves describe one
late-flush bug twice and its missing test coverage. Comment totals are not a
recall metric. Even after that qualification, useful runtime findings from the
other tools show real misses, including source-budget overflow, shared-promise
rejection handling and experiment-process lifecycle errors.

Cubic's latest submission reviewed four files from the newest commits; J-Bot
reviewed the full 57-file PR in one main shard. Both scope and tested revision
must be held constant for a meaningful quality comparison. Some comments were
also already available in prior review bodies, so this was not a blind benchmark.

## Recommended next experiment

1. Fix the Cline coverage contract first: every assigned patch must be fully
   supplied to a tool-less session, or the run must report incomplete coverage.
   Account for its existing 120 KiB argv limit by sizing complete shards or
   choosing a backend that can retrieve omitted code. Simply removing the diff
   cap would exceed that limit on this PR. Preserve full-diff union coverage.
2. Pin a main and verifier backend with working read-only repository access.
   Use the existing shard setting to compare one shard with automatic sharding;
   keep the same model, revision and budget. Fix the observed Cline launch
   failure before using that verifier as a baseline.
3. Re-run validated misses at the revisions where they existed, with three
   repetitions and blind adjudication. Count unique confirmed defects, false
   positives, missed roots, incomplete sessions and latency; retain the existing
   fail-open verification behavior.
4. Only then compare retrieval/Jev treatments. They were disabled in these runs,
   and the current results cannot establish their effect on speed or quality.

This feedback patch fixes late log failure persistence and folds write/flush
failure injection into the existing driver regression. The flush case failed
before the fix because `results.json` was absent. The broader pre-existing Cline
coverage defect remains a follow-up; this patch does not change model inputs or
review defaults. The advisory blind core-corpus gap remains unchanged.

Evidence: the linked job logs and each run's uploaded `jbot-review-telemetry`
artifact. Local raw downloads, extracted log evidence and exact diff
reconstruction are retained under `.jbot-review/pr-feedback-round3/`.
