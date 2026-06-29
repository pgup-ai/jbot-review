# Incremental-Delta Lens Gating — Design

**Status:** Implemented 2026-06-28 on `feat/incremental-lens-gating` (TDD;
410 tests green). This doc is the as-built design.

**Goal:** On a re-review (a push to an already-reviewed PR), stop re-running the
expensive recall-supplement sessions — the `interactions`, `integrity`,
`frontend` lenses and the `guideline-compliance` pass — when the **incremental
delta since the last review** doesn't touch what that session is for. The full
main review and the verification pass still cover the complete `base...head`
diff on every push. This is a **latency** change on the recall-supplement axis,
not a scope change.

**Lineage:** Extends Phase D of
`docs/superpowers/plans/2026-06-28-review-routing-improvements.md`. Phase D
(`planReviewFanout`, PR #63) scales the recall-supplement **count** by the
_whole_ diff's shape; it is a no-op on any non-trivial PR (full tier). This work
adds a second, finer reducer keyed off the _incremental_ delta and gating
_per session_ rather than by count. Motivated by the latency diagnosis in
`pgup-ai/jbot-review-app` runs 28339134423 / 28335921783: the aux lens passes
are the wall-clock floor (~12 min each on a re-review that introduced almost no
new code), and a paid aux model only moved 15m20s → 12m46s because the floor is
structural — the run _blocks_ on the slowest lens settling.

**Tech stack:** TypeScript ESM (`.ts` import specifiers, run via tsx), node:test

- `node:assert/strict`, oxlint (deny-warnings), prettier. No new dependencies.

---

## Background: what "the lenses" are and why re-running them is the cost

Each review run is **stateless**: it re-reviews the full diff and dedupes
against its own prior comments (`suppressPreviouslyReported`). A lens's recall is
therefore "banked" as posted GitHub comments — re-running it on a tiny push
mostly re-derives the same (suppressed) findings at full latency cost. The
recall-supplement sessions and their purpose:

| Session                | Purpose (`REVIEW_LENSES` / prompts)                                                                                                                       | Slowest?              |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| `interactions`         | Changed code breaking UNCHANGED callers/callees; half-implemented contracts; cross-hunk contradictions. Traces symbols from the diff into unchanged code. | yes (most tool calls) |
| `integrity`            | Security, concurrency, data-integrity bugs on changed paths.                                                                                              | —                     |
| `frontend`             | React/Vue/Svelte state & render bugs. Content-triggered (not count-rationed) on frontend files.                                                           | —                     |
| `guideline-compliance` | Audits the changed code against the repo's WRITTEN engineering standards, rule by rule. Not a lens; a separate aux pass.                                  | —                     |

The full **main** review (sharded, on the deep model) is the safety net that
runs on the complete diff every push; the lenses are class-focused recall
_supplements_ on top of it.

---

## The rule

For a re-review with a known prior reviewed head, run each session only when the
**incremental delta** (`reviewedHead...headSha`, three-dot per invariant #7)
touches what it is for:

| Session                | Re-runs when the incremental delta…                                                                                        | Backstop when skipped                  |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `interactions`         | adds, changes, **or removes** an exported symbol (`extractChangedExportedSymbols`, extended to `-export` lines, non-empty) | main full pass (within-file logic)     |
| `integrity`            | touches `PATH_PATTERNS.security ∪ data ∪ api`                                                                              | main full pass                         |
| `frontend`             | touches real frontend files (`changedFilesIncludeFrontend`)                                                                | main full pass + banked prior comments |
| `guideline-compliance` | is **not** test-only and **not** docs-only (touches governed code)                                                         | banked prior comments                  |

**Never gated — full `base...head` every push:** the main sharded review and the
finding **verification** pass (invariants #1, #3). The gate only ever _reduces_
recall supplements; when a session does run, it still sees the full diff.

Design decisions settled during brainstorming:

- **Signal = deterministic delta-shape**, not an LLM judge. Reuses the existing
  path taxonomy + `blast-radius`; pure and unit-testable; adds zero latency.
  (An aux call to decide whether to spend aux calls is self-defeating on the
  latency axis.)
- **`interactions` keys on exported-symbol change**, not delta size — its whole
  job is "a _small_ change breaks _unchanged_ callers," so size is the wrong
  signal. A delta that changes no exported surface has no cross-boundary ripple
  for it to find; within-file breakage is the main pass's job. The trigger
  fires on added, modified, **or removed** exported declarations — a pure
  export deletion/rename is the canonical caller-breakage case, so
  `extractChangedExportedSymbols` (added-only today) is extended to also scan
  `-export …` lines for this gate.
- **`integrity` = `security ∪ data ∪ api`.** Concurrency bugs can live anywhere,
  but the full main pass backstops them; the lens is a supplement.
- **`guideline-compliance` is soft-gated** — skipped only when the incremental
  delta is test-only (`classifyChangeShape(deltaFiles).testOnly`) or docs-only
  (`isDocOnlyChange`, the same deterministic predicate behind the existing
  `skipDocOnly` option) — because written standards can apply to almost any
  code.

---

## Mechanism & data flow

### Where the logic lives — extend `fanout.ts`, don't add a module

`fanout.ts` already _is_ the recall-supplement fan-out policy ("Scale
recall-supplement fan-out (extra lenses + guideline pass) to diff risk/size").
The incremental reducer is the same concern keyed off a different diff, so it
co-locates there beside `planReviewFanout` — one place a maintainer reasons
about all fan-out, one test file (`fanout.test.ts`). No near-twin module.

```
planIncrementalLenses({
  candidateLensKeys: string[],   // from selectLensKeys(effectiveReviewPasses, …)
  guidelinePass: boolean,        // effectiveGuidelinePass
  deltaFiles: PrFile[] | null,   // incremental delta; null ⇒ no gating
}): { lensKeys: string[]; guidelinePass: boolean; reason: string }
```

Pure; `runner.ts` only wires it (invariant #10). `deltaFiles === null` (first
review or fetch failure) returns the inputs unchanged — the universal fail-open
path. Otherwise it filters each candidate against a single declarative map so
adding a lens later is one row, not new branching:

```
// the ONLY place a session's trigger is defined; reuses the shared taxonomy,
// never re-declares path regexes.
LENS_TRIGGERS: Record<string, (delta: DeltaShape) => boolean> = {
  interactions: (d) => d.changesExportedSymbol,                    // blast-radius
  integrity:    (d) => d.touches(PATH_PATTERNS.security, .data, .api),
  frontend:     (d) => changedFilesIncludeFrontend(d.files),
};
// guideline-compliance (a boolean, not a lens key): run unless test-only/docs-only.
```

### Runner wiring (`src/shared/runner.ts`)

1. `reviewedHead = findLatestReviewedHead(allPriorReviewComments.filter(isJbotReviewBody))`
   — already computed today for `changes-since-last-review`. `undefined` on a
   first review.
2. If `reviewedHead` is defined, fetch the incremental-delta files
   **best-effort** (see below) → `PrFile[]`; else `null`.
3. `selectLensKeys(effectiveReviewPasses, …)` produces the candidate lenses
   exactly as today. Pass them + `effectiveGuidelinePass` + `deltaFiles` through
   `planIncrementalLenses`.
4. Feed the filtered `lensKeys` to `startLensPasses` and the filtered
   `guidelinePass` to the `guideline-compliance` `enabled` flag.

No other call sites change. The filter sits _after_ the existing selection, so
it composes without disturbing count-rationing or the whole-diff fan-out.

### Fetching the incremental delta

Reuse the existing octokit "changed files with patches" path — the same shape
`listPrFiles` already returns — via `repos.compareCommits(reviewedHead, headSha)`.
That returns `PrFile`-shaped `files[]` (filename + `patch`) with native
three-dot/merge-base semantics and no diff parser to maintain, and doesn't
depend on the prior commit being in a shallow Actions checkout. One thin helper
in `github.ts` mirroring `listPrFiles`. Best-effort, same posture as
`blast-radius.ts` — any failure (or a >300-file delta past the first page)
yields `null` → full lenses, never a failed run. (`changes-since-last-review`
needs only commit subjects, so it can't supply this; there is no existing
file-list fetch to reuse, only the pattern.)

### Composition with `planReviewFanout` (Phase D)

Unchanged and layered, both living in `fanout.ts`. `planReviewFanout` sets the
whole-diff **ceiling** (its minimal tier still zeroes lenses for a tiny _fresh_
diff via `selectLensKeys(1)`); `planIncrementalLenses` is a **second reducer**
on re-reviews. Net: `a session runs ⟺ fan-out allows it AND the incremental
delta touches its class`. Order: `planReviewFanout` →
`selectLensKeys(effectiveReviewPasses)` → `planIncrementalLenses`.

---

## Safety — every fallback fails toward _more_ coverage

- **First review** (`reviewedHead` undefined) → `deltaFiles = null` → no
  filtering, full lenses.
- **Force-push / rebase** → three-dot `reviewedHead...headSha` widens toward the
  whole PR (merge-base moves back) → more classes match → more lenses. Safe
  direction.
- **Delta fetch fails** → `null` → full lenses (best-effort).
- **Accepted residual:** we cannot tell whether a prior lens run _failed open_
  (0 findings from a timeout, not from a clean pass), so skipping assumes its
  banked findings are real recall. Mitigated by the always-full main pass. A
  future enhancement could record per-lens success in the review marker; out of
  scope for v1.
- **Escape hatch:** rides on the existing `dynamic-fanout` input — no new flag.
  Both behaviors are "scale recall supplements to the change," so one switch
  governs them: `dynamic-fanout=true` applies whole-diff tiering _and_
  incremental per-lens gating; `false` forces full lenses every push. The only
  realistic "off" case is "deterministic full fan-out," which this already
  covers — a second flag would be config surface no one needs, plus another
  `action.yml`/entry-point plumbing path.

---

## Invariants respected

1. **Full-diff scope, always (#1).** Main review + verification cover the
   complete `base...head` every push. The gate touches only the _number_ of
   recall-supplement sessions, by the incremental delta — never the diff fed to
   any session that does run, and never the main review or verify. "What changed
   since the last review" now also informs lens _selection_, not just the
   summary text; the diff each running lens sees is still full.
2. **Auxiliary sessions fail open (#3).** Skipping is a deliberate recall trade,
   the requested config is the ceiling, and every fallback runs _more_ lenses.
3. **Three-dot diff only (#7).** The incremental delta is `reviewedHead...headSha`
   (merge-base relative), matching the compare API and the main PR diff.
4. **Extract pure logic for tests (#10).** All decision logic is in `fanout.ts`
   (beside `planReviewFanout`); `runner.ts` only wires.

---

## File structure

| File                         | Change | Responsibility                                                                                    |
| ---------------------------- | ------ | ------------------------------------------------------------------------------------------------- |
| `src/shared/fanout.ts`       | Modify | Add `planIncrementalLenses` + the `LENS_TRIGGERS` map beside `planReviewFanout`.                  |
| `test/fanout.test.ts`        | Modify | Add the incremental-gating unit tests (below) alongside the existing fan-out tests.               |
| `src/shared/blast-radius.ts` | Modify | Extend `extractChangedExportedSymbols` to also scan `-export …` (removed/renamed exports).        |
| `src/shared/github.ts`       | Modify | Best-effort `compareCommits(reviewedHead, headSha)` → `PrFile[]`, mirroring `listPrFiles`.        |
| `src/shared/runner.ts`       | Modify | Compute `reviewedHead` + delta, filter lenses/guideline through `planIncrementalLenses` (wiring). |

No entry-point or `action.yml` changes — the behavior rides on the existing
`dynamic-fanout` input.

---

## Observability

One log line on a gated re-review, mirroring the Phase D fan-out line:

```
Incremental lenses since a1b2c3d: running interactions, integrity; skipping
frontend, guideline-compliance (delta touches {api,data}; main + verify unchanged).
```

---

## Testing (pure unit tests on `planIncrementalLenses`)

- `interactions` runs iff the delta patch adds, modifies, or removes an exported
  symbol (incl. a `-export …` deletion/rename); skips on a delta with no
  exported-symbol change.
- `integrity` runs iff a delta file matches `security ∪ data ∪ api`.
- `frontend` runs iff `changedFilesIncludeFrontend(deltaFiles)`.
- `guideline-compliance` skips on a test-only delta and on a docs-only delta;
  runs on a code delta.
- `deltaFiles === null` (first review / fetch failure) → inputs returned
  unchanged (no gating).
- A widened (force-push-shaped) delta touching many classes → all candidates
  kept.

The three bypass paths — no prior review, fetch failure, and
`dynamic-fanout=false` — all reach `planIncrementalLenses` as `deltaFiles: null`,
covered by the "does not gate" test (inputs returned unchanged, so the run
matches pre-change behavior exactly). The runner wiring that maps those
conditions to `null` is a single ternary verified by `tsc`; the main shards and
verification are never in the gated path (`startLensPasses`/`guideline-compliance`
only), so invariant #1 holds by construction.

---

## Out of scope (v1)

- Recording per-lens success in the review marker to avoid re-skipping a
  previously-failed lens.
- Gating the non-lens aux sessions that are already delta-conditional
  (`addressed-prior-comments`, `changes-since-last-review`).
- Any change to the LLM-judge alternative (option B) — deterministic only.

**Follow-up (separate change, not this one):** tighten
`FRONTEND_WORKFLOW_PATTERNS` in `review-playbooks.ts` so the filename-substring
rule uses word boundaries — today `review*`→`view` and `webhook*`→`hook`
false-match, which over-triggers the `frontend` gate in this repo. It improves
this gate's precision but is an independent bug fix; keeping it out keeps this
change focused.
