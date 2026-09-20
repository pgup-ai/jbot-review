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
Older audits describe frozen revisions: their flags, telemetry versions and test
counts are historical, not current configuration or final validation claims.

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

## Consolidation validation

The selector was introduced at `9dd4639`; the final source revision is `8a32322`.
Both repository self-review and de-slop skills were reapplied against
`origin/main` at `2d8f923`. The pass removed the 13 environment readers and their
configuration documentation. It also fixed optional retrieval setup aborting the
main review, omission notices exceeding excerpt budgets, interrupted turns being
reported as completed, shared reads inheriting one caller's cancellation, and
byte offsets being mistaken for source lines. Research findings paths now resolve
before the child changes directory. The Docker smoke checks the retrieval bundle.

Four native OpenCode reviews ran through the compiled local entry at `8a32322`,
with every retired flag deliberately set to an active value, including unusable
cache/document paths. All processes exited zero, completed with no incomplete
sessions, and reported the expected resolved preset:

| Preset         | Retained seeded findings | Observed delivery                                                                                      |
| -------------- | ------------------------ | ------------------------------------------------------------------------------------------------------ |
| `off`          | Three P1 currency roots  | No linked packets or Jev API activity.                                                                 |
| `linked`       | Three P1 currency roots  | Two main preparation attempts; no eligible unseen packet, 19 candidate exclusions; no verifier packet. |
| `jev`          | Three P1 currency roots  | Three caller excerpts selected; Jev API time 152 ms; no linked packets.                                |
| `diff-batches` | One P1 currency root     | Two observed multi-file diff calls; no linked packets or Jev API activity.                             |

The initial smoke harness incorrectly required positive packet delivery from
`linked`; that assertion failed after the successful review above. The recorded
reads and exclusions show why this is not a valid activation requirement. The
failed harness/log was preserved, and only the two unstarted presets were then
run. At `9dd4639`, an earlier four-preset smoke did deliver two main packets in its
linked run, with zero verifier packets. Neither observation demonstrates saved
sequential reads. A separate seven-run verifier-driver smoke at `9dd4639` confirmed
the seeded defect and refuted the false hypothesis in every run; the handoff arm
is a negative control without a preceding source-reading session.

These are functional checks, not latency comparisons: one run per public preset,
different batching fixture, uncontrolled provider cache, and local Docker work
overlapping the checks. Raw reports, telemetry, manifests and the initial failed
assertion remain in `.jbot-review/preset-consolidation*/`.

Final source validation passed: all **1,099 tests**, typecheck, lint, formatting,
bundle build and diff checks. A configured-secret scan of 301 tracked files and
branch patch history found zero matches; `.env` is ignored, mode `0600`, with
the preset set to `off`. No credential value appears in the committed evidence.

The final `linux/amd64` slim image built, all five JavaScript entry checks passed,
and importing the retrieval bundle passed. Image ID:
`sha256:1de0e9766b27987255dbac2ecaeef99288b6bd41690639c5bda6fbfb668e9ed0`.
The CLI portion of `smoke-image.sh` failed twice at `opencode --version` with a
Bun 1.4.2 segmentation fault under QEMU; the same crash reproduced on the earlier
`9dd4639` image. Native OpenCode 2.0.5 completed the reviews above. This is not a
passed final container CLI smoke; no image was published.

De-slop: 10 TypeScript comment blocks kept for their existing boundary rationale;
the 10 previous configuration blocks became two rewritten blocks, with eight
cut. All 31 branch-added test cases were kept for distinct failures; no cases
were folded or cut, and existing assertions were preserved. Per-item verdicts
are in `.jbot-review/pr-publication/consolidation-*-adjudication.json`. The README alone removed 231 net lines. Historical research code remains
available to the driver.

Final tracked delta versus `2fb93cc`: 30 files, +757/-602 lines (155 net). No untracked publication files.

Residual limits: no independently blind core-corpus run, no repeated performance
comparison at the final revision, and the container CLI limitation above. The
research driver also remains intended for attended experiments: its per-review
budget is not an outer startup/teardown watchdog. These results do not support
enabling an experiment broadly in production.
