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
