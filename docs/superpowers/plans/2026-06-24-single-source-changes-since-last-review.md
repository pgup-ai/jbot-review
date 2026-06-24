# Single-Source "Changes since last review" Block — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the per-shard "what changed since last review" preamble (which triplicates on multi-shard re-reviews) with a single non-finder summary pass, and scope per-shard verdicts to their own files so they stop overlapping.

**Architecture:** A new auxiliary pass (`runChangesSinceLastReview`, implemented in all three backends) summarizes the `reviewed..head` delta once. Its text is rendered as a `**Changes since last review**` block at the top of the review body via `buildBody`; on failure it returns `''` and the block is omitted (fail open). The finder shards lose the delta instruction (`buildSummaryScopeBlock`) and gain a verdict-scoping rule (`buildShardAssignmentBlock`), so verdicts are non-overlapping by file partition.

**Tech Stack:** TypeScript ESM (run via `tsx`), `node:test` + `node:assert/strict`, esbuild, opencode SDK + Devin/CommandCode CLIs, `git` via `execFile`.

Spec: `docs/superpowers/specs/2026-06-24-scope-block-single-source-design.md`.

**Commands:** all tests `npm test`; single file `node --import tsx --test test/<file>.test.ts`; `npm run typecheck`; `npm run lint`; `npm run build`.

---

## File Structure

- `src/shared/prompt.ts` — Add the pass prompt (`CHANGES_SINCE_LAST_REVIEW_PROMPT`, `_OUTPUT_REMINDER`, `assembleChangesSinceLastReviewPrompt`), the pure delta-context builder (`buildChangesSinceContextBlock`, `CHANGES_SINCE_CONTEXT_BUDGET`), and the verdict-scoping rule in `buildShardAssignmentBlock`.
- `src/shared/opencode.ts` — Add `parseChangesSinceLastReviewSummary` (fail-open parser) and `runChangesSinceLastReview` (opencode impl).
- `src/shared/devin.ts` — Add `runDevinChangesSinceLastReview`.
- `src/shared/commandcode.ts` — Add `runCommandCodeChangesSinceLastReview`.
- `src/shared/runner.ts` — Add `runChangesSinceLastReview` to `ReviewBackend` + wire it in all three `create*Backend`; add `shouldSummarizeChangesSinceLastReview`, `collectCommitSubjects`, `startChangesSinceLastReviewSummary`; simplify `buildSummaryScopeBlock`; add the block param to `buildBody` (and export it); start/await the pass and thread its text into both `buildBody` call sites.
- `test/prompt.test.ts`, `test/opencode.test.ts`, `test/runner.test.ts` — unit tests for the pure/leaf pieces.

Order: leaf units first (builder, prompt, parser, predicate, prompt-block edits, body render), then the backend method, then the orchestration that wires them.

---

## Task 1: Pure delta-context builder

**Files:**

