# Selective advisory verification: live comparison

One sequential run per arm on frozen frontend PR #2235, head
`cba6fb487af0c95e833deb016844fb9b578a0e55`, base
`1c16ccd08013f95c3ee683971dfdb80283cb58b4`:

- Before: pre-Friday `5b5cfd2`.
- After: `b048976535ce19ffe0e2b58b0e152d6c5d63c9bc`.
- Both: `opencode/muse-spark-1.3-contributor-free`, local OpenCode 1.18.26,
  identical npm dependencies, 11 changed files, three automatic main shards,
  concurrency three, two review passes, verification enabled, 30-minute budget,
  context trimming off, no Context7 key. Local mode has no prior GitHub threads.
  This differs from the consumer's one-shard container execution.

| Measurement                |         Before |          After |
| -------------------------- | -------------: | -------------: |
| Driver wall time           |        350.1 s |        627.7 s |
| Main execution             |        225.7 s |        217.0 s |
| Wait after main            |        120.0 s |        280.6 s |
| Verification               |            0 s |        128.8 s |
| Main findings              |              0 |              1 |
| Lens completion            | Both abandoned | Both completed |
| Retained findings          |              0 |           2 P2 |
| Reported input tokens      |         15,630 |         13,475 |
| Reported cache-read tokens |        276,932 |        567,575 |
| Reported output tokens     |             82 |          1,440 |
| Reported reasoning tokens  |          3,624 |          9,970 |

Both arms encountered an upstream `rate_limit_exceeded` retry in interactions.
The before arm lacks final usage for its abandoned lenses. Provider cache state
was not controlled; token totals and wall time are not a causal estimate of the
new policy. The treatment also includes intervening changes since Friday.

Manual spot-check of the treatment's retained findings did not establish two
valid P2 defects. One identifies a plausible stale-edit-mode UX concern, but
submission is guarded and reload is explicit; severity needs further adjudication.
The other claims invalid BigNumber input throws. The installed dependency instead
returns NaN, with equality false, for empty, undefined, null, and nonnumeric values.
Its alternative malformed-stored-date premise was not established. These were
model-confirmed findings, not independently confirmed defects.

The five-minute grace allowed both lenses to finish, but this run was slower than
pre-Friday. No local-suggestion exemption was exercised. This is an operational
comparison, not a recall/precision benchmark or evidence to enable a new default.
The required full corpus, repeated runs, and blind adjudication remain outstanding.

Validation: 1,024 tests, typecheck, lint, formatting, and build passed. Self-review
added guards keeping cited cross-file and external-API claims in verification.
De-slop kept one new regression case, updated existing verdict/grace cases, kept
one field-contract comment, and removed one stale selector comment.

## Review follow-up

The selective-verification treatment above was withdrawn after review. A matching
quote and model-supplied classification cannot establish that an entire advisory
contains no external or runtime claim. All findings remain eligible for
verification, and uncertain advisories retain their unverified status rather than
being dropped. The five-minute auxiliary settling limit remains.

The timings above describe the recorded treatment commit, not the revised branch.
No new live comparison or full-corpus benchmark was run for this follow-up.

Follow-up validation: 1,023 tests, typecheck, lint, formatting, and build passed.
The exemption test was removed with the exemption; the existing uncertain-advisory
test now checks both verdict application paths. Self-review found no remaining
P1/P2 issues in the revised diff.
