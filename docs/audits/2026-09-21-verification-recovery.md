# Bounded OpenCode verification recovery

OpenCode's free MiMo model can use native tools and return valid verdicts, but
jbot's tool-less agent setup is rejected by that free endpoint. Enabling the
existing generic wrap-up therefore turns an interrupted investigation into a
provider error. Muse Contributor Free returned the same error in a control.

This change leaves recovery off unless `JBOT_VERIFY_RECOVERY_MODEL` names an
available non-free OpenCode model. It reuses the configured OpenCode credential.
The primary verifier keeps native tools. Recovery forks its collected history,
denies all tools, and gets one attempt within the original deadline. A five-minute
verification budget reserves the last minute; an early format repair is capped
at that minute too. Partial valid verdicts survive recovery failure and cannot
be overwritten by recovery. Missing judgments still go through the existing
incomplete-verification handling. Auth and usage-limit errors do not trigger it.

## Local evidence

Tested with OpenCode CLI/SDK 2.0.5, `opencode/mimo-v2.6-flash-free` at low effort,
and `opencode-go/mimo-v2.6-flash` for recovery. The clean fixture contains two
seeded defects (100x overcharge and owner/tenant confusion) and one false claim
that an existing audit call is absent.

| Test                                | Result                                                                                                                     |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Ordinary native verification        | 21.6s; both defects confirmed, false claim refuted; no recovery call                                                       |
| Native session interrupted after 5s | 8.3s total; paid tool-less recovery returned all three expected verdicts; zero recovery tool calls                         |
| Full local review pipeline          | 29.1s; both hunks delivered; incomplete verifier output recovered in 3.3s; both defects retained; zero recovery tool calls |

The full-pipeline recovery used 24,413 input tokens, 294 output tokens and 14
reasoning tokens, with reported cost $0.003504. This is a measured fixture cost,
not a production cost estimate or a claim of improved overall latency.
The interruption was injected through the native session API; the timeout branch
also has a deterministic test that checks interruption before forking evidence.

Tests cover malformed and partial output, retained judgments, deny-all fork
permissions, model selection, timeout recovery, recovery failure, disabled
configuration and avoiding recovery on usage-limit failures.

## Enable or disable

Set this on the review process or action step:

```yaml
env:
  JBOT_VERIFY_RECOVERY_MODEL: opencode-go/mimo-v2.6-flash
```

Unset it to disable recovery. OpenCode credentials need access to the chosen
model. A free or unavailable recovery model is logged and disabled. Pi and CLI
verifiers are unchanged; this does not route free models through Pi.

The quality corpus was not run. These are targeted runtime and contract checks;
they do not establish general recall, precision, or production reliability.
Raw local transcripts and results remain under the ignored
`.jbot-review/mimo-verification/` directory, with the full-pipeline log and result
at `/tmp/mimo-recovery-pipeline.log` and `/tmp/mimo-recovery-pipeline.json`.
