# Native verification recovery

OpenCode verification gets one recovery attempt using the same model, settings
and native read-only agent. It forks the collected history and asks the model to
reuse prior reads, answer only concrete unresolved questions, and return verdicts.
Completed judgments cannot be overwritten. Insufficient evidence stays uncertain;
a failed recovery preserves any completed verdicts.

A five-minute verification budget reserves its final minute for recovery. Early
format repair uses at most that minute too. Recovery session setup shares that
deadline. Unbounded runs skip recovery. There is no model-name exclusion, separate
model flag, automatic paid fallback, or custom tool implementation. JSON repair
and final formatting retain their existing tool-less behavior.

Native tool access can spend more of the recovery budget investigating; the
prompt is guidance, not a guarantee of zero further exploration. Authentication,
quota and generic provider errors do not trigger recovery.

## Local evidence

The fixture contains two seeded bugs (100x overcharge and owner/tenant confusion)
and a false claim that an audit call is absent. OpenCode CLI/SDK was 2.0.5,
CommandCode 1.56.2 (the Docker version), and Cline 3.0.62.

| Model                                         | Test                                                                    | Result                                                                                                         |
| --------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `opencode/mimo-v2.6-flash-free`               | Native verification interrupted by an injected five-second wait timeout | 14.0s total; recovery 8.9s; both bugs confirmed, false claim refuted                                           |
| `opencode/muse-spark-1.3-contributor-free`    | Same interruption test                                                  | 18.1s total; recovery 13.0s; both bugs confirmed, false claim refuted                                          |
| `cline/cline-free/muse-spark-1.3-contributor` | Existing tool-less verifier with supporting contract source supplied    | 17.0s; both bugs confirmed, false claim refuted                                                                |
| `commandcode/meta/muse-spark-1.3-contributor` | Existing native-tool verifier                                           | Blocked before inference: environment credential rejected; existing local CLI login reached weekly usage limit |

The OpenCode tests shortened the SDK wait against live sessions. Production code
then interrupted them and forked their history for recovery. Both recovered with
native reads (six for MiMo and ten for Muse) and no tool-less rejection. These are targeted recovery checks,
not a comparison of ordinary review latency. CommandCode and Cline do not execute
the new OpenCode recovery path; the Cline result is a compatibility check, and
CommandCode remains unverified live.

Ordinary full local pipeline runs also completed: MiMo in 22.9s and Muse in
30.4s. Both delivered 2/2 hunks, found and verified both seeded bugs, and needed
no recovery. These runs validate the normal path; they do not establish severity
calibration or a general speed improvement.

Earlier tool-less tests rejected MiMo Free and Muse Free requests. Switching to a
paid recovery model worked but added configuration and changed billing. That
design and the later free-model exclusion have both been removed.

All 1,119 tests passed, along with typecheck, lint and build. Four added tests
cover recovery history/permissions, completed-judgment preservation, timeout
interruption, fail-open behavior, and expiry during fork setup. The quality corpus
was skipped as previously requested; these checks do not establish general recall
or precision. Raw local results remain under `.jbot-review/mimo-verification/`.
