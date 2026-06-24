# Single-Source "Changes since last review" Block

**Goal:** Eliminate duplication and low-value verbosity in the posted review
**body** by making the "what changed since the last review" narrative a single,
whole-PR block instead of one preamble per shard. Verbose, repeated framing adds
no value for the PR author or other reviewers; this change removes it while
keeping the substantive content.

**Scope (in):** The posted review summary body only — the scope/changes
narrative and the per-shard verdict summaries that `condenseSummary` merges.

**Scope (out):** Inline finding **threads**. Cross-shard finding duplication is
already handled by `filter.ts` (`dedupe`, `suppressPreviouslyReported`,
resolved-thread rules) and is not touched here. Individual finding bodies stay
detailed by design — for a real P0–P3 bug the detail helps the author fix it.

## Problem and root cause

On a re-review of a multi-shard PR, the posted body contained three overlapping
sections that all describe the same thing — what changed since reviewed head
`368642a` — plus a shard-internal `Review of assigned files` header:

- `**Since prior reviewed head (368642a)**` — plan updated to soft-delete
- `**Changes since prior reviewed head (368642a)**` — design note rewritten, audit rename
- `**Changes since last reviewed head (368642a)**` — rebased + reformatted
- `**Review of assigned files**` — "No bugs found…"

Mechanism: each finder shard is independently instructed by
`buildSummaryScopeBlock` (`src/shared/runner.ts`) to "describe what changed since
the latest prior reviewed head" in its `summary` field. Each shard therefore
writes its own scope preamble, with slightly different header wording. The merge
step `condenseSummary` (`src/shared/report.ts`) de-duplicates by **exact
normalized header text** (`categoryKey`), so near-synonym headers
(`Since prior` vs `Changes since prior` vs `Changes since last`) hash to
different keys and all survive.

The same exact-text-keying failure mode applies to the per-shard **verdict**
lines (`No bugs found` vs `No issues identified` → both survive). So the root
cause is one thing applied in two places: **a merge step keyed on exact text,
fed synonyms by N independent agents.**

## Design

### Overview and data flow

Add a non-finder auxiliary pass that summarizes the `reviewed..head` delta once
for the whole PR. Its output is rendered as a distinct block at the top of the
review body, above the (now scope-free) per-shard verdict summaries. Finder
shards lose all "since last review" framing.

```
runPrReview
 ├─ finder shards ........ findings + concise verdict summary (NO scope preamble)   ← changed
 ├─ aux: addressed-check
 ├─ aux: guideline-compliance
 ├─ aux: finding-verification
 └─ aux: changes-since-last-review  ← NEW non-finder pass, fail-open → ''
        ↓
   buildBody(changesSinceLastReview, summary, findings, …)
        ↓  "## J-Bot Code Review"
           **Changes since last review**          ← NEW block (omitted when empty)
           <condensed per-shard verdict summary>   ← merged under one key, deduped
           **Review state:** … / **Reviewed head:** … / Findings Summary / Findings
```

This advances invariant #1 rather than bending it: the historical recall leak
(documented in the `buildSummaryScopeBlock` comment at `src/shared/runner.ts`)
happened when delta-scoping leaked into **finder** behavior. Moving the delta
summary into a dedicated **non-finder** pass means finder shards no longer see
any delta framing at all, so the leak cannot recur. The new pass posts no
findings and never narrows review scope; it produces summary text only.

### The new pass

Mirror the existing `runGuidelineComplianceCheck` aux pass exactly.

1. **Interface.** Add to `ReviewBackend` (`src/shared/runner.ts`):

   ```ts
   runChangesSinceLastReview(
     model: string,
     prContext: string,
     deltaContext: string,
     log: (msg: string) => void,
     timeoutMs?: number,
     onTokenUsage?: TokenUsageRecorder,
   ): Promise<string>;
   ```