- Modify: `src/shared/prompt.ts` (add near the other `build*Block` helpers)
- Test: `test/prompt.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `test/prompt.test.ts` (and add `buildChangesSinceContextBlock, CHANGES_SINCE_CONTEXT_BUDGET` to the existing import from `../src/shared/prompt.ts`):

```ts
describe('buildChangesSinceContextBlock', () => {
  it('embeds the SHA range, the git diff command, and the commit subjects', () => {
    const block = buildChangesSinceContextBlock('abc1234', 'def5678', [
      '111aaaa refactor: soft-delete',
      '222bbbb chore: format',
    ]);
    assert.match(block, /## Changes since last review/);
    assert.match(block, /`abc1234`/);
    assert.match(block, /`def5678`/);
    assert.match(block, /git diff abc1234\.\.def5678/);
    assert.match(block, /- 111aaaa refactor: soft-delete/);
    assert.match(block, /- 222bbbb chore: format/);
  });

  it('budgets the commit list and names what it omitted', () => {
    const subjects = Array.from(
      { length: 500 },
      (_, i) => `${i}aaaaaa commit subject number ${i} with padding`,
    );
    const block = buildChangesSinceContextBlock('abc1234', 'def5678', subjects);
    assert.ok(block.length <= CHANGES_SINCE_CONTEXT_BUDGET + 200);
    assert.match(block, /and \d+ more commit\(s\); use the git command above\./);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/prompt.test.ts`
Expected: FAIL — `buildChangesSinceContextBlock` is not exported.

- [ ] **Step 3: Write the implementation**

Add to `src/shared/prompt.ts`:

```ts
/** Hard byte budget for the embedded commit list in the delta-context block. */
export const CHANGES_SINCE_CONTEXT_BUDGET = 4000;

/**
 * Pure builder for the "changes since last review" delta context: the SHA
 * range, the git command to inspect it, and the budgeted commit-subject list.
 * The IO that produces `commitSubjects` (a `git log` call) lives in runner.ts.
 */
export function buildChangesSinceContextBlock(
  reviewedHead: string,
  headSha: string,
  commitSubjects: string[],
): string {
  const header = `## Changes since last review

The last reviewed head was \`${reviewedHead}\`; the current head is \`${headSha}\`. Inspect exactly what changed with \`git diff ${reviewedHead}..${headSha}\`. Commits added since the last review:`;
  const kept: string[] = [];
  let used = header.length;
  for (const subject of commitSubjects) {
    const line = `- ${subject}`;
    if (used + line.length + 1 > CHANGES_SINCE_CONTEXT_BUDGET) break;
    kept.push(line);
    used += line.length + 1;
  }
  const omitted = commitSubjects.length - kept.length;
  const lines = [header, ...kept];
  if (omitted > 0) lines.push(`- _…and ${omitted} more commit(s); use the git command above._`);
  return lines.join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/prompt.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/prompt.ts test/prompt.test.ts
git commit -m "Add pure delta-context builder for changes-since-last-review pass"
```

---

## Task 2: The pass prompt

**Files:**

- Modify: `src/shared/prompt.ts` (add after the guideline-compliance prompt block)
- Test: `test/prompt.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `test/prompt.test.ts` (add `CHANGES_SINCE_LAST_REVIEW_PROMPT, CHANGES_SINCE_LAST_REVIEW_OUTPUT_REMINDER, assembleChangesSinceLastReviewPrompt` to the import):

```ts
describe('CHANGES_SINCE_LAST_REVIEW_PROMPT', () => {
  it('summarizes only the delta and forbids findings, with a concrete summary schema', () => {
    assert.match(CHANGES_SINCE_LAST_REVIEW_PROMPT, /since the last reviewed head/i);
    assert.match(CHANGES_SINCE_LAST_REVIEW_PROMPT, /do not list bugs or review findings/i);
    assert.match(CHANGES_SINCE_LAST_REVIEW_PROMPT, /"summary":/);
    assert.doesNotMatch(CHANGES_SINCE_LAST_REVIEW_PROMPT, /"findings"/);
  });

  it('puts the output reminder last and asks for a single summary key', () => {
    const out = assembleChangesSinceLastReviewPrompt('PR-CONTEXT', 'DELTA-CONTEXT');
    assert.ok(
      out.indexOf('DELTA-CONTEXT') < out.indexOf(CHANGES_SINCE_LAST_REVIEW_OUTPUT_REMINDER),
    );
    assert.ok(out.endsWith(CHANGES_SINCE_LAST_REVIEW_OUTPUT_REMINDER));
    assert.match(CHANGES_SINCE_LAST_REVIEW_OUTPUT_REMINDER, /single top-level key\s+"summary"/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/prompt.test.ts`
Expected: FAIL — constants/function not exported.

- [ ] **Step 3: Write the implementation**

Add to `src/shared/prompt.ts` (use `\\n` for literal `\n` the model should see, per repo convention):

```ts
export const CHANGES_SINCE_LAST_REVIEW_PROMPT = `You are writing a short "what changed since the last review" note for a pull request that a prior automated review already covered. A separate reviewer reports bugs; your ONLY job is to describe the delta since the last reviewed head.

## How to work

- The "Changes since last review" section below gives the last reviewed head, the current head, and the commits added between them. The full repository is checked out on the PR branch and git is available — run the \`git diff\` command shown there to see exactly what those commits changed.
- Summarize ONLY what changed between the last reviewed head and the current head. Do not restate the whole PR or re-describe unchanged code.
- Be concise and scannable: a few Markdown bullet points, one per meaningful change. Collapse trivial churn (formatting, rebases, merges) into a single bullet.
- Describe changes factually. Do not list bugs or review findings, and do not pass judgement on correctness — findings are produced separately.

## Output

Respond with a SINGLE raw JSON object and NOTHING else — no text before or after it, and no markdown fences. Markdown is allowed only inside the JSON string value; escape newlines inside the string as \\n.

{
  "summary": "- Reworked the archive path from a bespoke flag to the global soft-delete filter.\\n- Renamed the audit action constant and updated both call sites.\\n- Rebased and reformatted (no behavioral change)."
}`;

export const CHANGES_SINCE_LAST_REVIEW_OUTPUT_REMINDER = `## Final output reminder

Respond now with one raw JSON object with the single top-level key "summary", a Markdown string describing only what changed since the last reviewed head. No text before or after the JSON, no markdown fences, and escape newlines inside the string as \\n. Do not include findings, questions, or a completion note.`;

export function assembleChangesSinceLastReviewPrompt(
  prContext: string,
  deltaContext: string,
): string {
  return [
    CHANGES_SINCE_LAST_REVIEW_PROMPT,
    deltaContext,
    prContext,
    CHANGES_SINCE_LAST_REVIEW_OUTPUT_REMINDER,
  ].join('\n\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/prompt.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/prompt.ts test/prompt.test.ts
git commit -m "Add changes-since-last-review pass prompt"
```

---

## Task 3: Fail-open summary parser

**Files:**

- Modify: `src/shared/opencode.ts` (add next to `parseReview`)
- Test: `test/opencode.test.ts` (create if absent)

- [ ] **Step 1: Write the failing test**

Create or extend `test/opencode.test.ts`:

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseChangesSinceLastReviewSummary } from '../src/shared/opencode.ts';

const noop = () => {};

describe('parseChangesSinceLastReviewSummary', () => {
  it('extracts the summary string from a valid object', () => {
    const out = parseChangesSinceLastReviewSummary(
      '{"summary":"- did a thing"}',
      'changes-since',
      noop,
    );
    assert.equal(out, '- did a thing');
  });

  it('returns empty string on unparseable output (fail open, omit the block)', () => {
    const out = parseChangesSinceLastReviewSummary('not json at all', 'changes-since', noop);
    assert.equal(out, '');
  });

  it('returns empty string when summary is missing or not a string', () => {
    assert.equal(parseChangesSinceLastReviewSummary('{"findings":[]}', 'changes-since', noop), '');
    assert.equal(parseChangesSinceLastReviewSummary('{"summary":42}', 'changes-since', noop), '');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/opencode.test.ts`
Expected: FAIL — `parseChangesSinceLastReviewSummary` not exported.

- [ ] **Step 3: Write the implementation**

Add to `src/shared/opencode.ts` (immediately after `parseReview`; it reuses the in-module `parseJsonObject`):

```ts
/**
 * Parses the "changes since last review" pass output. Unlike parseReview, an
 * unparseable or summary-less response yields '' (not a placeholder string) so
 * the caller OMITS the block — the pass fails open.
 */
export function parseChangesSinceLastReviewSummary(
  raw: string,
  label: string,
  log: (msg: string) => void,
): string {
  try {
    const obj = parseJsonObject(raw) as Record<string, unknown>;
    return typeof obj.summary === 'string' ? obj.summary.trim() : '';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(
      `${label} response was not valid JSON; omitting the changes-since-last-review block: ${message}`,
    );
    return '';
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/opencode.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/opencode.ts test/opencode.test.ts
git commit -m "Add fail-open parser for changes-since-last-review summary"
```

---

## Task 4: Enable predicate

**Files:**

- Modify: `src/shared/runner.ts` (add near `buildSummaryScopeBlock`/`findLatestReviewedHead`)
- Test: `test/runner.test.ts`

`findLatestReviewedHead` already exists in `runner.ts` as a private function; `isJbotReviewBody` is already imported. The predicate reuses both.

- [ ] **Step 1: Write the failing test**

Add to `test/runner.test.ts` (add `shouldSummarizeChangesSinceLastReview` to the import from `../src/shared/runner.ts`):

```ts
describe('shouldSummarizeChangesSinceLastReview', () => {
  const priorReview = (sha: string) =>
    `## J-Bot Code Review\n\n**Reviewed head:** [\`${sha}\`](https://github.com/o/r/commit/${sha})\n\n<!-- jbot-review:review -->`;

  it('is false on the first review (no prior jbot reviews)', () => {
    assert.equal(shouldSummarizeChangesSinceLastReview([], 'def5678'), false);
  });

  it('is false when the head is unchanged since the last review', () => {
    const sha = 'a'.repeat(40);
    assert.equal(shouldSummarizeChangesSinceLastReview([priorReview(sha)], sha), false);
  });

  it('is true on a re-review with a real delta', () => {
    const prior = 'a'.repeat(40);
    assert.equal(shouldSummarizeChangesSinceLastReview([priorReview(prior)], 'b'.repeat(40)), true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/runner.test.ts`
Expected: FAIL — `shouldSummarizeChangesSinceLastReview` not exported.

- [ ] **Step 3: Write the implementation**

Add to `src/shared/runner.ts` (just above `buildSummaryScopeBlock`):

```ts
/**
 * The changes-since-last-review pass runs only on a re-review with a real
 * delta: prior jbot reviews exist AND the latest reviewed head differs from the
 * current head. First review or unchanged head → skip (block omitted).
 */
export function shouldSummarizeChangesSinceLastReview(
  priorComments: string[],
  headSha?: string,
): boolean {
  const priorJbotReviews = priorComments.filter(isJbotReviewBody);
  if (priorJbotReviews.length === 0) return false;
  const latestReviewedHead = findLatestReviewedHead(priorJbotReviews);
  return Boolean(latestReviewedHead && headSha && latestReviewedHead !== headSha);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/runner.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/runner.ts test/runner.test.ts
git commit -m "Add enable predicate for changes-since-last-review pass"
```

---

## Task 5: Simplify buildSummaryScopeBlock (remove the delta instruction)

**Files:**

- Modify: `src/shared/runner.ts` — `buildSummaryScopeBlock` (body) and its call site (`const summaryScopeBlock = buildSummaryScopeBlock(priorComments, headSha);`)
- Test: `test/runner.test.ts`

- [ ] **Step 1: Write the failing test (regression pin)**

Add to `test/runner.test.ts` (add `buildSummaryScopeBlock` to the import):

```ts
describe('buildSummaryScopeBlock', () => {
  it('no longer instructs shards to describe changes since the reviewed head', () => {
    const block = buildSummaryScopeBlock();
    assert.doesNotMatch(block, /reviewed head/i);
    assert.doesNotMatch(block, /Latest prior reviewed head/i);
  });

  it('keeps the scope guardrail and asks for conclusions only', () => {
    const block = buildSummaryScopeBlock();
    assert.match(block, /ONLY the text of the "summary" field/);
    assert.match(block, /review conclusions/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/runner.test.ts`
Expected: FAIL — `buildSummaryScopeBlock()` still takes args / still mentions "reviewed head".

- [ ] **Step 3: Write the implementation**

Replace the body of `buildSummaryScopeBlock` in `src/shared/runner.ts`. **Keep the existing doc comment above it** (it documents the recall-leak history and is load-bearing). New version takes no args:

```ts
export function buildSummaryScopeBlock(): string {
  return [
    '## Summary instructions',
    '- These instructions affect ONLY the text of the "summary" field. They never change what you review: findings always come from the complete PR diff.',
    '- Prefer concise Markdown bullet points in the "summary" field when they make the review easier to scan.',
    '- Summarize your review conclusions for the changes you examined. Do not restate the overall PR; a separate "Changes since last review" note covers what changed.',
  ].join('\n');
}
```

Keep the private `findLatestReviewedHead` helper — `buildSummaryScopeBlock` no longer calls it, but `shouldSummarizeChangesSinceLastReview` (Task 4) does. Update the single call site:

```ts
const summaryScopeBlock = buildSummaryScopeBlock();
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import tsx --test test/runner.test.ts && npm run typecheck`
Expected: PASS, and typecheck clean (the call-site arity matches the new signature).

- [ ] **Step 5: Commit**

```bash
git add src/shared/runner.ts test/runner.test.ts
git commit -m "Drop per-shard delta instruction from buildSummaryScopeBlock"
```

---

## Task 6: Verdict-scoping rule in buildShardAssignmentBlock

**Files:**

- Modify: `src/shared/prompt.ts` — `buildShardAssignmentBlock`
- Test: `test/prompt.test.ts` (extend the existing `describe('buildShardAssignmentBlock', …)`)

- [ ] **Step 1: Write the failing test**

Add inside the existing `describe('buildShardAssignmentBlock', …)` in `test/prompt.test.ts`:

```ts
it('scopes the summary verdict to own files and forbids shard/assignment vocab', () => {
  assert.match(block, /describe only your own review conclusions for your assigned files/i);
  assert.match(block, /do not restate PR-wide observations/i);
  assert.match(block, /Review of assigned files/); // named as a banned title
  assert.match(block, /merged into one shared review comment/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/prompt.test.ts`
Expected: FAIL — the new rule line is absent.

- [ ] **Step 3: Write the implementation**

In `src/shared/prompt.ts`, add one bullet to the `Rules for this split:` list returned by `buildShardAssignmentBlock`, after the existing `- The diff hunks below cover your assigned files; …` line:

```ts
    '- In the "summary" field, describe only your own review conclusions for your assigned files; another reviewer covers the rest. Do not restate PR-wide observations, and do not title your summary with shard or assignment wording (e.g. "Review of assigned files", "reviewer 1") — all summaries are merged into one shared review comment.',
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/prompt.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/prompt.ts test/prompt.test.ts
git commit -m "Scope per-shard verdicts to own files to remove overlap at the source"
```

---

## Task 7: Render the block in buildBody (and export it)

**Files:**

- Modify: `src/shared/runner.ts` — `buildBody` (add first param + render; add `export`)
- Test: `test/runner.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `test/runner.test.ts` (add `buildBody` to the import):

```ts
describe('buildBody changes-since-last-review block', () => {
  it('renders the block above the summary when present', () => {
    const body = buildBody(
      '- Reworked archive path.',
      '- Verdict looks good.',
      [],
      [],
      'm',
      'o',
      'r',
    );
    assert.match(body, /## J-Bot Code Review/);
    assert.match(body, /\*\*Changes since last review\*\*/);
    assert.ok(
      body.indexOf('Changes since last review') < body.indexOf('Verdict looks good'),
      'block must precede the summary',
    );
  });

  it('omits the block (and its header) when the text is empty', () => {
    const body = buildBody('', '- Verdict looks good.', [], [], 'm', 'o', 'r');
    assert.doesNotMatch(body, /Changes since last review/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/runner.test.ts`
Expected: FAIL — `buildBody` not exported / wrong arity.

- [ ] **Step 3: Write the implementation**

In `src/shared/runner.ts`, change `buildBody` to add `export` and a leading `changesSinceLastReview: string` parameter, and render the block. Replace the signature and the opening of the `lines` array:

```ts
export function buildBody(
  changesSinceLastReview: string,
  summary: string,
  all: Finding[],
  orphaned: Finding[],
  model: string,
  owner: string,
  repo: string,
  headSha?: string,
  tokenUsage?: ReviewTokenUsage,
): string {
  const total = all.length;
  const lines = ['## J-Bot Code Review', ''];
  if (changesSinceLastReview.trim()) {
    lines.push('**Changes since last review**', '', changesSinceLastReview.trim(), '');
  }
  lines.push(
    summary
      ? formatSummaryMarkdown(summary, { suppressNoFindingVerdicts: total > 0 })
      : 'No summary provided.',
    '',
  );
```

Leave the rest of `buildBody` (merge guidance, reviewed head, findings table, orphaned section, metadata) unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/runner.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/runner.ts test/runner.test.ts
git commit -m "Render Changes-since-last-review block at the top of the review body"
```

---

## Task 8: Backend method — interface + three implementations + wiring

This task is mechanical and integration-level; it is verified by `npm run typecheck` and the full suite (no regressions). The parse/prompt behavior it relies on is already unit-tested (Tasks 2–3).

**Files:**

- Modify: `src/shared/opencode.ts`, `src/shared/devin.ts`, `src/shared/commandcode.ts`, `src/shared/runner.ts`

- [ ] **Step 1: opencode implementation** — add to `src/shared/opencode.ts`:

```ts
export async function runChangesSinceLastReview(
  client: OpencodeClient,
  model: string,
  prContext: string,
  deltaContext: string,
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
): Promise<string> {
  const prompt = assembleChangesSinceLastReviewPrompt(prContext, deltaContext);
  const { raw } = await promptPlanAgent(
    client,
    model,
    prompt,
    'changes-since-last-review',
    log,
    timeoutMs,
    onTokenUsage,
  );
  return parseChangesSinceLastReviewSummary(raw, 'changes-since-last-review', log);
}
```

Add `assembleChangesSinceLastReviewPrompt` to the existing import from `./prompt.ts` in `opencode.ts`.

- [ ] **Step 2: devin implementation** — add to `src/shared/devin.ts`:

```ts
export async function runDevinChangesSinceLastReview(
  workspace: string,
  model: string,
  prContext: string,
  deltaContext: string,
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
): Promise<string> {
  const raw = await runDevinPrompt(
    workspace,
    model,
    assembleChangesSinceLastReviewPrompt(prContext, deltaContext),
    'changes-since-last-review',
    log,
    timeoutMs,
    onTokenUsage,
  );
  return parseChangesSinceLastReviewSummary(raw, 'changes-since-last-review', log);
}
```

Add `assembleChangesSinceLastReviewPrompt` to the `./prompt.ts` import and `parseChangesSinceLastReviewSummary` to the `./opencode.ts` import in `devin.ts`.

- [ ] **Step 3: commandcode implementation** — add to `src/shared/commandcode.ts` (note the `home?` param and `void onTokenUsage`, matching its guideline pass):

```ts
export async function runCommandCodeChangesSinceLastReview(
  workspace: string,
  model: string,
  prContext: string,
  deltaContext: string,
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
  home?: string,
): Promise<string> {
  void onTokenUsage;
  const raw = await runCommandCodePrompt(
    workspace,
    model,
    assembleChangesSinceLastReviewPrompt(prContext, deltaContext),
    'changes-since-last-review',
    log,
    timeoutMs,
    home,
  );
  return parseChangesSinceLastReviewSummary(raw, 'changes-since-last-review', log);
}
```

Add the matching imports to `commandcode.ts`.

- [ ] **Step 4: interface + wiring in `src/shared/runner.ts`**

Add to the `ReviewBackend` interface, after `runFindingVerification(...)`:

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

Add imports: `runChangesSinceLastReview as runOpencodeChangesSinceLastReview` (from `./opencode.ts`), `runDevinChangesSinceLastReview` (from `./devin.ts`), `runCommandCodeChangesSinceLastReview` (from `./commandcode.ts`).

Wire it in each `create*Backend`:

```ts
// createOpencodeBackend
    runChangesSinceLastReview: (model, prContext, deltaContext, log, timeoutMs, onTokenUsage) =>
      runOpencodeChangesSinceLastReview(client, model, prContext, deltaContext, log, timeoutMs, onTokenUsage),
// createDevinBackend
    runChangesSinceLastReview: (model, prContext, deltaContext, log, timeoutMs, onTokenUsage) =>
      runDevinChangesSinceLastReview(workspace, model, prContext, deltaContext, log, timeoutMs, onTokenUsage),
// createCommandCodeBackend
    runChangesSinceLastReview: (model, prContext, deltaContext, log, timeoutMs, onTokenUsage) =>
      runCommandCodeChangesSinceLastReview(workspace, model, prContext, deltaContext, log, timeoutMs, onTokenUsage, home),
```

- [ ] **Step 5: Verify typecheck + full suite**

Run: `npm run typecheck && npm test`
Expected: PASS (every `ReviewBackend` literal now implements the new method; no behavior change yet — nothing calls it).

- [ ] **Step 6: Commit**

```bash
git add src/shared/opencode.ts src/shared/devin.ts src/shared/commandcode.ts src/shared/runner.ts
git commit -m "Add runChangesSinceLastReview backend method across all three backends"
```

---

## Task 9: Git IO + orchestration wiring

This is the integration step that activates the pass. Verified by `npm run typecheck` + full suite + a manual dry run.

**Files:**

- Modify: `src/shared/runner.ts`

- [ ] **Step 1: Add the git helper + the spawn helper**

Ensure `runner.ts` can call git. If it does not already import `execFile`, add at the top:

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const GIT_LOG_TIMEOUT_MS = 15_000;
```

Add the IO helper and the fail-open spawn helper near the other `start*` helpers:

```ts
/** Commit subjects (`<short-sha> <subject>`) added between two revisions, in the checkout. */
async function collectCommitSubjects(
  workspace: string,
  fromSha: string,
  toSha: string,
): Promise<string[]> {
  const { stdout } = await execFileAsync(
    'git',
    ['log', '--no-merges', '--format=%h %s', `${fromSha}..${toSha}`],
    { cwd: workspace, timeout: GIT_LOG_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
  );
  return stdout.split('\n').filter(Boolean);
}

function startChangesSinceLastReviewSummary(params: {
  backend: ReviewBackend;
  model: string;
  prContext: string;
  workspace: string;
  reviewedHead?: string;
  headSha?: string;
  enabled: boolean;
  timeoutMs?: number;
  log: (msg: string) => void;
  onTokenUsage?: TokenUsageRecorder;
}): Promise<string> {
  if (!params.enabled || !params.reviewedHead || !params.headSha) return Promise.resolve('');
  const reviewedHead = params.reviewedHead;
  const headSha = params.headSha;
  params.log('Starting changes-since-last-review summary in parallel.');
  return (async () => {
    const subjects = await collectCommitSubjects(params.workspace, reviewedHead, headSha);
    if (subjects.length === 0) {
      params.log('changes-since-last-review skipped: no commits since last reviewed head.');
      return '';
    }
    const deltaContext = buildChangesSinceContextBlock(reviewedHead, headSha, subjects);
    return params.backend.runChangesSinceLastReview(
      params.model,
      params.prContext,
      deltaContext,
      params.log,
      params.timeoutMs,
      params.onTokenUsage,
    );
  })()
    .then((text) => {
      params.log(`changes-since-last-review summary complete: ${text.length} chars`);
      return text;
    })
    .catch((error) => {
      params.log(
        `(skipped changes-since-last-review summary: ${error instanceof Error ? error.message : String(error)})`,
      );
      return '';
    });
}
```

Add `buildChangesSinceContextBlock` to the existing import from `./prompt.ts`.

- [ ] **Step 2: Start the pass alongside the other aux sessions**

In `runPrReview`, right after the `guidelineComplianceCheck` block (around the `startGuidelineComplianceCheck({...})` call), add:

```ts
const changesSinceLastReview = trackAuxiliarySession(
  'changes-since-last-review',
  startChangesSinceLastReviewSummary({
    backend: auxBackend,
    model: auxModel,
    prContext: auxPrContext,
    workspace,
    reviewedHead: findLatestReviewedHead(priorComments.filter(isJbotReviewBody)),
    headSha,
    enabled:
      shouldSummarizeChangesSinceLastReview(priorComments, headSha) &&
      auxCommandCodeHasCompleteDiff,
    timeoutMs: finderTimeoutMs,
    log,
    onTokenUsage: recordTokenUsage,
  }),
);
```

- [ ] **Step 3: Await it with the other aux sessions**

Add `changesSinceLastReview` to the `pendingAuxiliarySessionLabels([...])` array, and await its text alongside the others (near `const complianceFindings = await guidelineComplianceCheck.promise;`):

```ts
const changesSinceText = await changesSinceLastReview.promise;
```

- [ ] **Step 4: Thread the text into both `buildBody` calls**

Both call sites (the `options.dryRun` branch and the posting branch) gain `changesSinceText` as the new first argument:

```ts
const body = buildBody(
  changesSinceText,
  summary,
  filteredFindings,
  orphaned,
  model,
  owner,
  repo,
  headSha,
  tokenUsage.snapshot(),
);
```

- [ ] **Step 5: Verify typecheck, lint, full suite, build**

Run: `npm run typecheck && npm run lint && npm test && npm run build`
Expected: all PASS.

- [ ] **Step 6: Manual integration check (dry run)**

Run the replay/dry-run harness on a fixture that has a prior jbot review with a different `Reviewed head` SHA, and confirm the rendered body shows a single `**Changes since last review**` block above the summary and no duplicated `Review of assigned files` headers:

Run: `npm run replay`
Expected: one delta block; no triplicated scope sections. (If the fixture has no prior review, the block is correctly absent.)

- [ ] **Step 7: Commit**

```bash
git add src/shared/runner.ts
git commit -m "Wire changes-since-last-review pass into the review run"
```

---

## Task 10: Final verification

- [ ] **Step 1: Full gate**

Run: `npm run typecheck && npm run lint && npm test && npm run build`
Expected: all green.

- [ ] **Step 2: Confirm spec coverage** — every spec section maps to a task (see Self-Review below).

- [ ] **Step 3: Commit any final fixups** (only if needed):

```bash
git add -A
git commit -m "Finalize single-source changes-since-last-review block"
```

---

## Self-Review

**Spec coverage:**

- New single non-finder pass → Tasks 2, 3, 8, 9. ✓
- Fail open → omit on failure → Task 3 (parser → `''`) + Task 9 (spawn `.catch` → `''`) + Task 7 (omit when empty). ✓
- Full backend parity (3 backends) → Task 8. ✓
- Body block above summary, `report.ts` pure → Task 7 (render in `runner.ts`; `report.ts` untouched). ✓
- Remove delta instruction from `buildSummaryScopeBlock` → Task 5. ✓
- Verdict disjoint-scoping + vocab-leak fix in `buildShardAssignmentBlock` → Task 6. ✓
- Budgeted delta context + in-session git → Task 1 (budget) + Task 9 (git log + `git diff` instruction in the Task 2 prompt). ✓
- Enable only on real re-review delta → Task 4 + Task 9 gate. ✓
- Tests: predicate, body placement, scope-block regression pin, prompt structure, parser → Tasks 1–7. ✓

**Type/name consistency:** `runChangesSinceLastReview` (interface + opencode export, aliased `runOpencode…` on import; `runDevin…`/`runCommandCode…` exports), `parseChangesSinceLastReviewSummary`, `buildChangesSinceContextBlock`, `assembleChangesSinceLastReviewPrompt`, `shouldSummarizeChangesSinceLastReview`, `collectCommitSubjects`, `startChangesSinceLastReviewSummary`, `changesSinceText` — used identically across tasks. `buildBody` first param `changesSinceLastReview` matches both call sites in Task 9.

**Note for the implementer:** `buildSummaryScopeBlock` loses its parameters in Task 5; its single call site is updated in the same task. `findLatestReviewedHead` stays (now used by the predicate). The commandcode method keeps the trailing `home?` param to match its sibling passes.
