# Shared evidence reuse experiment

## Preregistered comparison

Continue the opt-in Jev experiment without replacing review or verification.
Code owns retrieval, freshness, budgets and caching; Jev only selects source
excerpts. All new switches remain disabled by default.

The comparison uses six arms: existing deterministic verification preparation,
shared host reads, shared reads plus OpenCode read-location handoff, those plus
bounded background prefetch, Jev selection on the same machinery, and persistent
reuse with consecutive cold/warm pairs. Exploration injection is off in every
arm, isolating verification preparation from the previous combined treatment.
Persistent caches are fresh per case/repetition. Model/provider prompt caches
are uncontrolled. Runs are serial, order is seeded within each repetition,
there are no retries or dropped failures, and the runtime is frozen before runs.

Full-pipeline cases are the existing clean and defective money-unit fixtures,
three repetitions each (42 trials including cold/warm pairs). The frozen
verifier case contains one real invoice conversion bug and one false claim
about an approval guard (21 trials). Frozen verification has no main-session
read observations, so its handoff arm is a negative control. Documentation is
omitted to avoid repeating the previous unsupported external-contract concern.

Success requires fewer seconds/model turns without losing the three known
defects, adding clean-case findings, or confirming the frozen false positive.
Report preparation/API time, source/disk reuse, unused prefetch, injected bytes,
model tokens, tool calls, verifier outcomes and estimated cost. Small synthetic
samples cannot establish general review quality or a default-policy change.

## Implementation boundaries

Source reuse checks tracked membership and regular-file identity, size, mtime
and ctime. Symlinks, untracked files and path escapes retain the existing guard.
In-flight requests can share inventory, source reads and exact symbol searches;
completed search results are not reused across mutable snapshots. Each caller
keeps its own cancellation deadline while waiting for shared work.

Handoff records only successful native OpenCode read locations. The verifier
receives current, guarded source excerpts with existing hashes/omission notices,
not reviewer reasoning or arbitrary tool output. Shell command parsing and
native-tool interception are outside this experiment. Background prefetch does
not delay verification or inject a packet by itself.

Persistent storage is operator-owned, outside the checkout and namespaced by
workspace. Index identity includes parser version, path, source hash and
truncation. Jev identity includes the exact request and pinned model; cached
responses are revalidated and record zero new API cost. Entries expire after
24 hours and are capped at 256 files of 256 KiB per workspace. Documentation
continues to use versioned operator snapshots without network crawling.

