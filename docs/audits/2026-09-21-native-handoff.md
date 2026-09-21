# Native evidence handoff pilot

Passing relevant source from the reviewer to the verifier removed repeated
investigation in this fixture. Three matched pairs averaged **18.0s → 8.6s** for
verification. This is a verification-stage result on a small synthetic repository,
not a claim that whole PR reviews became 52% faster.

## What ran

CommandCode 1.56.2, `meta/muse-spark-1.3-contributor`, low effort, native tools.
One main review covered the complete diff and read six files. Its two findings
were held fixed for all verification calls, alongside two deliberately false
candidates. Each verifier used a fresh native session. Order was control/handoff,
handoff/control, control/handoff. Calls ran serially; provider caching was not
reset.

Both arms received the full diff and the existing `buildFindingSourceContext`
output, just as production verification receives cited source. The treatment
also received a 3,814-byte packet of native reviewer reads. No custom tools,
cached verdicts, additional model calls or production flags were added.

The experiment reads the native session journal after the reviewer finishes.
Only successful, single-file, numbered text reads that match the clean checkout
are eligible. It compares actual delivered line ranges, so overlapping reads
with different offsets still count. Search reuse counts exact grep/glob requests;
shell reads, multi-file reads and unsupported formats are not measured as source
overlap. Unsupported reads are counted separately. All reads in these runs were
supported.

The packet selects cited files and observed relative-import dependencies, with
at most eight excerpts, 2 KiB per excerpt and 16 KiB total. It records revision,
source hashes, complete/partial status and omitted files. It uses the existing
prepared-evidence prompt: source is untrusted data, further investigation remains
available, and previous conclusions are not evidence. Oversized excerpts are
omitted rather than silently shortened. Snapshot changes abort the experiment.

## Results

| Pair | Control | Handoff | Model turns | Native reads |
| ---- | ------: | ------: | ----------: | -----------: |
| 1    | 17.467s |  6.305s |       3 → 1 |        6 → 0 |
| 2    | 21.113s | 12.172s |       3 → 1 |        6 → 0 |
| 3    | 15.426s |  7.382s |       2 → 1 |        5 → 0 |

All **17 control reads** repeated lines already delivered to the main reviewer.
The treatment needed no tools. Mean cumulative input tokens fell from **45,490 to
17,538**, even though the assembled prompt grew from **9,137 to 12,953 bytes**.
Mean output tokens fell from 1,020 to 464. Building the ordinary source context
and handoff took 19ms, excluding journal extraction. The shared main review took
46.3s and is excluded from the paired verification timings.

Cache-read tokens varied: control/handoff were 27,618/113, 13,922/13,809 and 0/0.
The last pair improved with no reported cache hits in either arm. Fewer turns
and repeated reads are directly observed; the precise latency reduction still
includes service and generation variability.

Every run confirmed both real root defects and refuted both false claims:

- Passing an invoice ID to a capture-ID lookup breaks the fixture refund.
- Passing an owner ID to a tenant-membership check rejects its authorized user.
- The claim that missing invoices return undefined is false: the loader throws.
- The claim that membership ignores the user ID is false: it checks both IDs.

Local execution reproduced both defects and refuted both negative claims. The
generated authorization finding still carried an unsupported P0 severity and
overbroad language. These verdict counts establish the four root judgments on
this fixture, not correct severity or publication-ready wording.

An earlier bare-diff diagnostic also ran three pairs: 48.7/14.8s, 11.8/7.5s and
14.2/7.1s. It omitted production's cited-source block, so it is not the headline
comparison. One treatment still reread five files. Handoff guidance does not
guarantee that a model will avoid redundant reads.

## Reproduction and limits

`scripts/native-handoff-experiment.ts` takes a local JSON plan with `workspace`,
`base`, `head`, `model`, `effort`, `repetitions`, `timeoutMs`, `output`, and
`additionalCandidates` (an array of ordinary Finding objects, or `[]`). Point it
at a clean checkout of the requested head and a new output directory:

```sh
node --env-file=.env --import tsx scripts/native-handoff-experiment.ts plan.json
```

Put the pinned CLI on PATH and supply `COMMANDCODE_ACCESS_KEY`. The driver checks
the complete assembled prompt budget before each call. It saves manifests,
findings, verdicts, usage, native benchmark logs, read ranges and overlap counts
in private local files. It removes the CLI home, credentials and raw journals
on normal completion or caught failure. Saved packets and traces are private
local artifacts; selected excerpts also go to the configured verifier.

This run's artifacts are under
`.jbot-review/native-investigation/handoff-with-source-paired/`, with the plan in
`handoff-with-source-plan.json` and execution results in `handoff-ground-truth.json`.
The preliminary diagnostic is in `handoff-paired/`. Fixture base was
`717472c05049f02b3750a4089ee19e16fd37c7f8`, head
`0bbd2ba4aad97affb071b0dffa154c412726d17e`; these are local synthetic commits,
not commits in this repository. The manifest hashes both experiment scripts
and the diff. The full fixture and raw results are not committed.

The packet currently repeats some excerpts already present in cited-source
context. Its measured token benefit came from removing turns despite that
duplication. Next, compare only missing evidence on larger, historical cases,
including cases where the verifier must retrieve evidence outside the packet.
Do not infer cross-PR cache safety or broad precision from this pilot.

**Decision:** keep the handoff offline. The result justifies broader testing;
it does not justify a production default change or restoring unverified inline
comments.

Self-review found no P1/P2 issue. All 1,114 tests, typecheck, lint, formatting and
build passed. One new test checks stale/failed/outside reads, source-only handoff
and overlap deduplication. One catch comment was retained because unsupported
syntax must leave citation-based selection usable. No production prompt or
finding-disposition code changed; the full quality corpus was not run.
