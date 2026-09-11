# Review lens audit: interactions and frontend

Follow-up to [the auxiliary session timeout audit](2026-09-11-auxiliary-session-timeouts.md).
Question: do the `review-interactions` and `review-frontend` lens passes carry
redundant material, and is that why they are the slowest auxiliary sessions?
Same corpus (145 attempts on `integral-xyz/fms` via Depot and
`integral-xyz/fms-frontend` via GitHub, 2026-09-09 to 09-11), plus the prompt
source at `3081775`. Observational; nothing changed.

## Answer

The lens prompts are not bloated with instructions, and the two lenses do not
duplicate each other's output. Three things do stand out:

1. **Each lens prompt carries the ~24 KB finder guideline slice** (about 30%
   of an 82 KB lens prompt) while telling the model not to run a written-rule
   audit, and a separate guideline-compliance session already receives the
   full rule set. That is the one clearly redundant block.
2. **On tool-less backends the lens prompt argues with itself.** CommandCode
   runs with repository tools disabled by default (#207), so `commandcode.ts`
   prepends the no-tools directive ("do not read files … those checks have NOT
   been performed") to a prompt whose exploration policy still says "start
   with targeted reads of callers, definitions, configuration, and tests" and
   whose interactions addendum says "follow both ends of a changed contract
   until its actual behavior is established". Cline gets the same pairing.
3. **The time is hidden reasoning, not prompt volume.** On CommandCode review
   and lens sessions, 94–99%
   of reported output tokens never appear in the result; the interactions
   lens returns a median 415 visible characters from a median 3,962 output
   tokens. A lens pass costs roughly what a main pass costs on the same model,
   because it is a second full read of the full diff with a narrower question.
   Trimming 24 KB of prefill saves seconds and money, not the minutes that
   trigger the grace.

The lens with a value problem is `review-interactions`: 61% of its completed
passes return nothing, the verifier refutes 45% of what it does return, and it
accounts for 11 of the 20 grace cut-offs. `review-frontend` posts at the same
rate as the main pass and should stay as it is.

## What a lens session receives

Median lens prompt: 82,117 chars (main: 95,166; ratio 0.85). Assembly order is
lens base → guidelines → lens context → lens addendum → evidence rule → output
reminder (`assembleReviewPrompt`).

| Block                                            |   Bytes | Share | Note                                                                                                                 |
| ------------------------------------------------ | ------: | ----: | -------------------------------------------------------------------------------------------------------------------- |
| Embedded diff hunks                              | ~41,500 |   50% | Same block as main. Inherent: every pass covers the full diff (invariant #1).                                        |
| Finder guideline slice                           | ~24,400 |   30% | Capped at `MAX_FINDER_GUIDELINE_BYTES` (24 KB). `lens: true` only strips procedural sections (Commands, workflows…). |
| Lens base instructions (`buildLensReviewPrompt`) |   8,100 |   10% | Command, exploration, severity, noise, classification, framework-claim, tone, output policies.                       |
| Scope block, changed-symbol usage, lens note     |  ~6,000 |    7% | PR intent, linked issues, blast radius. Useful to both lenses.                                                       |
| Lens addendum                                    |     941 |    1% | interactions 941, frontend 968, integrity 1,078.                                                                     |
| Evidence rule + output reminder                  |   1,134 |    1% |                                                                                                                      |

Fixed instruction text totals 10.5 KB for a lens versus 17.9 KB for the main
pass: #210 already removed the coverage protocol, calibration examples, and
scope sections from lens prompts. No line longer than 40 characters appears
twice in a lens prompt. The remaining overlap is semantic and small: the
interactions addendum restates callers, unchanged code, and contract-following
that the shared exploration policy already states, and every addendum ends
with a "do not run X audit" list that repeats the base's "do not start … other
lens's investigation" (about 300 characters).

The guideline block is the one worth cutting. The lens base says to use
"relevant repository guidelines" only to establish expected behavior; the
addenda exclude rule audits outright; the compliance session gets the full set.
A few KB of intent-relevant excerpt would serve the stated purpose. Savings are
about 6 K prefill tokens per lens session, doubled when both lenses run, and
CommandCode routes have prompt caching disabled so nothing amortises it.

## Where the time actually goes

CommandCode reports `reasoning=0` and folds thinking into output tokens. Visible
result size against reported output, completed CommandCode sessions:

| Session              |   n | Result chars (median) | Output tokens (median) | Non-visible share |
| -------------------- | --: | --------------------: | ---------------------: | ----------------: |
| review (main)        |  44 |                   543 |                  9,798 |               98% |
| review-interactions  |  24 |                   415 |                  3,962 |               98% |
| review-frontend      |   9 |                 1,211 |                  7,034 |               94% |
| guideline-compliance |  30 |                    16 |                  4,887 |               99% |
| finding-verification |  21 |                   952 |                  1,513 |               82% |

Same model, same attempt: `deepseek-v4-flash-fast` spent a median 14,030 output
tokens on main and 11,567 on the interactions lens; `gpt-5.6-luna` 144 and
1,007. The slow lens routes from the timeout audit (`glm-5.3-flash` 19.6 K
tokens in 524 s, `deepseek-v4.1-flash` 32.7 K in 173–286 s) are generation
bound at 30–120 tokens/s. The 24 KB guideline block is prefill; removing it
would not have moved those sessions under the grace.

Whether the tool-less contradiction inflates reasoning cannot be read from
the logs (CommandCode and Devin are opaque in telemetry). It is the obvious
experiment: an embedded-only lens variant that drops the read/grep/follow
instructions instead of negating them with a preamble, compared on output
tokens and findings over the same heads.

## Do the lenses earn their pass?

Raw yield over the 98 attempts whose pipeline completed, counted from the
`Review complete` line: main 45 findings, lenses 50 (interactions 33, frontend
17), compliance 22; 90 posted after filters. The per-lens table below counts
every completed pass, including attempts whose pipeline did not finish, so its
totals run higher.
Lenses are not redundant with a working main pass: they supply 43% of raw
findings, and in this pool they are often the only finder that produces any.
Main passes with zero findings, by route: `gpt-5.6-luna` 13 of 14 (median
result 28 characters, an empty JSON object), `opencode/muse-spark-1.3-…-free`
16 of 18, `opencode-go/muse-spark-1.3-…` 12 of 14, Cline muse 7 of 8,
`deepseek-v4-flash-fast` 11 of 21, `deepseek-v4.1-flash` 1 of 5, `glm-5.3-flash`
and `omen-alpha` 0.

Per lens:

| Lens                | Completed passes | Zero-finding passes | Raw findings | Posted (telemetry) | Refuted by verifier |
| ------------------- | ---------------: | ------------------: | -----------: | -----------------: | ------------------: |
| review-interactions |               72 |            44 (61%) |           40 |         6/11 (55%) |          5/11 (45%) |
| review-frontend     |               23 |            10 (43%) |           20 |        12/17 (71%) |          5/17 (29%) |
| main-review         |                — |                   — |           45 |        12/17 (71%) |          4/17 (24%) |
| guideline           |               84 |            65 (77%) |           24 |         4/4 (100%) |                   0 |

Posted counts include findings re-anchored from their evidence quote
(`rescued`); telemetry covers the 43 fms-frontend artifacts only.

Cross-session duplication is negligible: one finding was dropped as a
duplicate across all 43 artifacts, and interactions and frontend never landed
on the same path and line (six same-file pairs, all different lines). The
lenses are not redundant with each other. The interactions lens is simply the
weakest finder: fewest findings per pass, lowest precision, slowest, and the
most grace cut-offs. Frontend matches the main pass on precision and posts at
0.9 findings per pass.

## Options

Implemented on this branch: 1 (lens guideline slice capped at 8 KB) and 2
(embedded-only lens body on tool-less backends). 3 and 4 remain open.

1. Drop or cap the guideline block in lens prompts (a few KB of intent
   excerpt at most). Cheap; the compliance pass keeps rule coverage. Verify on
   the corpus that lens findings do not degrade.
2. For tool-less backends, build the lens prompt from an embedded-only
   exploration policy rather than prepending the no-tools directive to
   read/grep instructions; measure output tokens and findings.
3. Keep frontend unchanged. Make interactions cheaper or conditional: run it
   only when the changed-symbol block lists callers outside the diff, or only
   on an auxiliary route with repository read access, where "follow both
   ends of the contract" is possible.
4. Investigate the empty main passes on `gpt-5.6-luna` and the Muse routes
   separately. That is the larger quality problem this data exposes; the
   lenses are compensating for it.

The runway-floor grace change decided in
[the timeout audit](2026-09-11-auxiliary-session-timeouts.md#options) addresses
the cut-offs independently of any of these; 1–3 change model inputs and fall
under the review-quality gate in AGENTS.md.

## Limits

Prompt shares for the guideline and scope blocks are inferred from logged
sizes (lens prompt minus fixed text minus the logged diff block), not measured
per session. Output-token accounting is CommandCode's; visible-versus-hidden
uses four characters per token. Precision figures rest on the verifier's
verdicts over 49 findings in one repository, not on adjudication.