The TypeSafe [agent skill](https://docs.typesafe.ai/agent-skill),
[API reference](https://docs.typesafe.ai/api), and
[reranking cookbook](https://docs.typesafe.ai/cookbooks/rerank_typesafe) informed
the design. Raw candidate judgments are retained for replaying selection policy;
model output remains probabilistic and never decides finding disposition.

The advisory core quality corpus is separate from these targeted experiments;
no default-policy flip is proposed.

## Full-review results

Runtime: `0fa61c5`. All 42 processes exited zero. All 21 clean reviews retained no findings. All 21 defective reviews retained the three expected invoice/credit/refund double-conversion findings. Trial 21 (handoff) returned no verifier `verdicts` array; its three findings were retained as low-confidence unverified concerns. No failure was retried or excluded. Labels are manual, unblinded checks against the fixture contracts, not a corpus gate.

| Case   | Arm             | Mean s | Median s | Range s       | Main s | Verify s | Tools | Turns | Mean cost ($) |
| ------ | --------------- | -----: | -------: | ------------- | -----: | -------: | ----: | ----: | ------------: |
| clean  | baseline        | 11.302 |    4.843 | 3.775–25.288  | 10.304 |    0.000 |  1.67 |  1.67 |      0.004469 |
| clean  | handoff         |  8.662 |    7.789 | 4.735–13.461  |  7.663 |    0.000 |  5.00 |  2.33 |      0.005123 |
| clean  | jev             |  5.428 |    5.447 | 4.829–6.009   |  4.365 |    0.000 |  4.00 |  2.33 |      0.005140 |
| clean  | persistent cold |  4.549 |    5.076 | 2.610–5.961   |  3.382 |    0.000 |  1.33 |  1.67 |      0.004476 |
| clean  | persistent warm |  5.999 |    5.716 | 5.658–6.624   |  4.921 |    0.000 |  2.33 |  2.00 |      0.004770 |
| clean  | prefetch        |  5.924 |    5.964 | 5.545–6.264   |  4.921 |    0.000 |  3.00 |  2.67 |      0.005379 |
| clean  | shared          |  6.752 |    7.381 | 5.232–7.644   |  5.676 |    0.000 |  3.00 |  2.67 |      0.005379 |
| defect | baseline        | 24.267 |   24.730 | 23.293–24.778 | 16.812 |    6.340 | 10.67 |  5.67 |      0.011723 |
| defect | handoff         | 22.856 |   23.343 | 18.745–26.479 | 16.690 |    5.168 | 10.00 |  4.33 |      0.010533 |
| defect | jev             | 25.925 |   25.433 | 23.558–28.785 | 17.612 |    7.206 | 10.33 |  5.67 |      0.012203 |
| defect | persistent cold | 33.516 |   28.676 | 20.107–51.766 | 20.748 |   11.546 |  9.67 |  5.00 |      0.011438 |
| defect | persistent warm | 25.179 |   25.019 | 22.543–27.975 | 18.760 |    5.359 |  7.67 |  4.00 |      0.010601 |
| defect | prefetch        | 23.608 |   21.092 | 20.400–29.331 | 18.461 |    4.093 |  6.33 |  3.67 |      0.009956 |
| defect | shared          | 35.772 |   27.100 | 24.762–55.455 | 29.437 |    5.196 |  9.00 |  5.33 |      0.011186 |

Three repetitions per row. Clean-review prompt inputs are unchanged across these arms: verification never runs, and background prefetch injects nothing into main review. Their large timing differences therefore illustrate noise and provider/model variation, not demonstrated model-turn savings from these treatments.

| Defective arm   | Mean verification prep ms | Mean prefetch ms | Source hits | Source reads | Disk index hits | Jev cache hits |
| --------------- | ------------------------: | ---------------: | ----------: | -----------: | --------------: | -------------: |
| baseline        |                    107.00 |             0.00 |        0.00 |         0.00 |            0.00 |              0 |
| handoff         |                     23.00 |             0.00 |        5.00 |        15.00 |            0.00 |              0 |
| jev             |                    212.67 |            26.00 |       19.00 |        15.00 |            0.00 |              0 |
| persistent cold |                    205.33 |            35.33 |       19.00 |        15.00 |            0.00 |              0 |
| persistent warm |                    332.67 |            18.67 |       19.33 |        15.00 |           15.00 |              0 |
| prefetch        |                     12.67 |            27.33 |       19.00 |        15.00 |            0.00 |              0 |
| shared          |                     21.67 |             0.00 |        3.00 |        15.00 |            0.00 |              0 |

Baseline source-read counters are zero because its reads bypass the shared store; zero is not a claim that baseline performs no I/O. All warm persistent runs reused 15 indexes, but no full-review Jev responses were reused: generated finding text/candidate ordering changed the exact request. The warm total-time difference cannot be attributed to cache savings; warm verification preparation was actually slower on average, and provider cache state/order were uncontrolled.

All prefetch-enabled clean runs prepared 15 source files and reused none in host verification. Prefetching is wasted work when no findings need verification. It does not cache OpenCode native-tool results.

## Frozen-verifier results

All 21 runs returned both correct verdicts: confirm the invoice double conversion and refute the unapproved-credit hypothesis because the caller returns before reaching the processor. No unusable output, false confirmation or incorrect refutation occurred. Most runs needed one model turn and no tools; the warm persistent group included one extra exploration round.

| Arm             | Mean s | Median s | Range s     | Prep ms | Tools | Turns | Mean cost ($) |
| --------------- | -----: | -------: | ----------- | ------: | ----: | ----: | ------------: |
| baseline        |  3.646 |    3.294 | 3.068–4.575 |   69.33 |  0.00 |  1.00 |      0.003656 |
| handoff         |  4.874 |    4.347 | 3.339–6.935 |   20.33 |  0.00 |  1.00 |      0.003675 |
| jev             |  5.005 |    5.092 | 4.820–5.102 |  208.00 |  0.00 |  1.00 |      0.003926 |
| persistent cold |  4.031 |    3.537 | 3.461–5.094 |  210.00 |  0.00 |  1.00 |      0.003921 |
| persistent warm |  4.387 |    3.968 | 3.428–5.766 |   13.00 |  0.67 |  1.33 |      0.003891 |
| prefetch        |  5.319 |    6.359 | 3.181–6.416 |   13.00 |  0.00 |  1.00 |      0.003687 |
| shared          |  4.096 |    3.989 | 3.777–4.521 |   24.67 |  0.00 |  1.00 |      0.003659 |

All three warm persistent trials reused the exact Jev response and 15 source indexes. Jev cost and newly billed tokens were zero on those hits. Mean verification preparation fell from 210 ms cold to 13 ms warm, but mean verifier elapsed time increased from 4.031 s to 4.387 s. Exact replay works; the model still dominates wall time. Frozen elapsed time begins after backend startup; speculative prefetch overlaps that startup. End-to-end process timings in the raw results include startup.

## Interpretation

Keep all switches opt-in. Shared guarded reads reliably reduce host preparation work; handoff/prefetch remain plausible ways to avoid model turns, but this sample does not establish a dependable review-time improvement. The handoff mean includes an unusable verifier response. Adding Jev did not improve the defective-case mean over deterministic preparation. Persistent raw judgments are most useful for exact retries and offline policy analysis, not independently worded findings.

The existing provider prefix-cache/fork controls were not changed: sharing raw source keeps verification independent, while conversation forking carries reasoning and potential anchoring. Completed search-result reuse, native-tool interception, and automatic documentation fetching were deliberately excluded because this experiment cannot establish their freshness/quality contracts.

## Artifacts and validation

- `end-to-end/manifest.json` SHA-256: `ee7d7256a8522c43a2efc84df69efc58247abfdfa8959c1934286d302f5fec43`
- `end-to-end/results.json` SHA-256: `439087f5edd6d3dfe6be37cd4acae3db3fe02919b12656f59ac48e5f2fd476e1`
- `verification/manifest.json` SHA-256: `3659697a001fef25988485bdd0f90ecad2f7e4c33ab2b22e31e8a3fdb892995f`
- `verification/results.json` SHA-256: `e1494a67d41f730defb2587a611cfc24fa6b45b1655631d09f7590d886bd7dac`

Across both suites, 15 live Jev calls cost an estimated $0.004780; all model calls together cost approximately $0.416378. Provider-reported costs and pinned Jev input pricing are estimates. Full logs, packets' hashes, raw numeric scores, exact finding/verdict output and manifests remain ignored under `.jbot-review/jev-experiment-v5/`. No credentials or source bodies are in telemetry.

After freezing these measurements, the continuation corrects speculative text-log injection accounting, includes reuse switches (without cache paths) in the configuration fingerprint, reports selected read-location count, and includes unloaded observed files in the bounded omission notice. Candidate selection and source text are unchanged for these fixtures. The source-index cache now validates each entry once; this is cleanup, not a new ranking treatment.

## Repository preparation measurement

On `dae73b5`, five repetitions of each cold/warm preparation arm (30 preparations) used this repository's complete `origin/main...HEAD` diff. No model/API requests ran during this measurement. All preparations succeeded and produced the same selected-evidence hash and packet byte count. OS filesystem caches and JIT warm-up are uncontrolled; modes run in a fixed order. These are host-work measurements, not full-review latency results.

| Mode       | Cold mean ms | Warm mean ms | Warm persistent index hits |
| ---------- | -----------: | -----------: | -------------------------: |
| baseline   |        501.1 |        387.0 |                          0 |
| shared     |        211.0 |        129.4 |                          0 |
| persistent |        226.4 |        153.1 |                         63 |

Baseline warm reuses the previous parsed-index cache but still runs guarded source reads. Shared warm additionally avoids repeated file-content reads and per-file membership subprocesses. Persistent warm constructs a fresh store and reloads indexes from disk; source bytes are freshly validated/read, not persisted. Full-review savings remain limited by much longer model execution.

Local artifact: `.jbot-review/jev-experiment-v5/repository-cache.json`, SHA-256 `071244c291f54964469329f5e1cef1df0950e7b6332db0c797a5c271350c8e11`.

## Final dogfood and cleanup

The built `dae73b5` runtime reviewed the full branch locally in **180.333 s**.
Main review, guideline compliance and independent verification all completed;
no GitHub review was posted. Source code stayed fixed during the run; the
repository-measurement audit appendix was drafted while it ran and was not a
frozen document target. Artifacts are under `jev-experiment-v5/dogfood/`.

The single retained P3 identified a real telemetry defect: collector failure
built a deterministic fallback row and restored `mode` without restoring the
configured Jev model. Fixed by preserving `JEV_MODEL` for on/shadow failures;
API time and usage remain zero/absent when collection fails before any request.
The existing failure-path test now asserts both identities and zero API activity.
No paid rerun was needed for this telemetry-only correction; model inputs,
selection and finding disposition are unchanged.

The run captured one native read location; most exploration used shell reads.
Jev selected none of the handed-off locations in the final verification packet.
Of 64 prefetched files, eight were reused by host preparation and 56 were unused;
prefetch took 341 ms. Verification reused eight parsed indexes, parsed three
new files, and spent 261 ms preparing its packet, including 209 ms on Jev.
This validates plumbing and fallbacks, not a real-repository handoff speedup.

Self-review: no remaining P1/P2 issues found. Seams checked: guarded source
reading, mutable-worktree invalidation, operator cache ownership, exact request
identity, bounded observation handoff, verifier fail-open behavior, telemetry,
and default-off configuration. The advisory core corpus was not run; these
small targeted fixtures do not establish general review-quality non-regression.

Cleanup: removed duplicate persistent-index validation and unnecessary public
cache exposure. Two comment blocks were kept: unsupported syntax retains text
fallback; optional cache failure must not fail review. Four new tests were kept:

- Shared-read freshness catches same-size edits, removed tracking and symlink
  replacement; also checks concurrent request sharing and speculative logs.
- Handoff catches source-location transfer accidentally executing shell inputs
  or admitting escaped paths.
- Persistence catches stale/corrupt/model-mismatched judgments and rebilling a
  hit, while pinning content/task invalidation and index reuse.
- OpenCode callback integration catches copying tool output/reasoning or
  feeding verification history back into evidence selection.

Comments: 2 adjudicated — 2 kept, 0 rewritten, 0 cut. Tests: 4 adjudicated —
4 kept, 0 folded, 0 cut. Assertions were added to existing telemetry/failure
cases without weakening prior contracts. No dependencies were added this round.

Validation: 1,082 tests pass; typecheck, lint, formatting, build and
`git diff --check` pass. The credential scan reports no configured secrets in
the branch diff; `.env` remains ignored. All switches remain opt-in.

Net line delta since `3585943`: +981 across 18 files; no untracked source files.
