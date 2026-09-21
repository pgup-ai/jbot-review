# Packed handoff in CommandCode verification

Packed handoff is now enabled by default for the CommandCode native-tool backend.
Jev remains off under the default `diff-batches` preset. Set
`JBOT_PACKED_HANDOFF=false` to roll back the handoff without changing native tools,
main-review scope, verification or publication rules. Other harnesses are unchanged;
a CommandCode verifier only receives handoff evidence when preceding CommandCode
review sessions observed it.

The transcript observer used in the local experiments now lives in
`src/shared/native-evidence.ts`. Each run owns one bounded store; there is no
cross-run cache. Successful reviewer sessions contribute supported native reads
and grep results, validated against tracked source. Before verification, the store
revalidates files, subtracts source lines already supplied, and packs relevant
excerpts into the existing 6,000-byte format. It makes no Jev request. Source
hashes, partial-file labels and omission notices remain in the packet.

Missing/unsupported journals, stale files and preparation errors fall back to
normal cited source and native investigation. Optional evidence is dropped when
the complete assembled prompt would exceed the model/transport budget. Preparation
is skipped near the verification deadline and its elapsed time is charged against
the existing timeout. Repair and formatting sessions remain tool-less.

The initial local integration run found a selection gap: production reviewers can
use the embedded diff for changed files and read only their dependencies. Relevance
now follows imports from the cited files even when those files had no native read.
Only observed dependency lines enter the handoff; reading the cited file for import
resolution does not make unobserved lines eligible. A regression test covers this
path and stale-source rejection.

## Local production-path checks

The checks invoke `src/local/index.ts`, which runs the real `runPrReview` pipeline
with no GitHub posting. Both use the unchanged two-file dependency fixture from
[the packing experiment](2026-09-21-handoff-packing.md), CommandCode 1.56.2,
`commandcode/meta/muse-spark-1.3-contributor`, low effort, one main shard, normal
verification, native tools and the default `diff-batches` preset. The session cap
is three. Native API caches are not reset. These are functional checks, not a
matched latency benchmark or general quality gate.

With handoff enabled, all two assigned hunks completed. The main reviewer observed
10 files; verification received seven excerpts, 3,080 bytes, after removing nine
duplicate lines. Preparation took 4ms. Verification completed in three native
model turns, retained both seeded root defects and left no incomplete sessions.
The Jev log reported `mode: off`, `status: disabled`, zero request bytes.
The model still assigned P0 to the two fixture defects; these checks do not validate
severity calibration or establish publication-ready wording.

With `JBOT_PACKED_HANDOFF=false`, the log contained no handoff observation or
injection entries. Both seeded roots were retained after verification, both hunks
completed, and no sessions were incomplete. Jev was disabled in this run too.

Private local artifacts: `/tmp/jbot-packed-production-final.log` and
`/tmp/jbot-packed-production-final.json`; rollback artifacts use the same names
with `off` instead of `final`. The earlier diagnostic is `jbot-packed-production-on`.

## Validation and limits

The full quality corpus was skipped at the user's explicit request for this change.
The small local checks do not substitute for its precision/recall gate. Production
CI/dogfood behavior has not yet been validated on this revision.

All 1,115 tests, typecheck, lint, formatting and build passed. Self-review found no
P1/P2 issue after correcting the embedded-diff relevance gap. De-slop reuses the
existing transcript lookup and byte packer; it promotes the experiment observer
rather than maintaining a second implementation. The new store test is retained
because it catches missing dependency delivery when the anchor was only embedded,
and stale evidence after a file changes. No new TypeScript comments were added;
the existing unsupported-syntax catch comment moved with the observer. The two
new `.env.example` lines document the rollback beside native-tool configuration.

Current CommandCode documentation describes JSONL exports, but does not establish
a stable contract for this internal journal shape. The pinned 1.56.2 native reads
and grep results were verified locally; unsupported future formats fail open to
normal verification rather than being guessed into evidence.
