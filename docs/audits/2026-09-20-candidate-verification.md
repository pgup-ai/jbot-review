# Candidate verification and recovery

An emitted candidate already entered verification when enabled and within the
remaining budget. The old “unverified” label mixed an inconclusive verdict with
a failed or missing check. A separate bug meant that even `confirmed` left an
investigation candidate's original kind/confidence unchanged, so the publication
guard still withheld it.

## Change

Finders may retain a concrete suspicious change with a plausible trigger/impact
and a specific missing fact. Generic requests to inspect callers/imports remain
excluded. These candidates use the existing verification batches and bounded
source loader; no second model pass, retry loop, repository scan or flag was added.

A tentative candidate needs an evidence-backed confirmation containing its
factual title, severity, kind and a verbatim supplied-source quote. The verifier's
reason becomes the published explanation. Code preserves the original anchor,
checks the quote against source rather than PR prose, and keeps malformed or
unsupported confirmations unresolved. Ordinary verification prompts are
byte-for-byte identical to control, in both toolful and single-shot modes.

Unresolved candidates remain in `unverified-findings.json`, pinned to the reviewed
head, with `inconclusive`, `not-completed` or `not-verified` status. The dogfood
workflow uploads this explicit file and telemetry with hidden-file inclusion;
it does not upload the whole directory. The count-only PR notice links to the
run's artifacts. Other deployments must arrange their own artifact upload;
local files and logs still retain the details. Upload failure is nonfatal.
This follows the [upload-artifact hidden-file contract](https://github.com/actions/upload-artifact#uploading-hidden-files).

Arena output excludes unresolved details and speculative summaries. Action and
worker publication counts exclude them; worker coverage remains incomplete while
verification is unresolved. The diagnostic/local benchmark result retains them.
`diff-batches` remains the default and `adaptive` remains opt-in.

## Measurements

[Sanitized rows and hashes](data/2026-09-20-candidate-verification.json) retain
all cohorts, including unsuccessful variants. Control is `eb32d02`. Drivers and
raw logs remain gitignored under `.jbot-review/candidate-recovery/`; they are not
a committed reproduction interface. Durations are wall-clock observations,
not cost or token measurements.

Three alternating verifier pairs per variant used CommandCode CLI 1.44.0,
`commandcode/meta/muse-spark-1.3-contributor`, provider-default effort and no tools.
Every call received the same four tentative claims and decisive supplied source:
two historical false claims, a true 201-to-100 job-loss defect, and an unknown
production environment value. The production batch/request/parser/filter path
ran once per arm; fixtures contain no provider credentials.

| Variant                               | True defect published, control → treatment | Average time, control → treatment |
| ------------------------------------- | ------------------------------------------ | --------------------------------- |
| Full replacement (`4590523`)          | 0/3 → 3/3                                  | 26.861s → 41.717s                 |
| Compact fragment (`9da98e0`)          | 0/3 → 2/3                                  | 20.501s → 26.729s                 |
| Required complete example (`e95195e`) | 0/3 → 3/3                                  | 23.235s → 26.839s                 |

Control confirmed the true defect in all pairs but never promoted it. The compact
fragment omitted its required confirmation object once; the final prompt places
a complete conditional example near the output reminder. Final treatment refuted
both false claims in all three trials and kept the environment question uncertain;
control left the import claim uncertain once. Neither arm published a false claim.

The final candidate batch averaged **3.604s more (+15.5%)**, with one call per arm.
This is recovery of useful findings at a measured extra cost, not proof of a free
speedup. Three trials cannot establish reliability across models or PR sizes.

A separate production-runner fixture used Cline CLI 3.0.62, Muse, requested low
effort, concurrency three, two review passes, guidelines and verification,
`diff-batches`, and dynamic fan-out disabled. GitHub state was a read-only local
fixture; nothing was posted. The defect drops 101 of 201 jobs; its clean control
only renames a local variable and preserves behavior.

| Pipeline cohort             | Average defect duration | Average clean duration | Executions per run           |
| --------------------------- | ----------------------- | ---------------------- | ---------------------------- |
| Three pairs, `4590523`      | 28.266s → 30.539s       | 8.785s → 8.834s        | 3 defect; 2 clean, both arms |
| Final smoke pair, `e95195e` | 26.141s → 21.110s       | 12.527s → 10.159s      | 3 defect; 2 clean, both arms |

Both arms caught the known defect and produced zero findings on clean inputs in
every pipeline trial. Every run delivered 1/1 hunks with no incomplete tasks.
The final smoke validates the final path; its single pair is not a speed estimate.
The actual treatment artifacts were inspected: schema version 1, matching fixture
head and an empty candidate list in these conclusive runs. Unit tests cover the
nonempty statuses, preservation of details, failed batches and PR artifact link.
Hosted upload/posting of this revision remains unvalidated locally.

## Self-review and limits

Self-review: no remaining P1/P2 issue found in this increment. Seams traced:
verifier prompts and parser, both verdict-application paths, source validation,
publication routing, diagnostics, workflow upload, local/Arena serialization,
Action count and worker coverage. The external Arena service itself was not run.

De-slop: removed duplicate confirmation body/path/confidence fields, restricted
extra prompt text to tentative batches, reused the existing source loader and
publication predicate, and removed an accidental unrelated assertion argument.
One modified comment block was kept: it explains why empty worker counts cannot
imply a clean result. Three new tests were kept for distinct failures: confirmed
candidates staying withheld/relocating, invented source quotes being published,
and loss or mislabeling of diagnostic candidates. Other assertions extend
existing tests. No dependency or public flag was added. Excluding these audit
artifacts, the increment adds 433 lines and removes 44 (net +389).

Validation: 1,117 tests passed, plus typecheck, lint, build, formatting and diff
checks. After the final assertion cleanup, the report tests passed again. Added
confirmation text remains subject to the existing assembled-prompt budget.

**The required full-corpus default-policy gate remains unmet.** The advisory core
corpus was not rerun. These targeted trials do not qualify the entire branch for
production or establish general precision/recall. Confirmation still depends on
model judgment; a matching quote is necessary for promotion, not proof by itself.
Candidates needing unavailable external state remain explicitly unresolved.
