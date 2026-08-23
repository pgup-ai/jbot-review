> **Status (2026-08-22):** the backlog below shipped in
> [PR #169](https://github.com/pgup-ai/jbot-review/pull/169) — grace-expiry
> abort, classified retry + stale-before-retry, the verifier effort floor
> (TASK-157), context caps, and the guideline widen fix, plus the follow-up
> wave (per-backend reasoning-effort delivery, the one-knob explicit
> mapping, the mimo-v2.5-free medium floor, and the Review-metadata effort
> stamp). The `reasoningEffort low` default flip remains gated on the
> TASK-100/105 core-subset adjudication.

# Review-speed deep dive — algorithms, redundant steps, context construction

Date: 2026-08-21. Audit + one live experiment; no `src/` changes.
Method: three parallel code audits (critical path in `runner.ts`/`github.ts`;
context construction in `prompt.ts`/`diff-context.ts`/`review-context.ts`;
session mechanics in `opencode.ts`/`pi.ts`/`acp.ts`/`filter.ts`) over `main`
@ 1b69a0d, plus live probes and a 48-run paired A/B on
`opencode/muse-spark-1.2-contributor-free` through `scripts/review-benchmark.ts`
(smoke subset, Phase-2 corpus). Successor to the 2026-08-06 wall-clock audit;
its premise re-confirmed: model inference dominates, non-model in-action time
stays inside the known 8–14s envelope, and no CPU hot path matters.

## TL;DR — what to do next, in order

1. **Ship a reasoning-effort policy arm (TASK-100/101)** — verified today:
   `reasoningEffort: low` on the one knob the config exposes cut whole-run
   wall clock materially on muse-spark with no run-level recall loss
   (numbers in §5; screen-sized sample, not a graduation).
2. **Give the verifier its own contract** — the finding-verification session
   is the whole tail on small PRs (probe: main 22.5s, verify 20.0s, strictly
   serial) and re-prefills ~48K uncached tokens for a 2-file diff. Combines
   TASK-065 (slim verifier context), TASK-157 (deliberate verifier effort),
   TASK-079 (overlap with the settle grace), TASK-143 (partitioning if it
   stays the tail).
3. **Abort abandoned aux sessions + classified retry (TASK-076/077/078,
   TASK-150/155)** — the two worst-tail mechanisms; `ReviewBackend` has no
   cancel handle today, and a doomed retry can re-buy a full finder window.
4. **Cap the uncapped context blocks (new)** — flat prior review comments,
   commits, changed-files, and the prior-threads block (worst ≈133KB) have
   no byte budget: an invariant-#4 gap that compounds per session and per
   re-review, and the likely source of the INC-001 232KB outlier.
5. **Trim the pre-session serial chain (TASK-084 + new)** — parallelize the
   GitHub fetch chain, drop the log-only model-listing spawns from the
   critical path, and overlap the Context7 enable. 2–9s every run; the only
   non-model wins left.

## 1. The contract this audit ran under (enhanced prompt)

Deep-dive the end-to-end review flow for speed without losing recall,
precision, or coverage, on three axes: (a) algorithms to introduce or
leverage, (b) redundant steps to trim, (c) context-construction
optimizations. Respect invariants 1–11 (full-diff scope, fail-open aux,
hard byte budgets, three-dot posting diffs, read-only floor), the plan's
REQ/QLT gates and TASK-008 merge gate, and prior rejections (no
overlap-verify-with-the-main-pass, no delta-only scope, no model swaps
presented as pipeline wins, ALT-001..012). Reconcile every finding against
`plan/architecture-review-latency-quality-optimization-1.md` (Phases 0–4
built; 5–17 open): confirm, sharpen, or add. Verify what is verifiable
today on `opencode/muse-spark-1.2-contributor-free` via
`npm run benchmark:review` with paired stats, and state sample limits.

## 2. Axis A — algorithms

- **Reasoning-effort policy is the only lever that touches the ~75–98%**
  (Phase 11). Verified live: muse-spark honors `reasoningEffort`, and the
  default-`medium` main+verify pipeline spends most of its output tokens
  reasoning (§5). Risk-based effort (TASK-101: elevated for risky shards,
  low for docs/tests) is the graduated form; the A/B here is the screen the
  plan asks for first.
- **Overlap verification with the aux settle grace (TASK-079)** — grace →
  filter → verify are strictly serial today (`runner.ts:2252→2323`); the
  saving is min(grace spent, verify duration), up to 120s on straggler
  runs. This is NOT the 2026-06-29-rejected overlap-with-main.
- **Failure-classified retry + stale-PR check (TASK-150/155)** — the shard
  retry is blanket (`runner.ts:3282-3292`): a deterministic 4xx is retried
  with a near-identical prompt for up to another finder window; no PR-state
  re-check before the retry. On ACP routes the multiplier is worse: repair
  and continuation each re-carry an 80KB prompt into a fresh process — up
  to 4 full-prompt sessions per shard before failing (fold into TASK-150).
- **Predicted-cost sharding (Phase 7)** stays gated on CON-003: nothing
  measured here shows provider-side parallelism for the free-tier routes,
  and smoke cases resolve to 1 shard. Measure concurrency benefit before
  spending the effort.
- Re-confirmed: no quadratic hot paths; `filter.ts`/`report.ts`/sharding
  are milliseconds. The "algorithm" wins are scheduling and token policy,
  not data structures.

## 3. Axis B — redundant steps

Ranked by expected wall-clock effect; anchors on `main` @ 1b69a0d.

| #   | Step                                                                                                                                                                                  | Anchor                                                                   | Cost today                                    | Fix                                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Verifier queue can sit behind abandoned aux sessions holding slots until their own ~29.5-min timeout; verify budget drains while queued                                               | `runner.ts:2949-2953`, `session-concurrency.ts:91-139`, `runner.ts:2327` | minutes on straggler runs                     | TASK-076/077/078 abort-at-grace-expiry (add a cancel handle to `ReviewBackend`); re-derive the verify timeout after the queue wait (new) |
| 2   | Blanket same-prompt retry; no stale-PR check; ACP repair/continuation ×4 multiplier                                                                                                   | `runner.ts:3282-3361`, `acp.ts:33-34,174-242`                            | worst tail in the codebase (INC-001)          | TASK-150/155                                                                                                                             |
| 3   | JSON repair is an extra full model call (same-session re-prefill on opencode/pi; fresh 80KB session on ACP); aux passes parse strict→repair even though their results are discardable | `opencode.ts:743-808`, `pi.ts:1126-1148`                                 | one avoidable model call per garbled response | lower-cost: make aux parse lenient-first like ACP already does; track the `parse` failure class rate before more                         |
| 4   | Pre-session GitHub chain is ~10–14 serial round trips; `pulls.listReviews` fully paginated 3× per run, viewer login fetched 3×                                                        | `runner.ts:1029-1294`, `github.ts:564,200,1117`                          | 1.5–4s every run                              | TASK-084 + dedupe (new sharpening)                                                                                                       |
| 5   | Model-listing block spawns CLIs / API calls whose output only feeds log lines, serially before shard dispatch                                                                         | `runner.ts:1888-1951`                                                    | 0.5–5s every run                              | new: fire-and-forget or log after dispatch                                                                                               |
| 6   | Context7 enable: two network calls, 15s worst-case timeout, serial between boot and dispatch                                                                                          | `runner.ts:1962`, `opencode.ts:46`                                       | ~1s typical, 15s worst                        | new: overlap with the GitHub fetches                                                                                                     |
| 7   | changes-since session: full core + full 40KB base-diff to write a cosmetic body paragraph; the aux session most likely to be paid for and discarded at grace expiry                   | `runner.ts:2181-2204`                                                    | token cost + grace pressure                   | TASK-065 (see Axis C)                                                                                                                    |

Also found, quality not latency: **verification silently disappears below
45s of remaining budget** (`runner.ts:2837-2845,2995-3001`) — the precision
gate vanishes exactly on the largest runs. Interacts with TASK-157; worth
its own decision.

## 4. Axis C — context construction

The finder path is already well budgeted and cache-friendly (~61KB shared
prefix across shard prompts; lens shares through end-of-diff with a
single-shard main). The waste concentrates elsewhere:

1. **Per-session contracts (TASK-065 — biggest lever).** Four aux session
   types receive the full finder context they don't need. changes-since
   needs its ≤4,000B delta block + PR title, gets ~60–100KB (and the WRONG
   diff — its job is `reviewedHead..head`). Addressed check needs prior
   threads + diff, gets playbooks/focus/blast-radius/issues too. Compliance
   carries playbooks that actively conflict with its own "do not invent
   rules not in the provided guidance" instruction. Verifier carries
   summaryScope/playbooks/prior-threads it never cites. Total ≈ **80–130KB
   re-sent per re-review run (~20–30% of prompt bytes)**, all fail-open
   surfaces (invariant #3 holds).
2. **Uncapped core blocks (new; invariant-#4 gap).** Flat prior review
   comments (`review-context.ts:451-458` — whole prior jbot review bodies,
   duplicating the structured threads block), commits (`:435-447`),
   changed-files (`:426-433`), and the count-capped-only prior-threads
   block (worst ≈133KB, `github.ts:26-29`). Grows with PR maturity, ×every
   session. Cap + disclose, house pattern.
3. **Guideline widen-fallback inverts the budget (new sharpening of
   TASK-063).** When the compliance pass is skipped (small-PR fanout,
   trivial re-review delta, aux overflow), finders get the FULL ≤96KB
   corpus instead of the ≤24KB slice (`runner.ts:2021`) — the small PRs
   pay the biggest guideline bill. Keep the slice; disclose "full corpus
   not audited this run".
4. **Aux prompt types share a 0-byte prefix** — each leads with its own
   task block, so the 60–100KB context behind them gets no provider-cache
   reuse across session types. Measured consequence in §5 (verifier: 48.5K
   input tokens, 0 cache-read, in the same run whose main pass read 55K
   from cache). Fix via contracts (item 1), not by reordering against
   invariant #5.
5. **TASK-060 dedupe is real but small** (~1KB/finder session: scope,
   prior-thread suppression ×3, trigger-path formula ×2, anchor rule ×3).
   The embedded-first diff-block intro still says "cross-reference callers
   in the checkout" (`diff-context.ts:465`) — contradicts the
   embedded-first policy; fix with a variant string.
6. **TASK-064 compact diff rendering: recommend closing.** GitHub patches
   are already header-free; context lines and `@@ +start` are load-bearing
   for line-number computation and evidence re-anchoring
   (`filter.ts:284-326`). <2% available at high quality risk.
7. **Engine-level context (new, needs telemetry):** on the opencode route,
   session token accounting implies ~45–49K tokens of harness-side context
   per session beyond jbot's own prompt (main: 55.6K total for a 24.5KB
   prompt; verifier: 48.5K for a ~12KB prompt). Main sessions read it from
   provider cache; the verifier paid it uncached. Add token-source rows
   (TASK-058/062) before acting; if real, it dwarfs every prompt-side trim
   on small PRs and strengthens the pi-engine route.

## 5. Verified today — muse-spark A/B (screen, not graduation)

Setup: `scripts/review-benchmark.ts`, Phase-2 git-fixture corpus, smoke
subset (12 cases), 2 repetitions, arms differing only in
`JBOT_MODEL_OPTIONS` (control: default = `reasoningEffort medium`;
treatment: `low`), both arms with `.env` pins neutralized (the repo `.env`
sets PROVIDER/JBOT_SDK_ENGINE/JBOT_VERIFY_FINDINGS/JBOT_REVIEW_PASSES/…,
which silently reroute local runs — the PROVIDER pin reproduces the known
provider-pin-swallows-qualified-model gotcha and had disabled verification
in the first probe). Model `opencode/muse-spark-1.2-contributor-free`,
engine opencode, temperature/provider defaults, prompt cache on.

Single-case probe (2 files, 4.6KB diff, 2 seeded P1s), low arm:

| Phase                    | Duration                                                            |
| ------------------------ | ------------------------------------------------------------------- |
| context-assembly         | 0.8s                                                                |
| main-execution           | 22.5s (input 313 + 55,281 cache-read; output 389; reasoning 269)    |
| grace-wait / filtering   | 0s                                                                  |
| **finding-verification** | **20.0s** (input 48,527, cache-read 0; output 127; reasoning 1,711) |
| posting + teardown       | ~0s                                                                 |

The verifier nearly doubles the small-run wall clock, serial after main,
and pays its input uncached. Under the shared `low` it still reasoned 6×
the main pass — TASK-157's "verifier effort is an accident of the aux
model entry" is visible in a single trace.

A/B results — 48 runs, 0 failures/timeouts, 24 pairs:

| Metric                                                          | control (medium) |                                                                            treatment (low) |
| --------------------------------------------------------------- | ---------------: | -----------------------------------------------------------------------------------------: |
| Whole-run median                                                |            63.6s |                                                                                      37.7s |
| Whole-run p90                                                   |           142.6s |                                                                                      78.5s |
| **Paired median delta**                                         |                — | **−29.8%** (95% CI [−46.5%, −12.3%], permutation p=0.0002, faster in 21/24 pairs, MDE 20%) |
| Reasoning tokens (arm total)                                    |           61,566 |                                                                        34,840 (**−43.4%**) |
| Output tokens                                                   |            9,336 |                                                                               9,406 (flat) |
| Input / cache-read tokens                                       |      285K / 323K |                                                                         283K / 306K (flat) |
| Defect runs with ≥1 finding                                     |            12/12 |                                                                                      12/12 |
| Defect runs with a finding at a seeded anchor path (mechanical) |            12/12 |                                                                                      12/12 |
| Clean runs with findings (lower is better)                      |             6/12 |                                                                                       7/12 |
| Anchor rate                                                     |             1.00 |                                                                                       1.00 |

The mechanism is clean: the entire saving is reasoning decode (−43%), with
output and input flat — the model is not compensating by generating more,
which is the failure mode that ate the embedded-first latency win on
mimo/glm. Unlike Phase 3's runs, the effect clears the sample's own 20%
minimum detectable effect. Scorer status: `adjudication-required`
(recall/precision read 0 in BOTH arms until `corpus:adjudicate` runs), so
the merge gate is correctly unmet — this screen justifies running the core
subset + adjudication, not flipping a default.

Limits, stated plainly: 24 pairs resolves only large effects; run-level
defect detection ("returned ≥1 finding on a defect case") is not semantic
adjudication, so QLT-003 is not evidenced here; the smoke fixtures carry no
guidelines or prior threads, so compliance/addressed/changes-since never
fire — the Axis-C aux-contract savings are code-anchored, not
benchmark-verified; and the treatment lowers main AND verifier effort
together because the config exposes one knob (that coupling is itself
TASK-157's point). Graduation needs the `core` subset + adjudication per
the merge gate.

## 6. Plan reconciliation

| Plan item                                   | Verdict from this audit                                                                                                                                |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| TASK-079 grace-overlap verify               | Confirmed; largest deterministic serial segment after main (≤120s)                                                                                     |
| TASK-076/077/078 abort-on-abandon           | Confirmed; sharpened: no cancel handle in `ReviewBackend`; slot retention is the wall-clock coupling; add queue-aware verify-timeout re-derivation     |
| TASK-150/155 classified retry + stale check | Confirmed; sharpened: ACP repair/continuation ×4 multiplier belongs in the classification                                                              |
| TASK-084 parallel fetches                   | Confirmed (1.5–4s); sharpened: dedupe 3× `listReviews` + 3× viewer login                                                                               |
| TASK-065 per-session contracts              | Confirmed as the biggest context lever (80–130KB/run); changes-since worst                                                                             |
| TASK-063 guideline budgets                  | Sharpened: fix the widen-fallback first — it inverts the budget on small PRs                                                                           |
| TASK-060 prompt dedupe                      | Confirmed small (~1KB); add the `diff-context.ts:465` embedded-first contradiction                                                                     |
| TASK-061 prefix reuse                       | Mostly already achieved; residual: context7Block placement in the multi-shard branch                                                                   |
| TASK-064 compact diff rendering             | Recommend closing as already-compact / quality-risk                                                                                                    |
| TASK-100/101 reasoning arms                 | Screened live today (§5)                                                                                                                               |
| TASK-157 verifier effort                    | Still plan-only in code; §5 shows the coupling live                                                                                                    |
| TASK-058/062 token telemetry                | Raised in priority: needed to decompose the ~45–49K/session engine-context signal                                                                      |
| New (not in plan)                           | Model-listing off critical path; Context7 overlap; uncapped core-block caps; widen-fallback fix; verify-skip-<45s decision; queue-aware verify timeout |

## Rejection-filter compliance

Not proposed: delta-only scope (inv 1), overlapping verification with the
main pass (rejected 2026-06-29 — TASK-079 overlaps the settle grace only),
dropping files/hunks/findings (inv 1/3, #167), removing or gating
verification (ALT-012 — §3 raises its priority and §4 slims its input
instead), model swaps as pipeline wins (ALT-004 — the A/B holds the model
fixed and varies a declared option), unbounded context (inv 4 — Axis C adds
budgets), turn-cap lowering for tool-less routes (CON-004), read-only
weakening (inv 8).

## Data

Probe + A/B artifacts: benchmark summary/cases JSONL and run logs in the
session scratchpad (`bench/`); phase rows from `.jbot-review/telemetry.jsonl`
per fixture workspace; manifest `bench/live-manifest.json` (declared
treatment variables: `JBOT_MODEL_OPTIONS`, `reasoningEffort`). Subagent
audit transcripts retained in the session task files.
