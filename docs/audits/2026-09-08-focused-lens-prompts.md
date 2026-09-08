# Focused lens prompts: audit and local comparison

The interactions and frontend passes previously received the complete general
review instructions, including mandatory per-function checks, an architecture
sweep, calibration examples, and a summary they never publish. Their PR context
also included commit messages, CI status, prior threads, and changes-since
summary instructions owned by other passes.

The treatment gives these two passes focused instructions and removes that
history context. Shared severity, evidence, framework-claim, noise, command, and
JSON rules remain shared constants. It preserves the exact existing diff block,
PR intent, linked issues, guidelines, review focus, and changed-symbol guidance.
No model, concurrency, deadline, tool, or verification policy changes.

Local equality checks confirmed byte-identical main and integrity prompts and
general PR context after extracting the shared fragments. Instruction-only
interactions prompts decreased from 17,462 to 9,560 characters. The actual fixture
prompts decreased from 88,751 to 79,845 bytes for interactions and 88,804 to 79,898
bytes for frontend (about 10% each).

## Experiment

- Target: frozen `integral-xyz/fms-frontend` PR #2240, head
  `a3b2d011fa2071f3e13ed2d61a7a482caa0f2cb4`; merge base
  `217e7bd9b42b453542270339e3f1e5498edf8e33`; all 13 changed files.
- Control: latest-main revision `55acee0be119b54e3670f2b440ca0d6b871273c3`.
- Treatment: `68cc3b0e7403991a4502d9b43f9ad0b6f6b695df`.
- Main and aux model: `opencode/muse-spark-1.3-contributor-free` through local
  OpenCode 1.18.26, with the same dependencies and provider credentials.
- One main shard, five session slots, two review passes, verification enabled,
  30-minute budget, context trimming off, embedded-first prompt on, no Context7.
  Verification overlap is off. Local mode does not load GitHub prior threads or
  linked issues, so the live trial does not exercise those history omissions.
- Sequential control, treatment, repeat control. No overlap between experiment
  runs; external account load and provider cache state were not controlled.
- This is one frozen-PR operational comparison, not the three-repetition core
  corpus or a blind-adjudicated precision/recall benchmark. Those were not run.

| Measurement   | Control | Treatment | Repeat control |
| ------------- | ------: | --------: | -------------: |
| Total runtime | 254.8 s |   321.6 s |        171.4 s |
| Main          |  92.3 s |    94.1 s |         88.9 s |
| Guidelines    |  94.3 s |    57.9 s |        111.2 s |
| Interactions  |  96.4 s |   279.3 s |        115.2 s |
| Frontend      | 128.5 s |   198.7 s |        117.2 s |
| Verification  | 124.6 s |    40.2 s |         52.2 s |

All scheduled review, guideline, lens, and verification sessions completed in all
three runs. No rate-limit error was logged. The effective configuration hashes
matched. The treatment was slower than both controls, particularly in the lenses;
this experiment does not demonstrate a latency improvement. Provider cache reads
varied substantially even for the unchanged main prompt, so the observations do
not establish that prompt reduction caused the slowdown.

## Finding spot-check

- Initial control retained two P3s: a redundant undo request and an unverified
  group-expansion hypothesis. The former's request behavior is visible in code,
  but its asserted audit side effect needs backend evidence. The latter depends
  on unestablished grid behavior.
- Treatment retained one P3: an undo action silently does nothing when its target
  no longer exists. The missing fallback is directly visible in the frozen code.
- Repeat control retained that same P3 and two model-confirmed P2s. One assumes
  a mutation stops being pending before its returned read-back promise settles;
  the installed query-library source awaits the callback before dispatching
  success, contradicting that premise. The other describes a concurrency window
  explicitly accepted in the changed decision log, with server rejection and
  read-back recovery. These do not establish two independently confirmed blocking
  defects that the treatment missed.

This was a manual spot-check, not blind adjudication. Different candidates from
the unchanged main prompt demonstrate model variability. No precision or recall
improvement is established. The production CommandCode GLM timeout has not been
reproduced or fixed by this Muse-only experiment. Keep this change in draft;
smaller prompts alone do not justify a rollout on performance grounds.

## Validation and cleanup

1,025 tests, typecheck, lint, formatting, and build passed. Main/integrity prompt
and general-context equality checks passed against the control. OpenCode, Pi,
CommandCode, and the remaining adapters share the changed prompt assembler.
No P1/P2 implementation issues remained after self-review.

De-slop reused existing context budgets and prompt rules instead of copying them.
Four comment blocks were adjudicated: one shortened, three removed. One new
context-boundary test was kept because it catches history leaking into lens scope
or PR-intent headings being stripped; the existing lens-order test was expanded
rather than adding duplicate cases. Net branch size before this audit: +117 lines,
mostly shared-rule extraction, focused instructions, and context/test wiring.
Post-test edits only restore the adjacent lens comment's placement and update
prose; they do not change the tested prompt values.
