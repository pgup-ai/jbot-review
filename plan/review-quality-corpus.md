# Review quality corpus and adjudication

The Phase 2 corpus is a benchmark-only safety gate. It does not alter prompts,
backend selection, review fan-out, filtering, verification, or GitHub posting.

## Corpus contract

`test/fixtures/review-benchmark/manifest.json` contains 100 synthetic cases:
50 seeded defects and 50 clean counterfactuals. Every pair has the same size
bucket, declared shape, file layout, and patch style. The corpus covers every
QLT-001 category and every diff-size bucket. Any fixture edit must update the
manifest corpus hash; the benchmark runner rejects drift before execution.

The committed manifest uses `fixtureMode: "replay"` for deterministic CI
contract checks. Real experiments copy that manifest, set `fixtureMode` to
`"git"`, run `${projectRoot}/src/local/index.ts` from `workspace`, and replace
the fixture model/config tuple with the exact provider configuration under
test. Git mode materializes each synthetic patch as isolated base/head commits,
expands its declared file, line, and byte shape, and exercises the normal local
dry-run review pipeline without GitHub posting.

Each defect records:

- the exact behavior that triggers the finding;
- the highest and lowest acceptable severity;
- implementation and cross-file evidence anchors;
- two acceptable semantic descriptions; and
- an interpretation that must not be accepted as evidence.

The `smoke` subset has 12 cases, `core` has 60, and `full` has all 100. Smoke
is a subset of core, core is a subset of full, and every case belongs to full.
Use `--subset smoke` for routine harness checks, `--subset core` for
optimization branches, and `--subset full` before changing default policy.

Private cases remain outside git. A local manifest may replace `fixturePath`
with `privateCaseHash: "sha256:<digest>"`; place the matching file at
`$JBOT_BENCHMARK_PRIVATE_CASE_ROOT/<digest>.json`. The runner verifies the file
before use. Repository cases still require immutable base and head SHAs.

## Historical outcomes and blind adjudication

Export bounded finding/evidence text with metadata and hashes to the history
importer:

```sh
npm run corpus:import-history -- \
  --input /path/to/signals.jsonl \
  --output /path/to/adjudication-batch
```

Addressed, resolved, and explicitly positive reactions become positive
candidates. Negative or confused reactions become negative candidates.
Conflicting signals and neutral replies require adjudication; reply presence
alone never implies acceptance. The importer keeps the finding and evidence
needed to judge the case, but discards treatment identity, model identity,
command text, and reply text from the blind file.

Ambiguous candidates require matching decisions from two distinct
adjudicators:

```sh
npm run corpus:adjudicate -- \
  --candidates /path/to/candidates.jsonl \
  --labels /path/to/labels.jsonl \
  --output /path/to/results
```

The command keeps disagreements separate. Do not add a disputed case to the
scored corpus until it is resolved, and do not tune prompts to fixture wording.

## Variance and competitor comparisons

The benchmark summary reports finding-set agreement and latency-relative
median absolute deviation for repeated runs. Three to five repetitions per
case are reportable; fewer or more are marked insufficient. Keep the control
unchanged across repetitions.

Competitor exports are normalized with `benchmark:normalize`. The adapters
accept benchmark JSON, GitHub review-comment JSON, or SARIF and do not invoke
or modify the competitor. Every export must include model, revision, endpoint,
reasoning, and sampling metadata for both control and competitor. Any mismatch
sets `rankingEligible` to false and is disclosed in the output.

Default-policy changes must pass the full corpus. Missing any seeded P0/P1 or
regressing precision or severity-weighted recall by more than two percentage
points fails the quality gate regardless of latency improvement.

Recall credit is fail-closed: a retained finding must carry an adjudicated
`expectedFindingId` and affirmative trigger/evidence checks in addition to an
allowed anchor and severity. Raw local or competitor output remains unmatched
until that semantic adjudication is supplied. Variance uses the adjudicated ID,
an adapter fingerprint, or the source anchor in that order, so title rewording
alone does not look like stochastic disagreement. Locationless SARIF results
remain unanchored false positives instead of disappearing from precision.