2. **Backend implementations (full parity, all three).** Wire it in
   `createOpencodeBackend` / `createDevinBackend` / `createCommandCodeBackend`,
   each delegating to a new `run*ChangesSinceLastReview` function:
   - `src/shared/opencode.ts` → `runOpencodeChangesSinceLastReview`
   - `src/shared/devin.ts` → `runDevinChangesSinceLastReview`
   - `src/shared/commandcode.ts` → `runCommandCodeChangesSinceLastReview`

   Each is a thin "summarize this delta → return text" session call, read-only
   (invariant #8), structurally identical to that backend's existing guideline
   pass. Returns a plain narrative string (no JSON/findings parsing).

3. **Prompt and context (in `prompt.ts`).** All prompt text lives in
   `prompt.ts` (invariant) and the output reminder stays LAST (invariant #5):
   - `buildChangesSinceLastReviewPrompt(...)` — instructs the model to write a
     concise, scannable summary of what changed **between the last reviewed head
     and the current head**, in Markdown bullets; not to restate the whole PR;
     not to list findings (those are posted separately).
   - `buildChangesSinceContextBlock(reviewedHead, headSha, commitSubjects)` — a
     pure builder for a small **budgeted** block (invariant #4: hard byte cap,
     names what it omitted) containing the SHA range and the commit subjects.
     `runner.ts` does the IO: it shells `git log reviewed..head` (via the
     `execFile('git', …)` pattern already used in `blast-radius.ts`), passes the
     subjects to this pure builder, and a `git log` failure makes the pass fail
     open to `''`. For per-file detail the session runs `git diff reviewed..head`
     itself (in-session git per invariant #8) — no heavyweight embedded diff.

4. **Spawn helper (in `runner.ts`).** `startChangesSinceLastReviewSummary(...)`
   follows the `startGuidelineComplianceCheck` shape: gated by `enabled`,
   `.then` logs success, `.catch` logs `(skipped …)` and **returns `''`** — the
   "omit the block on failure" decision (invariant #3, fail open).

5. **Enable condition (pure, testable).** Extract a predicate
   `shouldSummarizeChangesSinceLastReview(priorComments, headSha)` that returns
   true only when prior jbot reviews exist **and** `findLatestReviewedHead(...)`
   yields a SHA `!== headSha` (a real delta). First review, or head unchanged →
   `false`, pass skipped, block omitted. (`findLatestReviewedHead` is exported
   alongside it for unit testing.)

### Body assembly

`buildBody` (`src/shared/runner.ts`) gains a leading `changesSinceLastReview:
string` parameter. When non-empty it renders:

```
## J-Bot Code Review

**Changes since last review**

<narrative>

<condensed per-shard summary>
```

When empty, nothing is rendered (no orphan header). The git/IO that produces the
narrative happens in `runner.ts`; `report.ts` stays pure (invariant #10) and
receives only finished text. Both `buildBody` call sites
(`src/shared/runner.ts`) pass the new argument.

### Shard summary changes

Keep the substantive per-shard verdict (e.g. "design note claims verify against
implementation: …") — it adds real information — but remove the duplication at
its source. Two prompt sites change.

**`buildSummaryScopeBlock` (`src/shared/runner.ts`) — feeds every session, so it
stays generic (accurate for one reviewer or many):**

- **Remove** the re-review branch that tells shards to "describe what changed
  since the latest prior reviewed head" and the "Latest prior reviewed head: …"
  lines. The new pass owns that narrative. What remains: the summary affects only
  the summary field, prefer concise Markdown bullets, write review conclusions,
  do not restate the whole PR.

**`buildShardAssignmentBlock` (`src/shared/prompt.ts`) — multi-shard only, so it
is the correct home for cross-reviewer rules:**

- **Add** verdict scoping beside the existing "Anchor findings ONLY in your
  assigned files" rule: your summary verdict covers **only your assigned files**;
  another reviewer summarizes the rest, so do not restate PR-wide observations,
  and do not title your summary with shard/assignment language ("Review of
  assigned files", "reviewer N") — it is merged into one shared review comment.

`shardFilesForReview` partitions changed files **disjointly** (invariant #1), so
a shard that follows this instruction vouches only for files no other shard owns
and compliant verdicts don't overlap. Be precise about the strength of this
guarantee: the disjoint partition is enforced **in code** for *findings
anchoring*, but the summary-text scoping is **prompt-level** — it relies on the
shard obeying the instruction, not on a code constraint. So this removes overlap
at the common source (and kills the `Review of assigned files` vocab leak)
rather than making overlap impossible — it is weaker than the structural
guarantee the finding partition gives. Pure-text dedup of synonym verdicts after
the fact is unreliable, which is why the fix targets the source; the residual is
below.

**Backstops (not the primary mechanism).** `condenseSummary` still dedupes
verbatim-identical lines, and `buildBody` passes
`suppressNoFindingVerdicts: total > 0` (`src/shared/runner.ts`) to drop bare
"no X found" boilerplate when findings exist. Honest coverage after the
disjoint-scope fix:

- Identical lines, or bare boilerplate with findings present → removed.
- Substantive verdicts → non-overlapping when shards comply with the own-files
  scoping (disjoint files), kept as distinct, useful content.
- **Residual:** two shards independently describing a shared cross-file symbol
  in different words can both survive. Accepted as rare. If dogfooding shows it
  matters, the escalation is a post-shard verdict-consolidation pass — a
  follow-up, not this spec.

## Invariants honored

- **#1 full-diff scope:** finder shards still review the complete `base...head`
  diff; the new pass is delta-scoped for **summary text only** and posts no
  findings.
- **#3 aux fails open:** the pass `.catch`es to `''`; a failure omits the block
  and never fails the run or drops findings.
- **#4 byte budget:** the delta context block is budgeted and names omissions.
- **#5 prompt order / single statement:** output reminder last; each rule stated
  once; prompt text only in `prompt.ts`.
- **#6 markers:** body still built through the shared builder; markers unchanged.
- **#8 read-only:** the pass is a read-only session (git allowed for inspection).
- **#10 pure logic tested:** the enable predicate and body layout are pure and
  unit-tested; `runner.ts` only wires.

## Testing

Pure logic, pinned with `node:test` + `node:assert/strict`:

- `shouldSummarizeChangesSinceLastReview`: first review → false; re-review with
  unchanged head → false; re-review with a real delta → true.
- `buildBody`: non-empty `changesSinceLastReview` → block appears under the
  `## J-Bot Code Review` header and above the summary; empty → no block and no
  orphan header.
- `buildSummaryScopeBlock` **regression pin:** output no longer contains the
  delta-narrative instruction ("changed since the latest prior reviewed head").
  This directly guards the recall leak the in-code comment warns about, and it
  stays generic (no cross-reviewer language that would be false single-shard).
- `buildShardAssignmentBlock`: output scopes the summary verdict to the shard's
  own files and forbids shard/assignment vocab ("Review of assigned files") and
  PR-wide restatement — the disjoint-scope fix that removes the common source of
  verdict overlap (a prompt-level scoping, not a code-enforced guarantee).
- `buildChangesSinceLastReviewPrompt` / context: contains the load-bearing
  phrases (summarize the delta since last review; concise; not findings) and the
  delta context respects the byte budget and lists what it omitted.
- `condenseSummary`: two shard summaries whose verdicts are header-free synonyms
  merge into a single section with the duplicate dropped.

## Files touched

- `src/shared/runner.ts` — interface method; three backend wirings; spawn
  helper; enable predicate; `buildBody` param + both call sites;
  `buildSummaryScopeBlock` simplification.
- `src/shared/opencode.ts`, `src/shared/devin.ts`, `src/shared/commandcode.ts` —
  one `run*ChangesSinceLastReview` each.
- `src/shared/prompt.ts` — new pass prompt + delta-context builder;
  `buildShardAssignmentBlock` verdict-scoping + anti-vocab-leak rule.
- `test/…` — the cases above.

No new dependencies. No change to markers, posting paths, or finder review scope.

## Out of scope / follow-ups

- Inline finding-thread de-duplication (handled by `filter.ts`).
- Code-level canonicalization of synonym verdict lines (only if dogfooding shows
  it is needed).
