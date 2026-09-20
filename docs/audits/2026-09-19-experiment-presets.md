# One experiment selector and the production decision

## Decision

Use `JBOT_REVIEW_EXPERIMENT=off` in production. None of these experiments has
demonstrated a repeatable total-review speedup with sufficient quality evidence
to recommend broad enablement. `diff-batches` is the strongest candidate for a
controlled canary because it reduced delivered text while preserving the seeded
defect on the tested workload. That is not proof of faster reviews.

The former 13 controls were independent research variables. Exposing all of them
as runtime flags let operators assemble combinations that had never been tested.
One selector now chooses a measured treatment:

| Preset         | Exact treatment                            | Production decision                                               |
| -------------- | ------------------------------------------ | ----------------------------------------------------------------- |
| `off`          | No branch-added experiment                 | Recommended.                                                      |
| `diff-batches` | Omitted-diff command batches only          | Canary candidate; no proven total-time gain.                      |
| `linked`       | Linked read evidence in main sessions only | Keep experimental; mixed quality and timing.                      |
| `jev`          | Original caller-excerpt ranking only       | Keep experimental; inconsistent latency and low known-bug recall. |

No preset combines these treatments. Removed environment variables are ignored,
including cache/document paths; explicit `off` is sufficient even with a stale
`.env`. The credential remains `TYPESAFE_API_KEY`, needed only by `jev`.
The detailed ablations still run through the research driver's explicit typed
settings, recorded as `custom`. They are not production configuration aliases.

## What actually helped

Results below are historical observations at the linked audits' frozen revisions.
The current preset refactor does not turn them into a new performance benchmark.

| Direction                   | Measured benefit                                                                                                                                                                             | Counterevidence / limitation                                                                                                                                                                                                                  |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Diff batching               | Mean tool-output bytes **49,868 → 27,868 (−44.1%)**; uncached input **72,320 → 70,644 (−2.3%)**. One billing root caught **3/3 repetitions in each arm**, zero retained clean-case findings. | Mean total **24.36s → 24.51s**; median **22.70s → 24.90s**. Both arms already batched reads. Two artificial fixtures, six reviews per arm; no general quality or speed claim.                                                                 |
| Main-only linked delivery   | Mean total tool calls **9 → 8**, main turns **75 → 65** across 18 reviews. Confirmed seeded roots **13/15 → 14/15**.                                                                         | Main tool calls were **106 → 105**; much of the total-call reduction occurred in the unmodified verifier. Mean total **16.64s → 15.85s**, but median **11.78s → 15.35s**. Treatment missed one root and emitted one clean-case finding.       |
| Jev caller ranking          | On historical PR #128, mean estimated cost **$0.037909 → $0.031840 (−16.0%)** and cheaper in all five paired repetitions. Mean pipeline time **129.37s → 108.83s**.                          | Faster in only **2/5 pairs**; median paired full-command difference was **+8.2s**. Known-bug recall was **0/5 baseline, 1/5 Jev**. On PR #148 Jev was slower than deterministic preloading on average; no reliable general speed/quality win. |
| Shared host reads           | On this repository, cold evidence preparation **501.1ms → 211.0ms**; warm **387.0ms → 129.4ms**, with identical selected packets.                                                            | Five repetitions per arm in fixed order; OS/JIT state uncontrolled. This reduced subsecond preparation work, not demonstrated model turns or total-review time. Research-only.                                                                |
| Exact Jev response cache    | Frozen verifier preparation **210ms cold → 13ms warm**, with zero newly billed Jev tokens on all three warm hits.                                                                            | Mean verifier time still increased **4.031s → 4.387s**. Full-review requests had zero Jev cache hits because generated findings changed the request. Research-only.                                                                           |
| Generic tool-result caching | No demonstrated saving to graduate.                                                                                                                                                          | Across 82 fully observed calls in two repository profiles there were zero identical request/result repeats. This does not rule out other workloads; it does not justify another production cache.                                             |

Sources: [phase and diff-batching audit](2026-09-19-evidence-phases-and-diff-batches.md),
[all 86 latest per-run rows](data/2026-09-19-evidence-runs.csv),
[30-review historical-PR comparison](2026-09-19-jev-real-pr-comparison.md),
[shared/persistent cache measurements](2026-09-19-shared-evidence-cache.md),
and [tool-repeat profiles](2026-09-19-tool-reuse-investigation.md).

The full-branch batching pair also contradicts a blanket speedup claim:
**206.73s → 289.49s**, with main time **181.46s → 179.82s** and verification
**24.22s → 108.60s**. Different findings and model generation are confounders;
one pair cannot establish that batching caused the verifier tail. It does show
why less tool output cannot substitute for measuring total time.

All four arms in the 72-review phase comparison failed at least one preregistered
quality criterion, including the baseline. The 37 verifier sessions were
parseable, but earlier malformed outputs remain in their original experiments.
Quality labels were manually adjudicated and not independently blind. No
qualifying core-corpus gate or default-policy promotion is claimed.

## Turning a canary on and off

On a checkout/image containing this code, with the normal provider/model settings:

```sh
JBOT_REVIEW_EXPERIMENT=off npm run review:local -- --base origin/main
JBOT_REVIEW_EXPERIMENT=diff-batches npm run review:local -- --base origin/main
```

Set the same variable on a hosted review process to select that preset. Returning
it to `off` disables the treatment. The published Action's `latest` image does
not acquire this branch's code simply by selecting the branch in `uses:`.

Before recommending any treatment for production, compare the same real PRs,
models and review settings in randomized repeated runs. Preserve all failures
and slow rows. Adjudicate findings before comparing total/phase latency, turns,
uncached tokens and cost. Require a repeatable total-time benefit without missed
confirmed defects or added unsupported findings; the advisory core corpus is
still outstanding. Enabling a default additionally requires the repository's
full quality gate. No existing result above meets that adoption standard.
