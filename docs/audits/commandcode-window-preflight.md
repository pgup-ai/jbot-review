# CommandCode window preflight and dogfood scheduling

## Exhausted key selection

[Depot attempt 893dwdtv35](https://depot.dev/orgs/sr28q68rf1/workflows/92hdkcx8g6/jobs/bm5xnkt3s0?attempt=893dwdtv35)
failed after preflight had already reported all three keys as window-limited:
two had exhausted their weekly allowance; the third had used 14.1 of its
14 five-hour credits. Selection fell back to that third key because it still
had weekly headroom. Every CommandCode session rejected it, including the retry.

Selection now requires monthly credits and available five-hour/weekly windows.
Either an exceeded flag or usage at/above the cap excludes a key. If none qualify,
preflight stops; if all probes fail, it stops rather than guessing. Existing
uncapped-window handling and weekly-headroom ranking remain unchanged.

The local live probe reproduced the same three blocked keys and rejected them
before launching a session. Existing tests cover mixed eligible/exhausted keys,
the three-key failure, single-key selection, numeric caps with a false exceeded
flag, purchased credits and unavailable probes. No model prompt changed. Other
runs can still consume a shared allowance after preflight; this is not a quota
reservation.

## Dogfood scheduling

[Run 35751774196](https://github.com/pgup-ai/jbot-review/actions/runs/35751774196/job/106827463412)
used the configured five-session cap. At 16:08:46 UTC, four Cline GLM main shards
and an OpenCode MiMo changes-summary session occupied all five slots. Interactions
queued for 18.2s after context preparation and started at 16:09:06 when the summary
released its slot. It did not wait for the main result or use the summary output.
Guideline compliance shared the interactions session. Verification depends on
candidate findings; these independent finder passes do not.

The run failed after 1,472s: main shard 2 lost its connection after 1,205.9s and
its retry timed out after another 257.2s. Delivery was 46/52 hunks and 3/4 tasks,
so no partial review was posted. Interactions ran for 1,383.0s including successful
MiMo wrap-up. Its trace contained 90 tool calls, 20 turns and 67,848 reasoning
tokens before wrap-up. These are not an isolated measure of tool latency.

No scheduler change was made. Removing the short initial queue would not explain
or resolve the long model sessions and the failed mandatory shard.

## Validation

All 1,125 tests passed, as did typecheck, lint, build and formatting checks. A
local native OpenCode free-Muse review completed in 25.0s, delivered 9/9 hunks
across the three changed code/documentation files, and returned no findings;
guideline compliance also completed. This audit file was untracked during that
run and was reviewed manually. The model review does not exercise CommandCode
billing; the separate live three-key probe does. No quality-corpus run was needed
for this preflight-only change.

Self-review found no remaining P1/P2 issue. De-slop removed four stale test
comments and added no new comment blocks or test cases; the existing tests were
updated for the stricter eligibility contract. No setting or dependency was added.
