# Triage of 15 withheld candidates

Reviewed `unverified-findings.json` from [run 35563281897](https://github.com/pgup-ai/jbot-review/actions/runs/35563281897), job `106220086858`, against its head `97e762d`.

None of the 15 received a usable verifier verdict in that run. The first ten shared a 300-second Cline timeout; candidate 11 received no verdict; the late batch for candidates 12–15 returned no `verdicts` array. These outcomes mean verification was unavailable, not that the claims were disproved. Main review completed, but auxiliary coverage and verification were incomplete despite the successful Actions job.

## Source review

IDs below match the downloaded artifact. No runtime fix was justified by these candidates.

| ID  | Decision                  | Evidence                                                                                                                                                                                                                           |
| --- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| f1  | Not applied               | `roleTelemetry`, the only caller of `backendCanReadWorkspace`, separately checks `modelSupportsAgenticTools` for OpenCode. Model-specific workspace access is already accounted for.                                               |
| f2  | Not applied               | `sessionOptions` reads and parses the JSON file on every call. Deleting the label from one parsed object does not mutate the file or the retrieval callback's next object.                                                         |
| f3  | Not applied               | Auxiliary budget errors are caught by the addressed/summary/guideline/lens paths. `requestFindingVerdicts` catches verification errors and retains candidates as unavailable. Main coverage still fails closed.                    |
| f4  | Not applied               | `assembleReviewPrompt` defaults `lensAddendum` to `''`; its typed callers do not pass `null`. Omitting the lens is safe.                                                                                                           |
| f5  | Not applied               | The cited string only reserves space for a notice. `truncateUtf8WithNotice` emits the actual retained and omitted byte counts.                                                                                                     |
| f6  | Not applied               | Cline process scopes use the same labels supplied by lens dispatch, optional-session cancellation, and verifier dispatch. Cancellation tests cover matching labels and reaping.                                                    |
| f7  | Not applied               | `@symma/client` preflight rejects `freeSessions <= 0` before constructing the limiter. The proposed zero-capacity scenario is unreachable through this path.                                                                       |
| f8  | Applied to PR description | The summary and addressed-thread check are intentionally cancelled if unfinished when main completes. README's scheduling section already distinguishes them from finder pages. Clarified the PR description; no scheduler change. |
| f9  | Not applied               | `startLensPasses` calls `onFindings` once per completed page. Its aggregate continuation records coverage and returns findings; it does not call the callback again.                                                               |
| f10 | Not applied               | Budget `0` deliberately disables the run deadline. Infinite auxiliary grace implements that documented setting, not a new five-minute cutoff.                                                                                      |
| f11 | Not applied               | The workflow count is the `findings-posted` output. The review body builds its withheld count separately; this run itself posted the correct count of 15.                                                                          |
| f12 | Applied                   | Marked the earlier `off` recommendation as historical and linked current preset documentation, without rewriting the old experiment results.                                                                                       |
| f13 | Not applied               | `src/shared/evidence.ts` imports `@babel/parser` for runtime source analysis. It is not a test-only or unused dependency.                                                                                                          |
| f14 | Not applied               | The 201-to-100 job loss belongs to the deliberately defective benchmark fixture described in the publication-policy audit. `src/batch.ts` and `src/worker.ts` do not exist in the reviewed repository.                             |
| f15 | Known merge blocker       | The required full-corpus default-policy gate remains unmet, as the PR description already states. Targeted trials are not a substitute. This triage does not satisfy or waive that gate.                                           |

## Validation

Source tracing and 178 existing focused tests covered orchestration, prompts, role telemetry, process cancellation, plugin options, and gateway routing. The changes from this triage are documentation only; they do not change review inputs or finding disposition. No new corpus benchmark was run.

Free Cline Muse (`cline/cline-free/muse-spark-1.3-contributor`) re-verified all 15 candidates locally through `runClineFindingVerification`, using three sequential batches of five with source excerpts and caller context. All three returned usable verdict arrays in 38.502s, 46.539s, and 58.338s (143.379s total). There were 12 refuted verdicts, two uncertain (f1/f6), and one confirmed (f15, the known merge gate). The third batch read the corrected historical-audit wording, so its f12 verdict validates the correction rather than refuting the original report.

The source review resolves f1 through `roleTelemetry`'s model gate and f6 through `limitReviewBackend` forwarding the same `options.label` to execution and cancellation. These are manual conclusions, not successful model confirmations. Hand-selected evidence and one free-model trial do not establish general verifier accuracy or explain the hosted DeepSeek failure. Private transcripts and verdicts are in `.jbot-review/triage-35563281897/`.

Self-review found no new P1/P2 issue in this documentation change. De-slop removed the ambiguous current-tense recommendation. No code comments or tests were added or modified. The hosted verification failure and required full-corpus merge gate remain unresolved; this change does not claim otherwise.
