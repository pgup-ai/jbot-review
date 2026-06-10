# Review Prompt & Pipeline Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply all findings from the jbot-review architecture/prompt review so the review agent gets reliable results from smaller models: pin the diff scope (A1), put the output contract last (A2), replace union-syntax schema with a concrete example (A3), tolerate both key casings (A4), state each rule once (B1), resolve the thorough-vs-shortest tension (B2), make the dedicated session the single owner of addressed-thread checks (B3), and enforce the low-confidence rule in code (B4), plus front-load an explanation of how the wrapper uses the output (C1/C2). Two additional parity gaps are covered: written repo standards (TECHNICAL_STANDARDS.md, `.pr-governance/`) are reliably enforced via preloading plus a dedicated guideline-compliance session (D1), and architecture becomes a first-class review dimension (D2).

**Architecture:** All prompt text moves into `src/shared/prompt.ts` (pure data + pure assembly functions, fully unit-testable). The diff scope (base/head + exact `git diff` command) is computed in `src/shared/review-context.ts` and threaded from both entry points through `runPrReview`. Trust-boundary rules that were prompt-only (low-confidence blocking findings) move into code in `src/shared/filter.ts`. The parallel addressed-prior-comments session becomes the single owner of `addressedPriorComments`; the main review schema shrinks to `summary` + `findings`. Guideline discovery preloads governance-referenced docs and gains a dedicated parallel compliance session whose findings are deduped against the main review's (reusing the existing parallel-session pattern from the addressed-check). An `architecture` finding kind plus explicit design checks in the main prompt make structural review first-class.

**Tech Stack:** TypeScript (ESM, `.ts` imports via tsx), Node built-in test runner (`node --import tsx --test`), `node:assert/strict`. No new dependencies.

**Background reading for the implementer:**

- `src/shared/prompt.ts` — the static review prompt (rewritten by this plan).
- `src/shared/opencode.ts` — opencode server lifecycle, prompt sessions, JSON parsing (`parseReview`, `parseJsonObject`).
- `src/shared/runner.ts` — orchestration: context assembly, filtering, posting.
- `src/shared/review-context.ts` — `buildReviewContext` + guideline discovery.
- `src/shared/github.ts` — `formatPriorJbotThreadsForPrompt` (canonical prior-thread rules live here after this plan).
- Tests run with: `npm test` (all) or `node --import tsx --test test/<file>.test.ts` (single file).
- Lint/typecheck: `npm run typecheck`, `npm run lint`, `npm run format:check`.

**Conventions in this plan:**

- All file paths are relative to the repo root `/Users/jingbofu/Desktop/repo/jbot-review`.
- Prompt constants are TypeScript template literals: a literal backtick inside them must be written `` \` `` and a literal `\n` the model should _see as text_ must be written `\\n`.
- Every task ends with a commit. Keep `npm run format` happy before committing (Prettier owns formatting).

---

## File structure (end state)

| File                                | Responsibility after this plan                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/shared/prompt.ts`              | ALL prompt text: `REVIEW_PROMPT` (incl. architecture dimension), `REVIEW_OUTPUT_REMINDER`, `ADDRESSED_PRIOR_COMMENTS_PROMPT`, `ADDRESSED_OUTPUT_REMINDER`, `GUIDELINE_COMPLIANCE_PROMPT`, `GUIDELINE_COMPLIANCE_OUTPUT_REMINDER`, plus pure assembly functions `assembleReviewPrompt()`, `assembleAddressedPriorCommentsPrompt()`, and `assembleGuidelineCompliancePrompt()` |
| `src/shared/types.ts`               | `FindingKind` gains `'architecture'`                                                                                                                                                                                                                                                                                                                                         |
| `src/shared/review-context.ts`      | Adds `DiffScope` interface and `formatDiffScope()`; `buildReviewContext()` gains optional `diffScope` param; `TECHNICAL_STANDARDS.md`/`ARCHITECTURE.md` in discovery lists; governance README references preloaded; guidance budget 24KB/file, 96KB total                                                                                                                    |
| `src/shared/filter.ts`              | Adds `demoteLowConfidenceBlockingFindings()` and `dedupeFindings()` next to `isNoiseFile()`                                                                                                                                                                                                                                                                                  |
| `src/shared/opencode.ts`            | Uses assembly functions from prompt.ts; `parseReview` exported and tolerant of both `addressedByCommit`/`addressed_by_commit`; `VALID_FINDING_KINDS` gains `'architecture'`; new `runGuidelineComplianceCheck()`; local `ADDRESSED_PRIOR_COMMENTS_PROMPT` constant removed                                                                                                   |
| `src/shared/runner.ts`              | Accepts `baseRef`/`baseSha`; injects diff scope into both context paths; applies confidence gate; uses ONLY the dedicated addressed-check result (merge removed); starts parallel guideline-compliance session and dedupes its findings; `guidelinePass` option                                                                                                              |
| `src/shared/github.ts`              | `formatPriorJbotThreadsForPrompt` header becomes the single canonical statement of prior-thread rules                                                                                                                                                                                                                                                                        |
| `src/workflow/index.ts`             | Passes `baseRef`/`baseSha` from the PR payload; parses `enable-guideline-pass` input                                                                                                                                                                                                                                                                                         |
| `src/app/app.ts`                    | Passes `headSha`, `baseRef`, `baseSha` from the webhook payload                                                                                                                                                                                                                                                                                                              |
| `action.yml`                        | New `enable-guideline-pass` input + env passthrough                                                                                                                                                                                                                                                                                                                          |
| `scripts/replay-review.ts`          | Passes optional diff scope from `pr.json` fixture                                                                                                                                                                                                                                                                                                                            |
| `fixtures/replay/pr.json`           | Gains `baseRef`/`baseSha`/`headSha` fields                                                                                                                                                                                                                                                                                                                                   |
| `test/review-context.test.ts`       | New describe blocks for `formatDiffScope` and `buildReviewContext` diff scope; updated/new guideline-discovery assertions                                                                                                                                                                                                                                                    |
| `test/filter.test.ts` (new)         | Tests for `demoteLowConfidenceBlockingFindings` and `dedupeFindings`                                                                                                                                                                                                                                                                                                         |
| `test/opencode-parse.test.ts` (new) | Tests for `parseReview` (casing tolerance, extraction, strict mode, architecture kind)                                                                                                                                                                                                                                                                                       |
| `test/prompt.test.ts` (new)         | Invariant tests for all prompt texts and assembly ordering                                                                                                                                                                                                                                                                                                                   |
| `test/github.test.ts`               | Updated assertions for the canonical prior-thread rules block                                                                                                                                                                                                                                                                                                                |

---

### Task 1: Diff scope in review context (A1 core)

The model is never told the PR's base branch or the exact diff command. Add a `DiffScope` type and `formatDiffScope()` to `src/shared/review-context.ts`, and render it inside the `## Pull request` section of `buildReviewContext`.

Design decisions (do not relitigate):

- **Three-dot diff (`base...head`) is mandatory.** GitHub's patch — which `parseAddedLines` anchors against — is merge-base-relative; two-dot would include base-branch drift and produce orphaned findings.
- **Prefer SHAs over refs** in the command (unambiguous in both checkout modes). Fall back to `origin/<baseRef>...HEAD` when SHAs are missing (workflow mode with `fetch-depth: 0` has `origin/*` refs).
- Shallow hosted clones (`--depth=50`) may lack the merge base; that is acceptable — the agent falls back to its own exploration, which is no worse than today.

**Files:**

- Modify: `src/shared/review-context.ts` (top of file, around the existing `BuildReviewContextParams` at lines 4-29)
- Test: `test/review-context.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `test/review-context.test.ts` (it already imports `assert`, `describe`, `it`; extend the import from the source module):

Change the existing import line:

```typescript
import { discoverGuidelines } from '../src/shared/review-context.ts';
```

to:

```typescript
import {
  buildReviewContext,
  discoverGuidelines,
  formatDiffScope,
} from '../src/shared/review-context.ts';
```

Append at the end of the file:

```typescript
describe('formatDiffScope', () => {
  it('prefers SHAs and emits a three-dot diff command', () => {
    const baseSha = 'a'.repeat(40);
    const headSha = 'b'.repeat(40);
    const text = formatDiffScope({ baseRef: 'develop', baseSha, headSha });

    assert.match(text, /Base: develop \(a{40}\)/);
    assert.match(text, /Head: b{40}/);
    assert.match(text, new RegExp(`git diff ${baseSha}\\.\\.\\.${headSha}`));
    assert.match(text, /Only review changes within this diff\./);
  });

  it('falls back to origin/<baseRef>...HEAD when SHAs are missing', () => {
    const text = formatDiffScope({ baseRef: 'main' });

    assert.match(text, /Base: main/);
    assert.match(text, /git diff origin\/main\.\.\.HEAD/);
  });

  it('uses HEAD when only the base SHA is known', () => {
    const baseSha = 'c'.repeat(40);
    const text = formatDiffScope({ baseSha });

    assert.match(text, new RegExp(`git diff ${baseSha}\\.\\.\\.HEAD`));
  });

  it('returns an empty string when no scope data is available', () => {
    assert.equal(formatDiffScope({}), '');
  });
});

describe('buildReviewContext', () => {
  const baseParams = {
    pullTitle: 'Add retry logic',
    pullBody: '',
    changedFiles: ['src/a.ts'],
    priorComments: [],
    commits: [],
    checkSummary: 'All checks passed',
    guidelines: '',
  };

  it('embeds the diff scope inside the Pull request section', () => {
    const context = buildReviewContext({
      ...baseParams,
      diffScope: { baseRef: 'main', baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) },
    });

    const sections = context.split('\n\n');
    const prSection = sections.find((section) => section.startsWith('## Pull request')) ?? '';
    assert.match(prSection, /Base: main/);
    assert.match(prSection, /git diff a{40}\.\.\.b{40}/);
  });

  it('omits the diff scope lines when no scope is provided', () => {
    const context = buildReviewContext(baseParams);

    assert.doesNotMatch(context, /git diff/);
    assert.doesNotMatch(context, /Base:/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import tsx --test test/review-context.test.ts`
Expected: FAIL — `formatDiffScope` is not exported / `diffScope` is not a known property.

- [ ] **Step 3: Implement `DiffScope`, `formatDiffScope`, and the `buildReviewContext` extension**

In `src/shared/review-context.ts`, add directly after the `ReviewCommit` interface (after line 8):

```typescript
export interface DiffScope {
  baseRef?: string;
  baseSha?: string;
  headSha?: string;
}

/**
 * Renders the PR base/head and the exact three-dot diff command the agent
 * should run. Three-dot (merge-base) diff is required: GitHub's patch — which
 * inline-comment anchors are validated against — is merge-base-relative.
 * Returns '' when nothing about the scope is known.
 */
export function formatDiffScope(scope: DiffScope): string {
  const lines: string[] = [];
  if (scope.baseRef || scope.baseSha) {
    const sha = scope.baseSha ? ` (${scope.baseSha})` : '';
    lines.push(`Base: ${scope.baseRef ?? '(unknown ref)'}${sha}`);
  }
  if (scope.headSha) lines.push(`Head: ${scope.headSha}`);

  const base = scope.baseSha ?? (scope.baseRef ? `origin/${scope.baseRef}` : undefined);
  if (base) {
    const head = scope.headSha ?? 'HEAD';
    lines.push(
      'To see exactly what this PR changes, run:',
      `    git diff ${base}...${head}`,
      'Only review changes within this diff.',
    );
  }
  return lines.join('\n');
}
```

Add the optional field to `BuildReviewContextParams`:

```typescript
export interface BuildReviewContextParams {
  pullTitle: string;
  pullBody: string;
  changedFiles: string[];
  priorComments: string[];
  commits: ReviewCommit[];
  checkSummary: string;
  guidelines: string;
  diffScope?: DiffScope;
}
```

Replace the first `sections.push(...)` block in `buildReviewContext` (currently lines 23-29):

```typescript
const pullRequestLines = [
  '## Pull request',
  `Title: ${params.pullTitle || '(untitled)'}`,
  params.pullBody ? `Description:\n${params.pullBody}` : 'Description: (none)',
];
const diffScopeText = params.diffScope ? formatDiffScope(params.diffScope) : '';
if (diffScopeText) pullRequestLines.push(diffScopeText);
sections.push(pullRequestLines.join('\n'));
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --import tsx --test test/review-context.test.ts`
Expected: PASS (all pre-existing `discoverGuidelines` tests must also still pass).

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
npm run format
git add src/shared/review-context.ts test/review-context.test.ts
git commit -m "feat: add PR diff scope (base/head + exact git diff command) to review context"
```

---

### Task 2: Wire diff scope through runner, entry points, and replay (A1 wiring)

Thread `baseRef`/`baseSha` from both entry points into `runPrReview`, and render the scope in BOTH context paths (enhanced and basic). Also fix a latent gap: the hosted app never passed `headSha` at all (so check summaries, reviewed-head footers, and addressed replies were degraded there).

**Files:**

- Modify: `src/shared/runner.ts` (params at lines 49-77, context assembly at lines 113-149)
- Modify: `src/workflow/index.ts` (the `runPrReview` call at lines 62-76)
- Modify: `src/app/app.ts` (the `runPrReview` call at lines 39-50)
- Modify: `scripts/replay-review.ts`
- Modify: `fixtures/replay/pr.json`

No new unit tests in this task — it is pure plumbing of already-tested functions. Verification is typecheck + full test suite + a replay smoke run that shows the diff command in the output.

- [ ] **Step 1: Extend `runPrReview` parameters**

In `src/shared/runner.ts`, the params object type currently includes `headSha?: string;`. Add two fields beside it:

```typescript
  headSha?: string;
  baseRef?: string;
  baseSha?: string;
```

Extend the destructuring at the top of `runPrReview` (currently lines 64-76) to include the new fields:

```typescript
const {
  octokit,
  owner,
  repo,
  pullNumber,
  pullTitle,
  pullBody,
  workspace,
  model,
  apiKey,
  headSha,
  baseRef,
  baseSha,
  log,
} = params;
```

- [ ] **Step 2: Inject the scope into both context paths**

Add the import at the top of `src/shared/runner.ts` (extend the existing import from `./review-context.ts`):

```typescript
import { buildReviewContext, discoverGuidelines, formatDiffScope } from './review-context.ts';
```

Just before the `let prContext: string;` declaration (currently line 113), add:

```typescript
const diffScope = { baseRef, baseSha, headSha };
```

In the **enhanced** branch, pass it to `buildReviewContext`:

```typescript
prContext = buildReviewContext({
  pullTitle,
  pullBody,
  changedFiles,
  priorComments,
  commits,
  checkSummary,
  guidelines,
  diffScope,
});
```

In the **basic** branch (the `else`), insert the scope right after the description entry:

```typescript
prContext = [
  pullTitle && `Title: ${pullTitle}`,
  pullBody && `Description: ${pullBody}`,
  formatDiffScope(diffScope),
  `Changed files: ${changedFiles.join(', ')}`,
  summaryScopeBlock,
  reviewFocusBlock,
  commentsBlock,
  priorJbotThreadBlock,
]
  .filter(Boolean)
  .join('\n');
```

(`formatDiffScope` returns `''` when empty, and `.filter(Boolean)` drops it — no conditional needed.)

- [ ] **Step 3: Pass base info from the workflow entry point**

In `src/workflow/index.ts`, extend the `runPrReview` call (lines 62-76). Both the webhook-payload PR and the `pulls.get` response expose `base.ref`/`base.sha`:

```typescript
await runPrReview({
  octokit,
  owner,
  repo,
  pullNumber: pull.number,
  pullTitle: pull.title,
  pullBody: pull.body ?? '',
  workspace: process.env.GITHUB_WORKSPACE ?? process.cwd(),
  model,
  apiKey,
  headSha: pull.head.sha,
  baseRef: pull.base.ref,
  baseSha: pull.base.sha,
  threadResolutionOctokit,
  options,
  log: (msg) => core.info(msg),
});
```

- [ ] **Step 4: Pass head and base info from the hosted app**

In `src/app/app.ts`, extend the `runPrReview` call (lines 39-50):

```typescript
await runPrReview({
  octokit,
  owner,
  repo: repoName,
  pullNumber: pr.number,
  pullTitle: pr.title,
  pullBody: pr.body ?? '',
  workspace: dir,
  model: cfg.model,
  apiKey: cfg.apiKey,
  headSha: pr.head.sha,
  baseRef: pr.base.ref,
  baseSha: pr.base.sha,
  log: (msg: string) => console.log(`[jbot-review] ${msg}`),
});
```

Note for the implementer: in hosted mode the clone (`src/app/clone.ts`) fetches the base ref as a **local** branch (`git fetch origin <base>:<base>`), so `origin/<baseRef>` would not resolve there — that is exactly why `formatDiffScope` prefers SHAs, and the webhook payload always has both SHAs. Do not "fix" the fallback to use a bare ref; the `origin/` fallback exists for workflow mode.

- [ ] **Step 5: Extend the replay script and fixture**

In `scripts/replay-review.ts`, extend the fixture interface:

```typescript
interface ReplayPullRequest {
  title: string;
  body: string;
  baseRef?: string;
  baseSha?: string;
  headSha?: string;
}
```

and the `buildReviewContext` call:

```typescript
const context = buildReviewContext({
  pullTitle: pr.title,
  pullBody: pr.body,
  changedFiles,
  priorComments,
  commits,
  checkSummary: checkSummary.trim(),
  guidelines,
  diffScope: { baseRef: pr.baseRef, baseSha: pr.baseSha, headSha: pr.headSha },
});
```

Replace `fixtures/replay/pr.json` with:

```json
{
  "title": "Add replayable review context",
  "body": "This fixture demonstrates the local review context builder.",
  "baseRef": "main",
  "baseSha": "1111111111111111111111111111111111111111",
  "headSha": "2222222222222222222222222222222222222222"
}
```

- [ ] **Step 6: Verify**

Run: `npm run typecheck`
Expected: clean.

Run: `npm test`
Expected: PASS.

Run: `npm run replay`
Expected: output contains the lines `Base: main (1111111111111111111111111111111111111111)` and `git diff 1111111111111111111111111111111111111111...2222222222222222222222222222222222222222` inside the `## Pull request` section.

- [ ] **Step 7: Commit**

```bash
npm run format
git add src/shared/runner.ts src/workflow/index.ts src/app/app.ts scripts/replay-review.ts fixtures/replay/pr.json
git commit -m "feat: thread PR base/head diff scope through both entry points"
```

---

### Task 3: Code-enforce the low-confidence rule (B4)

"Do not emit low-confidence P0/P1/P2 findings" is currently prompt-only, yet a single P2 flips the posted review to "Needs changes before approval". Enforce it in code: demote (not drop) low-confidence blocking findings to P3, preserving the signal as advisory.

Design decision (do not relitigate): **demote to P3, do not drop.** Dropping loses a potential real P0 from a weak model; demotion keeps the comment visible without blocking. Findings with `confidence: undefined` (model omitted the field) are NOT demoted — absence of the field is not evidence of low confidence.

**Files:**

- Modify: `src/shared/filter.ts`
- Modify: `src/shared/runner.ts` (around line 205 where `filterFindings` is called)
- Test: `test/filter.test.ts` (new file)

- [ ] **Step 1: Write the failing tests**

Create `test/filter.test.ts`:

```typescript
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { demoteLowConfidenceBlockingFindings, isNoiseFile } from '../src/shared/filter.ts';
import type { Finding } from '../src/shared/types.ts';

function finding(overrides: Partial<Finding>): Finding {
  return {
    path: 'src/example.ts',
    line: 10,
    severity: 'P2',
    title: 'Example finding',
    body: 'Example body',
    ...overrides,
  };
}

describe('demoteLowConfidenceBlockingFindings', () => {
  it('demotes low-confidence P0/P1/P2 findings to P3', () => {
    const { findings, demotedCount } = demoteLowConfidenceBlockingFindings([
      finding({ severity: 'P0', confidence: 'low' }),
      finding({ severity: 'P1', confidence: 'low' }),
      finding({ severity: 'P2', confidence: 'low' }),
    ]);

    assert.equal(demotedCount, 3);
    assert.deepEqual(
      findings.map((f) => f.severity),
      ['P3', 'P3', 'P3'],
    );
  });

  it('keeps high/medium confidence blocking findings unchanged', () => {
    const input = [
      finding({ severity: 'P0', confidence: 'high' }),
      finding({ severity: 'P1', confidence: 'medium' }),
    ];
    const { findings, demotedCount } = demoteLowConfidenceBlockingFindings(input);

    assert.equal(demotedCount, 0);
    assert.deepEqual(findings, input);
  });

  it('does not demote findings without a confidence field', () => {
    const input = [finding({ severity: 'P0' })];
    const { findings, demotedCount } = demoteLowConfidenceBlockingFindings(input);

    assert.equal(demotedCount, 0);
    assert.equal(findings[0].severity, 'P0');
  });

  it('leaves low-confidence advisory findings (P3/nit) unchanged', () => {
    const input = [
      finding({ severity: 'P3', confidence: 'low' }),
      finding({ severity: 'nit', confidence: 'low' }),
    ];
    const { findings, demotedCount } = demoteLowConfidenceBlockingFindings(input);

    assert.equal(demotedCount, 0);
    assert.deepEqual(findings, input);
  });
});

describe('isNoiseFile', () => {
  it('still filters lockfiles', () => {
    assert.equal(isNoiseFile('package-lock.json'), true);
    assert.equal(isNoiseFile('src/app.ts'), false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import tsx --test test/filter.test.ts`
Expected: FAIL — `demoteLowConfidenceBlockingFindings` is not exported.

- [ ] **Step 3: Implement the gate**

Append to `src/shared/filter.ts`:

```typescript
import type { Finding, Severity } from './types.ts';

const BLOCKING_SEVERITIES: ReadonlySet<Severity> = new Set(['P0', 'P1', 'P2']);

/**
 * Enforces "do not emit low-confidence P0/P1/P2 findings" in code rather than
 * trusting the prompt: a low-confidence blocking finding from a weak model
 * would otherwise flip the review to "Needs changes". Demotes to P3 (advisory)
 * instead of dropping, so the signal stays visible without blocking.
 */
export function demoteLowConfidenceBlockingFindings(findings: Finding[]): {
  findings: Finding[];
  demotedCount: number;
} {
  let demotedCount = 0;
  const result = findings.map((finding) => {
    if (finding.confidence === 'low' && BLOCKING_SEVERITIES.has(finding.severity)) {
      demotedCount += 1;
      return { ...finding, severity: 'P3' as const };
    }
    return finding;
  });
  return { findings: result, demotedCount };
}
```

(Move the `import type` line to the top of the file with the other code — `filter.ts` currently has no imports, so it becomes the first line.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --import tsx --test test/filter.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire into the runner**

In `src/shared/runner.ts`, extend the existing filter import (line 1):

```typescript
import { demoteLowConfidenceBlockingFindings, isNoiseFile } from './filter.ts';
```

Replace the line `const filteredFindings = filterFindings(findings, options);` (currently line 205) with:

```typescript
const confidenceGate = demoteLowConfidenceBlockingFindings(findings);
if (confidenceGate.demotedCount > 0) {
  log(`Demoted ${confidenceGate.demotedCount} low-confidence blocking finding(s) to P3.`);
}
const filteredFindings = filterFindings(confidenceGate.findings, options);
```

- [ ] **Step 6: Verify and commit**

```bash
npm run typecheck
npm test
npm run format
git add src/shared/filter.ts src/shared/runner.ts test/filter.test.ts
git commit -m "feat: demote low-confidence blocking findings to P3 in code"
```

---

### Task 4: Tolerant addressed-commit key parsing (A4)

The parser reads only `addressed_by_commit` (snake_case) while the surrounding schema keys are camelCase; weak models normalize one to match the other. Accept both. Export `parseReview` so this (and the existing extraction machinery) gets direct test coverage for the first time.

**Files:**

- Modify: `src/shared/opencode.ts` (`parseReview` at lines 475-546)
- Test: `test/opencode-parse.test.ts` (new file)

- [ ] **Step 1: Write the failing tests**

Create `test/opencode-parse.test.ts`:

````typescript
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseReview } from '../src/shared/opencode.ts';

const noLog = (): void => undefined;

describe('parseReview', () => {
  it('accepts both camelCase and snake_case addressed-commit keys', () => {
    const raw = JSON.stringify({
      summary: 'ok',
      findings: [],
      addressedPriorComments: [
        { id: 'PRRT_1', addressedByCommit: 'abc1234', note: 'fixed' },
        { id: 'PRRT_2', addressed_by_commit: 'def5678', note: 'also fixed' },
      ],
    });

    const result = parseReview(raw, 'test', noLog);

    assert.deepEqual(result.addressedPriorComments, [
      { id: 'PRRT_1', addressedByCommit: 'abc1234', note: 'fixed' },
      { id: 'PRRT_2', addressedByCommit: 'def5678', note: 'also fixed' },
    ]);
  });

  it('parses a valid review object', () => {
    const raw = JSON.stringify({
      summary: 'One issue found.',
      findings: [
        {
          path: 'src/a.ts',
          line: 12,
          severity: 'P1',
          kind: 'bug',
          confidence: 'high',
          title: 'Off-by-one',
          body: 'Loop bound excludes the last element.',
        },
      ],
    });

    const result = parseReview(raw, 'test', noLog, { strict: true });

    assert.equal(result.summary, 'One issue found.');
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].severity, 'P1');
    assert.equal(result.findings[0].kind, 'bug');
  });

  it('extracts JSON from a fenced code block', () => {
    const raw = '```json\n{"summary": "fenced", "findings": []}\n```';

    const result = parseReview(raw, 'test', noLog, { strict: true });

    assert.equal(result.summary, 'fenced');
  });

  it('extracts a balanced JSON object embedded in prose', () => {
    const raw = 'Here is my review:\n{"summary": "embedded", "findings": []}\nThanks!';

    const result = parseReview(raw, 'test', noLog, { strict: true });

    assert.equal(result.summary, 'embedded');
  });

  it('drops findings with an invalid severity', () => {
    const raw = JSON.stringify({
      summary: 's',
      findings: [
        {
          path: 'src/a.ts',
          line: 1,
          severity: 'P0" | "P1',
          title: 'union syntax leak',
          body: 'b',
        },
      ],
    });

    const result = parseReview(raw, 'test', noLog);

    assert.equal(result.findings.length, 0);
  });

  it('throws in strict mode on unparseable output', () => {
    assert.throws(
      () => parseReview('not json at all', 'review', noLog, { strict: true }),
      /unparseable JSON/,
    );
  });

  it('returns a fallback result in non-strict mode', () => {
    const result = parseReview('not json at all', 'aux', noLog);

    assert.equal(result.summary, 'The reviewer returned an unparseable response.');
    assert.deepEqual(result.findings, []);
  });
});
````

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import tsx --test test/opencode-parse.test.ts`
Expected: FAIL — `parseReview` is not exported (and the casing test would fail even if it were).

- [ ] **Step 3: Export `parseReview` and accept both casings**

In `src/shared/opencode.ts`:

Change the declaration (line 475) from `function parseReview(` to `export function parseReview(` and extend its doc comment's last line with: `Exported for direct test coverage.`

Replace the `addressedPriorComments` loop body (currently lines 531-543) with:

```typescript
for (const item of rawAddressed) {
  const addressed = item as Record<string, unknown>;
  const id = typeof addressed.id === 'string' ? addressed.id.trim() : '';
  if (!id) continue;
  // Accept both casings: the schema uses camelCase, but models normalize
  // inconsistently and historic prompts used snake_case.
  const rawCommit =
    typeof addressed.addressedByCommit === 'string'
      ? addressed.addressedByCommit
      : typeof addressed.addressed_by_commit === 'string'
        ? addressed.addressed_by_commit
        : undefined;
  addressedPriorComments.push({
    id,
    addressedByCommit: rawCommit?.trim(),
    note: typeof addressed.note === 'string' ? addressed.note.trim() : undefined,
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --import tsx --test test/opencode-parse.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify and commit**

```bash
npm run typecheck
npm test
npm run format
git add src/shared/opencode.ts test/opencode-parse.test.ts
git commit -m "feat: accept both addressedByCommit casings; export parseReview for tests"
```

---

### Task 5: Rewrite REVIEW_PROMPT (A3, B1-static, B2, C1, C2, B3-schema)

One rewrite applying all static-prompt findings:

- **C1**: new `## How your output is used` section up front explaining wrapper validation (models comply better with explained constraints).
- **A1 (prompt side)**: context section points at the diff command provided in the PR section.
- **B1**: all paraphrased prior-thread/declined rules removed — one pointer sentence remains; the canonical copy moves to `formatPriorJbotThreadsForPrompt` (Task 6).
- **B2**: "shortest context" bullet replaced with "thorough on changed files + direct callers/callees/tests; nothing unrelated".
- **B3 (schema side)**: `addressedPriorComments` and the entire `## Rules for addressed prior comments` section removed from the main prompt — the dedicated session owns that job.
- **A3 + C2**: union-syntax JSON template replaced with one concrete example plus a `Field constraints:` list that absorbs `## Rules for lines`.
- **D2**: new `## Architecture and design` section, an `architecture` finding kind (type + validation updated in the same task), and an "Architecture notes" summary outlet make structural review first-class while preserving the anti-noise rule (architecture findings need concrete evidence, same as bugs).

**Files:**

- Modify: `src/shared/prompt.ts` (full rewrite)
- Modify: `src/shared/types.ts` (add `'architecture'` to `FindingKind`, lines 2-9)
- Modify: `src/shared/opencode.ts` (add `'architecture'` to `VALID_FINDING_KINDS`, lines 30-38)
- Test: `test/prompt.test.ts` (new file)
- Test: `test/opencode-parse.test.ts` (one new case; file created in Task 4)

- [ ] **Step 1: Write the failing tests**

Create `test/prompt.test.ts`:

```typescript
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { REVIEW_PROMPT } from '../src/shared/prompt.ts';

describe('REVIEW_PROMPT', () => {
  it('uses a concrete example instead of union syntax in the schema', () => {
    assert.doesNotMatch(REVIEW_PROMPT, /"P0" \| "P1"/);
    assert.doesNotMatch(REVIEW_PROMPT, /"high" \| "medium"/);
    assert.match(REVIEW_PROMPT, /Field constraints:/);
    assert.match(REVIEW_PROMPT, /"severity": "P1"/);
  });

  it('does not ask the main review for addressed prior comments', () => {
    assert.doesNotMatch(REVIEW_PROMPT, /addressedPriorComments/);
    assert.doesNotMatch(REVIEW_PROMPT, /addressed_by_commit/);
  });

  it('defers prior-thread handling to the canonical rules block', () => {
    // The detailed declined-thread rules live in formatPriorJbotThreadsForPrompt,
    // stated exactly once next to the thread data.
    assert.doesNotMatch(REVIEW_PROMPT, /intentionally declined/);
    assert.doesNotMatch(REVIEW_PROMPT, /Not applied/);
    assert.match(REVIEW_PROMPT, /canonical rules/i);
  });

  it('explains how the wrapper uses the output', () => {
    assert.match(REVIEW_PROMPT, /## How your output is used/);
    assert.match(REVIEW_PROMPT, /validated against the PR diff/);
  });

  it('keeps the line rule next to the field it governs', () => {
    assert.doesNotMatch(REVIEW_PROMPT, /## Rules for lines/);
    assert.match(REVIEW_PROMPT, /ADDED by this PR/);
  });

  it('resolves the thoroughness/scope tension with one directive', () => {
    assert.doesNotMatch(REVIEW_PROMPT, /shortest context/);
    assert.match(REVIEW_PROMPT, /Do not explore code unrelated to the diff/);
  });

  it('tells the model to escape newlines inside JSON string values', () => {
    assert.match(REVIEW_PROMPT, /escape newlines inside string values as \\n/);
  });

  it('reviews architecture as a first-class dimension', () => {
    assert.match(REVIEW_PROMPT, /## Architecture and design/);
    assert.match(REVIEW_PROMPT, /"architecture"/);
    assert.match(REVIEW_PROMPT, /Architecture notes/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import tsx --test test/prompt.test.ts`
Expected: FAIL on the union-syntax, addressedPriorComments, and other assertions.

- [ ] **Step 3: Replace the entire contents of `src/shared/prompt.ts`**

Note the escaping: `\`` for literal backticks, `\\n`where the model must see the two characters`\n`.

```typescript
/**
 * The review prompt. The agent is given the checked-out repo and uses its own
 * tools (read, grep, glob, git diff, git log) to explore changes in context.
 * PR metadata (including the exact base...head diff command), existing review
 * comments, changed files, and repo-level guidelines are injected into the
 * prompt after these base instructions.
 *
 * The agent returns a single JSON object with "summary" and "findings"; the
 * wrapper validates line anchors against the diff, demotes low-confidence
 * blocking findings, computes the verdict, and posts one review. A separate
 * dedicated session (see ADDRESSED_PRIOR_COMMENTS_PROMPT) owns verification
 * of previously posted jbot-review threads.
 */
export const REVIEW_PROMPT = `You are a thoughtful, pragmatic code reviewer. Your goal is to catch real bugs
and suggest meaningful improvements — not to nitpick style or generate noise.

## How your output is used

Your response is parsed by a program, not read directly by a human:

- Your "path" + "line" anchors are validated against the PR diff. Findings on
  lines this PR did not add are demoted out of inline comments, so anchor
  precisely.
- The merge guidance shown to humans is computed from your severity tags.
- Low-confidence P0/P1/P2 findings are demoted to advisory severity.
- A response that is not valid JSON fails the entire review run.

## Context available to you

- The full repository is checked out on the PR branch.
- The "Pull request" section below identifies the PR base and head and the
  exact git diff command that shows what this PR changes. Review only that
  diff. Cross-reference changes against their callers, definitions, and tests.
- PR metadata (title, description, existing reviews) is provided below.
  Read it to understand intent.
- Prior jbot-review inline comment threads may be provided below together with
  canonical rules for handling them; follow those rules exactly.
- Repo-level guidelines (AGENTS.md, REVIEW.md, .pr-governance/) may be
  provided. Follow loaded guidance, and read any listed referenced Markdown
  docs only when they are relevant to the changed files or review question.
- Do NOT modify any files. This is a read-only review.

## Severity tags

Use these severity levels. Prefer lower severity when uncertain.

| Tag  | Meaning                                            |
| ---- | -------------------------------------------------- |
| P0   | Critical bug or security vulnerability              |
| P1   | High-impact issue (logic error, data loss, breakage)|
| P2   | Medium issue (missing error handling, edge case)    |
| P3   | Minor improvement (cleaner approach, DRY, clarity)  |
| nit  | Trivial suggestion (naming, comment, formatting)    |

P0, P1, and P2 are blocking findings. P3 and nit are advisory only; include
them only when they are clearly useful and low-noise.

## What to flag

- Logic errors, off-by-one mistakes, incorrect control flow.
- Injection, auth/authz, unsafe deserialization, hardcoded secrets.
- Resource leaks, unhandled rejections, missing error handling on real paths.
- Concurrency hazards (missing await, unguarded shared state).
- Breaking changes to a public contract that the change does not also update.
- Performance regressions visible from the diff.
- Violations of written repository guidelines (cite the rule in the finding body).
- Duplication of a helper, utility, or pattern that already exists in the repo.
- Layering or dependency-direction violations relative to the existing module
  structure.

## What NOT to flag

- Style, naming, or formatting a linter / formatter would own.
- Issues in unchanged code that this PR does not touch.
- Hypothetical risks with no realistic trigger path.
- "Consider using library X" suggestions.
- Missing tests or docs, unless their absence creates a correctness risk.
- Notes that boil down to "this could be done differently" without a concrete reason.
- P3/nit feedback that would not materially improve readability, safety, or maintainability.
- Issues an existing review thread already covers (see the canonical rules with
  the prior threads, when provided).

## Architecture and design

Review the shape of the change, not just its lines:

- Before accepting a new helper, type, or abstraction, search the repo for an
  existing one that already does the job; flag duplication and point to the
  existing code.
- Check that new code follows the conventions of its neighbors: error
  handling, module boundaries, layering, and how similar files are organized.
- Check new or changed public contracts (exported APIs, schemas, endpoints)
  for consistency with the repo's existing contract patterns.
- Architecture findings use kind "architecture" and need the same concrete
  evidence as any other finding: name the existing pattern, module, or written
  rule the change conflicts with.
- If a material architecture observation cannot be anchored to a line this PR
  added, put it in "summary" under an "Architecture notes" bullet instead of
  inventing an anchor.

## Review pass

- Inspect the diff and nearby callers, definitions, contracts, tests, migrations,
  and error paths needed to verify changed behavior.
- Be thorough on every changed file and its direct callers, callees, and tests.
  Do not explore code unrelated to the diff.
- Apply loaded repo guidance and compatible review-bot rules only where relevant
  to the changed paths.
- Emit only findings with a concrete trigger path: input/state, current result,
  why it is wrong, and a focused fix.

## Completeness

- Make one thorough pass over the full PR and return the complete set of
  actionable findings you can support from the current code.
- Do not hold back valid findings for later review rounds. Later runs should
  only add comments when new commits introduce or reveal new issues.

## Classification

Each finding includes "kind" and "confidence". Do not emit low-confidence P0,
P1, or P2 findings. Prefer "bug", "security", or "performance" for correctness
issues; use "architecture" for duplication, layering, and contract-shape
issues; use "investigate" only for risks that need environment- or
data-dependent confirmation.

## Tone

- Be concise. One clear paragraph per finding is enough.
- Use concrete examples (code snippets, line refs) where they clarify.
- Markdown (backticks, code blocks, bold) is encouraged inside string values.
- Frame fixes as suggestions, not demands. "Consider extracting…" not "You must…".

## Output

Respond with a SINGLE raw JSON object and NOTHING else — no text before or
after it, and no markdown fences around it. Markdown is allowed only inside
JSON string values; escape newlines inside string values as \\n.

The object has exactly two top-level keys, shaped like this example:

{
  "summary": "- Adds retry logic to the webhook dispatcher\\n- One blocking bug in the backoff arithmetic",
  "findings": [
    {
      "path": "src/billing/invoice.ts",
      "line": 42,
      "severity": "P1",
      "kind": "bug",
      "confidence": "high",
      "title": "Refund amount uses pre-tax subtotal",
      "body": "\`refund()\` subtracts \`subtotal\` instead of \`total\`, so tax is never refunded. Consider using \`order.total\` here."
    }
  ]
}

Field constraints:

- "summary": brief assessment of the change; prefer 2-4 concise Markdown
  bullets. Follow the "Summary instructions" section below when present.
  Include an "Architecture notes" bullet for material design observations
  that no added line can anchor.
- "path": exact file path as it appears in the diff.
- "line": integer line number on the NEW side of the file. The line must have
  been ADDED by this PR (it starts with '+' in the diff).
- "severity": exactly one of "P0", "P1", "P2", "P3", "nit".
- "kind": exactly one of "bug", "security", "performance", "maintainability",
  "architecture", "test", "docs", "investigate".
- "confidence": exactly one of "high", "medium", "low".
- "title": imperative headline.
- "body": clear explanation with a concrete suggestion.
- If there are no issues, "findings" must be an empty array. Do not invent
  issues.`;
```

- [ ] **Step 3b: Add the `architecture` finding kind to types and validation**

In `src/shared/types.ts`, replace the `FindingKind` union (lines 2-9):

```typescript
export type FindingKind =
  | 'bug'
  | 'security'
  | 'performance'
  | 'maintainability'
  | 'architecture'
  | 'test'
  | 'docs'
  | 'investigate';
```

In `src/shared/opencode.ts`, add `'architecture'` to `VALID_FINDING_KINDS` (lines 30-38):

```typescript
const VALID_FINDING_KINDS = new Set<FindingKind>([
  'bug',
  'security',
  'performance',
  'maintainability',
  'architecture',
  'test',
  'docs',
  'investigate',
]);
```

- [ ] **Step 3c: Add a parser test for the new kind**

Append inside the `describe('parseReview', ...)` block in `test/opencode-parse.test.ts`:

```typescript
it('accepts the architecture finding kind', () => {
  const raw = JSON.stringify({
    summary: 's',
    findings: [
      {
        path: 'src/a.ts',
        line: 3,
        severity: 'P3',
        kind: 'architecture',
        confidence: 'medium',
        title: 'Duplicates existing helper',
        body: 'See src/shared/util.ts for the existing implementation.',
      },
    ],
  });

  const result = parseReview(raw, 'test', noLog);

  assert.equal(result.findings[0].kind, 'architecture');
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --import tsx --test test/prompt.test.ts test/opencode-parse.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify nothing else broke**

Run: `npm run typecheck && npm test`
Expected: clean. (`opencode.ts` still imports only `REVIEW_PROMPT` at this point, which still exists. The runner still merges main-review `addressedPriorComments` — now always empty from the prompt's perspective, which is harmless until Task 6 removes the merge.)

- [ ] **Step 6: Commit**

```bash
npm run format
git add src/shared/prompt.ts src/shared/types.ts src/shared/opencode.ts test/prompt.test.ts test/opencode-parse.test.ts
git commit -m "feat: rewrite review prompt — concrete example schema, wrapper contract up front, architecture dimension"
```

---

### Task 6: Canonical prior-thread rules + single-owner addressed check (B1-dynamic, B3 runtime)

Make `formatPriorJbotThreadsForPrompt` the one canonical statement of prior-thread rules (it sits next to the actual thread data, where a weak model needs it), and make the dedicated parallel session the only source of `addressedPriorComments` — the runner stops merging the main review's (now schema-less) report.

**Files:**

- Modify: `src/shared/github.ts` (header lines of `formatPriorJbotThreadsForPrompt`, lines 456-460)
- Modify: `src/shared/runner.ts` (merge removal, lines 191-204 and 459-471)
- Test: `test/github.test.ts`

- [ ] **Step 1: Update the github test for the canonical block**

In `test/github.test.ts`, in the first test (`includes human thread replies so declined suggestions are not re-raised`), after the existing assertions (line 39), add:

```typescript
assert.match(prompt, /Canonical rules for these threads:/);
assert.match(prompt, /unless a newer commit creates a materially different problem/);
assert.match(prompt, /not re-raising an issue does not make it addressed/);
```

The existing assertion `assert.match(prompt, /do not re-post it and do not mark it addressed/)` stays — the new wording preserves that phrase.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test test/github.test.ts`
Expected: FAIL on `/Canonical rules for these threads:/`.

- [ ] **Step 3: Rewrite the header lines in `formatPriorJbotThreadsForPrompt`**

In `src/shared/github.ts`, replace the `lines` initialization (currently lines 456-460):

```typescript
const lines = [
  '## Prior jbot-review inline comments',
  'Canonical rules for these threads:',
  '- Do not re-raise an issue an existing thread already covers, unless a newer commit creates a materially different problem.',
  '- If later thread replies say the finding was not applied, intentionally declined, accepted as-is, or not worth fixing, treat the issue as already discussed: do not re-post it and do not mark it addressed.',
  '- When a task asks you to report addressed threads: only mark a thread addressed when the current branch verifiably fixes the specific issue raised, and use the exact thread id; not re-raising an issue does not make it addressed.',
];
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --import tsx --test test/github.test.ts`
Expected: PASS.

- [ ] **Step 5: Remove the merge in the runner — dedicated check owns the result**

In `src/shared/runner.ts`:

1. Replace the destructure + merge (currently lines 191-204):

```typescript
log('Running review');
const { summary, findings } = await runReviewWithContext7Fallback(
  client,
  model,
  prContext,
  basePrContext,
  guidelinesForPrompt,
  log,
  context7Active,
  options.context7ApiKey,
);
// The dedicated parallel session is the single owner of addressed-thread
// verification; the main review no longer reports them.
const verifiedAddressedPriorComments = await addressedPriorCheck;
```

2. Delete the entire `mergeAddressedPriorComments` function (currently lines 459-471).

3. Remove `AddressedPriorComment` from the type-only import at the top **only if** it is now unused — it is still used by `formatAddressedPriorComment` and `acknowledgeAddressedPriorComments`, so keep it. (Verify with `npm run typecheck` and `npm run lint`; oxlint flags unused imports.)

- [ ] **Step 6: Verify and commit**

```bash
npm run typecheck
npm test
npm run lint
npm run format
git add src/shared/github.ts src/shared/runner.ts test/github.test.ts
git commit -m "feat: single canonical prior-thread rules block; dedicated session owns addressed checks"
```

---

### Task 7: Prompt assembly with final output reminders (A2)

The output contract currently sits mid-prompt — `REVIEW_PROMPT` ends with the schema, but guidelines and tens of KB of PR context follow it, and small models obey what they read last. Centralize all prompt text in `prompt.ts`, add end-of-prompt reminders, and make assembly a pure, tested function. The dedicated addressed-check prompt moves here too (and its schema goes camelCase, matching the Task 4 parser change — the parser still accepts snake_case from models that normalize the other way).

**Files:**

- Modify: `src/shared/prompt.ts` (append constants + functions)
- Modify: `src/shared/opencode.ts` (use assembly functions; delete local `ADDRESSED_PRIOR_COMMENTS_PROMPT`, lines 41-63; rework `runReview` lines 285-302 and `runAddressedPriorCommentsCheck` lines 304-313)
- Test: `test/prompt.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `test/prompt.test.ts`. Extend the import:

```typescript
import {
  ADDRESSED_PRIOR_COMMENTS_PROMPT,
  REVIEW_OUTPUT_REMINDER,
  REVIEW_PROMPT,
  assembleAddressedPriorCommentsPrompt,
  assembleReviewPrompt,
} from '../src/shared/prompt.ts';
```

Append the new describe blocks:

```typescript
describe('assembleReviewPrompt', () => {
  it('places the output reminder after all dynamic context', () => {
    const prompt = assembleReviewPrompt('PR_CONTEXT_SENTINEL', 'GUIDELINES_SENTINEL');

    assert.ok(prompt.startsWith(REVIEW_PROMPT));
    assert.ok(prompt.endsWith(REVIEW_OUTPUT_REMINDER));
    assert.ok(prompt.indexOf('GUIDELINES_SENTINEL') < prompt.indexOf('PR_CONTEXT_SENTINEL'));
    assert.ok(prompt.indexOf('PR_CONTEXT_SENTINEL') < prompt.indexOf('## Final output reminder'));
  });

  it('omits the guidelines section when guidelines are empty', () => {
    const prompt = assembleReviewPrompt('PR_CONTEXT_SENTINEL', '');

    assert.doesNotMatch(prompt, /## Repository review guidelines/);
  });
});

describe('assembleAddressedPriorCommentsPrompt', () => {
  it('places its own output reminder last', () => {
    const prompt = assembleAddressedPriorCommentsPrompt('PR_CONTEXT_SENTINEL');

    assert.ok(prompt.startsWith(ADDRESSED_PRIOR_COMMENTS_PROMPT));
    assert.match(prompt, /## Final output reminder/);
    assert.ok(prompt.indexOf('PR_CONTEXT_SENTINEL') < prompt.indexOf('## Final output reminder'));
  });
});

describe('ADDRESSED_PRIOR_COMMENTS_PROMPT', () => {
  it('uses camelCase schema keys consistently', () => {
    assert.match(ADDRESSED_PRIOR_COMMENTS_PROMPT, /"addressedByCommit"/);
    assert.doesNotMatch(ADDRESSED_PRIOR_COMMENTS_PROMPT, /addressed_by_commit/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import tsx --test test/prompt.test.ts`
Expected: FAIL — the new exports do not exist.

- [ ] **Step 3: Append the constants and assembly functions to `src/shared/prompt.ts`**

```typescript
export const REVIEW_OUTPUT_REMINDER = `## Final output reminder

Respond now with one raw JSON object with exactly two top-level keys,
"summary" and "findings", matching the Output section above. Do not write any
text before or after the JSON. Do not wrap it in markdown fences. Markdown is
allowed only inside JSON string values; escape newlines inside string values
as \\n.`;

/**
 * Assembles the full review prompt. The output reminder is deliberately LAST:
 * small models weight recent instructions most heavily, and tens of KB of PR
 * context would otherwise bury the output contract.
 */
export function assembleReviewPrompt(prContext: string, guidelines: string): string {
  const parts = [REVIEW_PROMPT];
  if (guidelines) {
    parts.push('## Repository review guidelines\n', guidelines);
  }
  parts.push(prContext, REVIEW_OUTPUT_REMINDER);
  return parts.join('\n\n');
}

export const ADDRESSED_PRIOR_COMMENTS_PROMPT = `You are checking whether prior jbot-review inline comments have been addressed by the current PR branch.

Use the checked-out repo, git diff, git log, and the PR context below to verify each prior jbot-review thread.

Rules:
- Only mark a prior thread addressed when the current branch clearly fixes the specific issue raised.
- Do not mark a thread addressed just because the latest review has no new findings.
- Do not mark a thread addressed because a human reply declined the suggestion, such as "Not applied", "accepted as-is", or "not worth fixing".
- Use the exact prior jbot-review thread id from the prompt.
- Prefer the commit SHA that fixed the issue for "addressedByCommit"; use the current head only if the exact fixing commit cannot be determined.
- Keep "note" to one short sentence explaining why it is addressed.

Respond with a SINGLE raw JSON object and NOTHING else:

{
  "addressedPriorComments": [
    {
      "id": "exact prior jbot-review thread id",
      "addressedByCommit": "commit sha",
      "note": "Short reason this prior comment is now addressed."
    }
  ]
}`;

export const ADDRESSED_OUTPUT_REMINDER = `## Final output reminder

Respond now with one raw JSON object with the single top-level key
"addressedPriorComments", matching the schema above. Do not write any text
before or after the JSON. Do not wrap it in markdown fences.`;

export function assembleAddressedPriorCommentsPrompt(prContext: string): string {
  return [ADDRESSED_PRIOR_COMMENTS_PROMPT, prContext, ADDRESSED_OUTPUT_REMINDER].join('\n\n');
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --import tsx --test test/prompt.test.ts`
Expected: PASS.

- [ ] **Step 5: Rewire `opencode.ts`**

In `src/shared/opencode.ts`:

1. Replace the prompt import (line 11):

```typescript
import { assembleAddressedPriorCommentsPrompt, assembleReviewPrompt } from './prompt.ts';
```

2. Delete the local `ADDRESSED_PRIOR_COMMENTS_PROMPT` constant (lines 41-63) — it now lives in `prompt.ts` with the camelCase schema.

3. In `runReview`, replace the assembly block (currently lines 292-298):

```typescript
const prompt = assembleReviewPrompt(prContext, guidelines);
log(`Prompt assembled: ${prompt.length} chars, guidelines=${!!guidelines}`);
```

4. In `runAddressedPriorCommentsCheck`, replace the assembly line (currently line 310):

```typescript
const prompt = assembleAddressedPriorCommentsPrompt(prContext);
```

- [ ] **Step 6: Verify and commit**

```bash
npm run typecheck
npm test
npm run lint
npm run format
git add src/shared/prompt.ts src/shared/opencode.ts test/prompt.test.ts
git commit -m "feat: end-of-prompt output reminders; centralize prompt text and assembly in prompt.ts"
```

---

### Task 8: Guideline discovery recall (D1, part 1)

Why written standards get missed today (root causes this task fixes):

1. `TECHNICAL_STANDARDS.md` is not in `ROOT_GUIDELINE_FILES`, so it loads only
   when another loaded doc references it — and referenced docs are _listed,
   not preloaded_, which weak models never act on unprompted.
2. When `.pr-governance/README.md` exists, the rule docs it references are
   also only _listed_ — the fallback that inlines every `.pr-governance/*`
   file runs only when there is NO README. A well-organized governance dir
   (README + rule docs) therefore gets LESS enforcement than a flat one.
3. The 16KB/file, 48KB total budget truncates large standards docs.

Design decisions (do not relitigate):

- **Governance README references are preloaded** (budget permitting): docs a
  governance index points at are review rules by definition. References from
  _other_ guidance (AGENTS.md etc.) stay listed-only — that distinction
  preserves the token optimization from PR #21 where it is safe.
- Budget rises to 24KB/file, 96KB total — the compliance session (Task 9)
  needs the actual rule text, and truncated rules cannot be enforced.
- All existing path-escape and symlink protections are reused unchanged
  (`addGuidelineFile` already routes through `resolveExistingInsideWorkspace`).

**Files:**

- Modify: `src/shared/review-context.ts` (constants at lines 72-101, governance branch at lines 251-262)
- Test: `test/review-context.test.ts` (three updated tests, one new test)

- [ ] **Step 1: Update the discovery tests to the new contract**

In `test/review-context.test.ts`:

**(a)** Rename the test `'lists referenced markdown docs without preloading their content'` to `'preloads governance README references while keeping root-guideline references listed'` and replace its assertion block (after the `const guidelines = await discoverGuidelines(repo);` line) with:

```typescript
assert.match(guidelines, /### AGENTS\.md\n# Agents/);
assert.match(guidelines, /### REVIEW\.md\n# Review/);
assert.match(guidelines, /### \.pr-governance\/README\.md\n# Governance/);
assert.match(guidelines, /### \.pr-governance\/design\/NORTH_STAR\.md\n# North Star/);
assert.match(guidelines, /Nested design instructions/);
assert.match(guidelines, /Nested review instructions/);
assert.doesNotMatch(guidelines, /### Referenced Markdown documents/);
```

**(b)** In the test `'lists markdown references from root guidelines once when they overlap with governance docs'`, replace the assertion block with:

```typescript
assert.match(guidelines, /### docs\/SHARED\.md\n# Shared/);
assert.match(guidelines, /Load this once/);
assert.match(guidelines, /- docs\/EXTRA\.md/);
assert.doesNotMatch(guidelines, /Load this too/);
assert.doesNotMatch(guidelines, /^- docs\/SHARED\.md$/m);
```

(`docs/SHARED.md` is referenced by the governance README so it is now preloaded; it must therefore disappear from the listed section, while `docs/EXTRA.md` — referenced only from AGENTS.md — stays listed-only.)

**(c)** In the test `'ignores governance references outside the repository root'`, replace the four assertions with:

```typescript
assert.match(guidelines, /### \.pr-governance\/INSIDE\.md\n# Inside/);
assert.match(guidelines, /Available only/);
assert.doesNotMatch(guidelines, /Do not load this/);
assert.doesNotMatch(guidelines, /Do not load this either/);
```

(In-repo governance references are now loaded; outside-the-repo references must still never load — that protection lives in `resolveExistingInsideWorkspace`, which this task does not touch.)

**(d)** Add a new test after **(a)**:

```typescript
it('preloads TECHNICAL_STANDARDS.md and ARCHITECTURE.md from the repo root', async () => {
  await withTempRepo(async (repo) => {
    await writeFile(join(repo, 'TECHNICAL_STANDARDS.md'), '# Standards\nNo floating promises.');
    await writeFile(
      join(repo, 'ARCHITECTURE.md'),
      '# Architecture\nServices never import from app/.',
    );

    const guidelines = await discoverGuidelines(repo);

    assert.match(guidelines, /### TECHNICAL_STANDARDS\.md\n# Standards/);
    assert.match(guidelines, /No floating promises\./);
    assert.match(guidelines, /### ARCHITECTURE\.md\n# Architecture/);
    assert.match(guidelines, /Services never import from app\//);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import tsx --test test/review-context.test.ts`
Expected: FAIL — governance refs are still listed-only and TECHNICAL_STANDARDS.md is not discovered.

- [ ] **Step 3: Implement discovery changes**

In `src/shared/review-context.ts`:

**(a)** Add the standards files to the discovery lists. In `ROOT_GUIDELINE_FILES`, insert after `'REVIEW.md',`:

```typescript
  'TECHNICAL_STANDARDS.md',
  'ARCHITECTURE.md',
```

In `SCOPED_GUIDELINE_FILES`, insert after `'REVIEW.md',`:

```typescript
  'TECHNICAL_STANDARDS.md',
```

**(b)** Raise the budgets:

```typescript
const MAX_GUIDELINE_FILE_BYTES = 24 * 1024;
const MAX_GUIDELINE_TOTAL_BYTES = 96 * 1024;
```

**(c)** Preload governance README references. Replace the `if (readme) { ... }` block (currently lines 257-262):

```typescript
if (readme) {
  for (const reference of extractMarkdownDocumentReferences(readme.text)) {
    const referencedPath = resolveMarkdownReference(cwd, governanceDir, reference);
    if (!referencedPath) continue;
    // Governance README references are review rules by definition: preload
    // them (budget permitting) instead of merely listing them. Path-escape
    // and symlink checks happen inside addGuidelineFile.
    await addGuidelineFile(formatGuidelineLabel(cwd, referencedPath), referencedPath);
  }
  return formatGuidelineSections(sections, seen, referencedDocs);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --import tsx --test test/review-context.test.ts`
Expected: PASS, including the untouched symlink/traversal/truncation tests (the truncation test writes ~36KB, still above the new 24KB per-file cap).

- [ ] **Step 5: Verify and commit**

```bash
npm run typecheck
npm test
npm run format
git add src/shared/review-context.ts test/review-context.test.ts
git commit -m "feat: preload governance-referenced docs and TECHNICAL_STANDARDS/ARCHITECTURE standards files"
```

---

### Task 9: Dedicated guideline-compliance session (D1, part 2)

Even preloaded guidelines are just text — nothing forces a weak model to check
the diff rule-by-rule, and the main session is already juggling bug-hunting.
Add a second parallel session (mirroring the existing addressed-check pattern)
whose ONLY job is auditing the diff against the written rules. Its findings go
through the same anchor validation, confidence gate, and severity filters; a
`path:line` dedupe keeps double-reported issues from posting twice.

Design decisions (do not relitigate):

- **Runs only when guidelines were discovered** and `enable-guideline-pass` is
  not `false` (default `true`). No guidelines → zero extra cost.
- **Failure is non-fatal** (same policy as the addressed-check): a broken
  compliance session must not kill the main review.
- **Main review wins dedupe collisions** — it has the richer bug context; the
  compliance session's value is recall on rules the main pass forgot.

**Files:**

- Modify: `src/shared/prompt.ts` (append compliance prompt + assembly)
- Modify: `src/shared/opencode.ts` (new `runGuidelineComplianceCheck`)
- Modify: `src/shared/filter.ts` (new `dedupeFindings`)
- Modify: `src/shared/runner.ts` (option, parallel start, merge)
- Modify: `src/workflow/index.ts` (parse `enable-guideline-pass`)
- Modify: `action.yml` (new input + env passthrough)
- Test: `test/prompt.test.ts`, `test/filter.test.ts`

- [ ] **Step 1: Write the failing prompt tests**

Append to `test/prompt.test.ts`. Extend the import list with `GUIDELINE_COMPLIANCE_PROMPT`, `GUIDELINE_COMPLIANCE_OUTPUT_REMINDER`, and `assembleGuidelineCompliancePrompt`. Then append:

```typescript
describe('GUIDELINE_COMPLIANCE_PROMPT', () => {
  it('requires citing the violated rule in every finding', () => {
    assert.match(GUIDELINE_COMPLIANCE_PROMPT, /MUST name or quote the specific written rule/);
  });

  it('forbids P0 and nit severities for compliance findings', () => {
    assert.match(GUIDELINE_COMPLIANCE_PROMPT, /Do not use "P0" or "nit"/);
  });

  it('forbids inventing rules that are not written down', () => {
    assert.match(GUIDELINE_COMPLIANCE_PROMPT, /Do not invent rules/);
  });

  it('tells the auditor to read listed referenced docs', () => {
    assert.match(GUIDELINE_COMPLIANCE_PROMPT, /read every listed doc/);
  });
});

describe('assembleGuidelineCompliancePrompt', () => {
  it('places guidelines before context and the reminder last', () => {
    const prompt = assembleGuidelineCompliancePrompt('PR_CONTEXT_SENTINEL', 'GUIDELINES_SENTINEL');

    assert.ok(prompt.startsWith(GUIDELINE_COMPLIANCE_PROMPT));
    assert.ok(prompt.endsWith(GUIDELINE_COMPLIANCE_OUTPUT_REMINDER));
    assert.ok(prompt.indexOf('GUIDELINES_SENTINEL') < prompt.indexOf('PR_CONTEXT_SENTINEL'));
  });

  it('omits the guidelines section when guidelines are already embedded in the context', () => {
    const prompt = assembleGuidelineCompliancePrompt('PR_CONTEXT_SENTINEL', '');

    assert.doesNotMatch(prompt, /## Repository review guidelines/);
  });
});
```

- [ ] **Step 2: Write the failing dedupe tests**

Append to `test/filter.test.ts` (the `finding()` helper already exists there from Task 3). Extend the import with `dedupeFindings`:

```typescript
describe('dedupeFindings', () => {
  it('keeps the first finding on a path:line collision', () => {
    const main = [finding({ line: 5, title: 'main wins' })];
    const compliance = [
      finding({ line: 5, title: 'duplicate from compliance' }),
      finding({ line: 9, title: 'unique compliance finding' }),
    ];

    const merged = dedupeFindings(main, compliance);

    assert.deepEqual(
      merged.map((f) => f.title),
      ['main wins', 'unique compliance finding'],
    );
  });

  it('does not collide findings in different files', () => {
    const merged = dedupeFindings(
      [finding({ path: 'a.ts', line: 5 })],
      [finding({ path: 'b.ts', line: 5 })],
    );

    assert.equal(merged.length, 2);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --import tsx --test test/prompt.test.ts test/filter.test.ts`
Expected: FAIL — the new exports do not exist.

- [ ] **Step 4: Append the compliance prompt to `src/shared/prompt.ts`**

(Note the template-literal escaping: `\\n` where the model must see `\n`, `` \` `` for literal backticks, `\\"` where the JSON example must show escaped quotes.)

```typescript
export const GUIDELINE_COMPLIANCE_PROMPT = `You are auditing a pull request for compliance with this repository's
written engineering standards. A separate reviewer handles general bugs; your
ONLY job is to check the changed code against the written rules provided
below.

## How to work

- The "Pull request" section below identifies the PR base and head and the
  exact git diff command that shows what this PR changes. Audit only that
  diff.
- The "Repository review guidelines" section contains the standards to
  enforce. Work through them rule by rule; for each rule that could apply to
  any changed file, verify the changed code complies. Do not skim.
- If a "Referenced Markdown documents" list is present, read every listed doc
  whose subject could plausibly apply to the changed files before you
  conclude.
- Report one finding per violation, anchored to a line ADDED by this PR.
- Every finding body MUST name or quote the specific written rule it violates
  and the document it comes from.
- Do not report issues in code this PR did not touch.
- Do not invent rules that are not written in the provided guidance.
- Do NOT modify any files. This is a read-only audit.

## Severity

- "P1": violation of a rule the documents mark as mandatory or blocking, with
  material impact on this change.
- "P2": clear violation of a written standard.
- "P3": deviation from a written recommendation or preference.
- Do not use "P0" or "nit". Prefer the lower severity when uncertain.

## Output

Respond with a SINGLE raw JSON object and NOTHING else — no text before or
after it, and no markdown fences around it. Markdown is allowed only inside
JSON string values; escape newlines inside string values as \\n.

{
  "findings": [
    {
      "path": "src/billing/invoice.ts",
      "line": 42,
      "severity": "P2",
      "kind": "maintainability",
      "confidence": "high",
      "title": "Floating promise violates TECHNICAL_STANDARDS.md",
      "body": "TECHNICAL_STANDARDS.md says \\"every promise must be awaited or explicitly voided\\". \`sendReceipt()\` on this line is neither."
    }
  ]
}

Field constraints are the same as a normal review finding: "path" and "line"
must point at a line ADDED by this PR; "severity" is one of "P1", "P2", "P3";
"kind" is one of "bug", "security", "performance", "maintainability",
"architecture", "test", "docs", "investigate"; "confidence" is one of "high",
"medium", "low". If nothing violates the written rules, return
{"findings": []}.`;

export const GUIDELINE_COMPLIANCE_OUTPUT_REMINDER = `## Final output reminder

Respond now with one raw JSON object with the single top-level key
"findings", matching the schema above. Do not write any text before or after
the JSON. Do not wrap it in markdown fences. Markdown is allowed only inside
JSON string values; escape newlines inside string values as \\n.`;

export function assembleGuidelineCompliancePrompt(prContext: string, guidelines: string): string {
  const parts = [GUIDELINE_COMPLIANCE_PROMPT];
  if (guidelines) {
    parts.push('## Repository review guidelines\n', guidelines);
  }
  parts.push(prContext, GUIDELINE_COMPLIANCE_OUTPUT_REMINDER);
  return parts.join('\n\n');
}
```

- [ ] **Step 5: Implement `dedupeFindings` in `src/shared/filter.ts`**

```typescript
/**
 * Merges findings from multiple review sessions. On a path:line collision the
 * earlier list wins — pass the main review first so its richer context is the
 * one that posts.
 */
export function dedupeFindings(...findingLists: Finding[][]): Finding[] {
  const seen = new Set<string>();
  const merged: Finding[] = [];
  for (const findings of findingLists) {
    for (const finding of findings) {
      const key = `${finding.path}:${finding.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(finding);
    }
  }
  return merged;
}
```

(`Finding` is already imported in filter.ts from Task 3.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --import tsx --test test/prompt.test.ts test/filter.test.ts`
Expected: PASS.

- [ ] **Step 7: Add `runGuidelineComplianceCheck` to `src/shared/opencode.ts`**

Extend the prompt import:

```typescript
import {
  assembleAddressedPriorCommentsPrompt,
  assembleGuidelineCompliancePrompt,
  assembleReviewPrompt,
} from './prompt.ts';
```

Add after `runAddressedPriorCommentsCheck`:

```typescript
export async function runGuidelineComplianceCheck(
  client: OpencodeClient,
  model: string,
  prContext: string,
  guidelines: string,
  log: (msg: string) => void,
): Promise<Finding[]> {
  const prompt = assembleGuidelineCompliancePrompt(prContext, guidelines);
  const raw = await promptPlanAgent(client, model, prompt, 'guideline-compliance', log);
  return parseReview(raw, 'guideline-compliance', log).findings;
}
```

(Non-strict parse is deliberate — this session follows the addressed-check policy: best-effort, never fails the run.)

- [ ] **Step 8: Wire the session into `src/shared/runner.ts`**

1. Extend imports:

```typescript
import { dedupeFindings, demoteLowConfidenceBlockingFindings, isNoiseFile } from './filter.ts';
```

and add `runGuidelineComplianceCheck` to the `./opencode.ts` import list.

2. Add to `ReviewRunOptions`:

```typescript
  guidelinePass?: boolean;
```

and to `normalizeOptions`:

```typescript
    guidelinePass: options?.guidelinePass ?? true,
```

3. Start the session in parallel, directly after the `startAddressedPriorCommentsCheck` call:

```typescript
const guidelineComplianceCheck = startGuidelineComplianceCheck({
  client,
  model,
  prContext: basePrContext,
  guidelinesForPrompt,
  hasGuidelines: Boolean(guidelines),
  enabled: options.guidelinePass,
  log,
});
```

(`basePrContext` deliberately excludes the Context7 block; in enhanced mode the
guidelines are already embedded in it and `guidelinesForPrompt` is `''`, in
basic mode `guidelinesForPrompt` carries them — `assembleGuidelineCompliancePrompt`
handles both.)

4. Merge before the confidence gate. Replace the Task 3 block

```typescript
const confidenceGate = demoteLowConfidenceBlockingFindings(findings);
```

with:

```typescript
const complianceFindings = await guidelineComplianceCheck;
const combinedFindings = dedupeFindings(findings, complianceFindings);
const confidenceGate = demoteLowConfidenceBlockingFindings(combinedFindings);
```

and update the completion log line to:

```typescript
log(
  `Review complete: ${findings.length} main + ${complianceFindings.length} compliance finding(s), ${filteredFindings.length} after filters, ${verifiedAddressedPriorComments.length} addressed prior comment(s)`,
);
```

5. Add the helper at module level (next to `startAddressedPriorCommentsCheck`):

```typescript
function startGuidelineComplianceCheck(params: {
  client: Awaited<ReturnType<typeof startOpencode>>['client'];
  model: string;
  prContext: string;
  guidelinesForPrompt: string;
  hasGuidelines: boolean;
  enabled: boolean;
  log: (msg: string) => void;
}): Promise<Finding[]> {
  if (!params.enabled) return Promise.resolve([]);
  if (!params.hasGuidelines) {
    params.log('Guideline-compliance check skipped: no repository guidelines discovered.');
    return Promise.resolve([]);
  }

  params.log('Starting guideline-compliance check in parallel.');
  return runGuidelineComplianceCheck(
    params.client,
    params.model,
    params.prContext,
    params.guidelinesForPrompt,
    params.log,
  )
    .then((findings) => {
      params.log(`Guideline-compliance check complete: ${findings.length} finding(s)`);
      return findings;
    })
    .catch((error) => {
      params.log(
        `(skipped guideline-compliance check: ${
          error instanceof Error ? error.message : String(error)
        })`,
      );
      return [];
    });
}
```

- [ ] **Step 9: Plumb the action input**

In `src/workflow/index.ts`, add to the `options` object:

```typescript
    guidelinePass: parseBooleanInput('enable-guideline-pass', true),
```

In `action.yml`, add under `inputs:` (after `include-prior-comments`):

```yaml
enable-guideline-pass:
  description: 'Run a dedicated guideline-compliance review session when repository guidelines are discovered.'
  required: false
  default: 'true'
```

and under `runs.env` (after `INPUT_INCLUDE-PRIOR-COMMENTS`):

```yaml
INPUT_ENABLE-GUIDELINE-PASS: ${{ inputs.enable-guideline-pass }}
```

- [ ] **Step 10: Verify and commit**

```bash
npm run typecheck
npm test
npm run lint
npm run format
git add src/shared/prompt.ts src/shared/opencode.ts src/shared/filter.ts src/shared/runner.ts src/workflow/index.ts action.yml test/prompt.test.ts test/filter.test.ts
git commit -m "feat: dedicated parallel guideline-compliance review session"
```

---

### Task 10: Documentation touch-up and full verification

**Files:**

- Modify: `README.md` ("How it works" item 4 around line 28, input reference table around line 263, "Project guidelines" section around line 846)
- No test changes.

- [ ] **Step 1: Update the README's "How it works" step 4**

Replace:

```markdown
4. The agent returns structured findings as JSON; the wrapper validates,
   gates, and posts one review with inline comments + a deterministic verdict.
```

with:

```markdown
4. The agent receives the PR's exact base...head diff scope and returns
   structured findings as JSON; the wrapper validates line anchors against the
   diff, demotes low-confidence blocking findings, gates by severity, and posts
   one review with inline comments + a deterministic verdict. Two parallel
   read-only sessions run alongside the main review: one audits the diff
   against discovered repository guidelines rule-by-rule, and one verifies
   which prior jbot-review threads the branch has addressed.
```

- [ ] **Step 2: Add the new input to the README input reference table**

After the `include-prior-comments` row, add:

```markdown
| `enable-guideline-pass` | No | `true` | Run a dedicated guideline-compliance session when repo guidelines exist |
```

- [ ] **Step 3: Update the README "Project guidelines" section**

In the bullet list, after the `REVIEW.md` bullet, add:

```markdown
- `TECHNICAL_STANDARDS.md`, `ARCHITECTURE.md` — engineering and architecture standards
```

Replace the sentence:

```markdown
Markdown docs referenced from those files are deduplicated and listed as
available paths instead of being preloaded into every review.
```

with:

```markdown
Markdown docs referenced from `.pr-governance/README.md` are preloaded (within
the guidance budget) because a governance index points at review rules by
definition; docs referenced from other guidance files are deduplicated and
listed as available paths, read on demand. When any guidelines are discovered,
a dedicated guideline-compliance session audits the diff rule-by-rule in
parallel with the main review (disable with `enable-guideline-pass: false`).
```

- [ ] **Step 4: Full verification suite**

```bash
npm run typecheck
npm test
npm run lint
npm run format:check
npm run build
npm run replay
```

Expected: all clean. The replay output must show, in order: the `## Pull request` section containing `Base: main (...)` and the `git diff 1111...2222` command, then guidelines sections, with no `addressedPriorComments` mention anywhere in the static prompt (replay prints only the context, not the static prompt — the prompt invariants are covered by `test/prompt.test.ts`).

- [ ] **Step 5: Final review of the diff**

Run: `git log --oneline main@{u}..HEAD 2>/dev/null || git log --oneline -10`
Expected commits (order may vary slightly):

1. `feat: add PR diff scope (base/head + exact git diff command) to review context`
2. `feat: thread PR base/head diff scope through both entry points`
3. `feat: demote low-confidence blocking findings to P3 in code`
4. `feat: accept both addressedByCommit casings; export parseReview for tests`
5. `feat: rewrite review prompt — concrete example schema, wrapper contract up front, architecture dimension`
6. `feat: single canonical prior-thread rules block; dedicated session owns addressed checks`
7. `feat: end-of-prompt output reminders; centralize prompt text and assembly in prompt.ts`
8. `feat: preload governance-referenced docs and TECHNICAL_STANDARDS/ARCHITECTURE standards files`
9. `feat: dedicated parallel guideline-compliance review session`
10. `docs: describe diff scope, confidence gate, guideline pass, and addressed check in README`

- [ ] **Step 6: Commit the docs change**

```bash
git add README.md
git commit -m "docs: describe diff scope, confidence gate, guideline pass, and addressed check in README"
```

---

## Finding-to-task traceability

| Finding                                                                                                                                             | Task(s)                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| A1 — base ref/SHA + exact three-dot diff command in context                                                                                         | Task 1 (core), Task 2 (wiring)                                             |
| A2 — output contract restated at end of assembled prompt; newline-escape rule                                                                       | Task 7 (reminders + assembly), Task 5 (escape rule also in Output section) |
| A3 — concrete example replaces union syntax; field-constraints list                                                                                 | Task 5                                                                     |
| A4 — accept both `addressedByCommit` casings; consistent camelCase schema                                                                           | Task 4 (parser), Task 7 (dedicated prompt schema)                          |
| B1 — declined-thread rule stated once, canonically, next to thread data                                                                             | Task 5 (removed from static prompt), Task 6 (canonical block)              |
| B2 — thorough-vs-shortest tension resolved with one directive                                                                                       | Task 5                                                                     |
| B3 — dedicated session is single owner of addressed checks                                                                                          | Task 5 (schema removal), Task 6 (runner merge removal)                     |
| B4 — low-confidence blocking findings demoted in code                                                                                               | Task 3                                                                     |
| C1 — wrapper behavior explained up front ("How your output is used")                                                                                | Task 5                                                                     |
| C2 — "Rules for lines" merged into output field constraints                                                                                         | Task 5                                                                     |
| D1 — written repo standards reliably enforced (preload governance docs + standards files, larger budget, dedicated rule-by-rule compliance session) | Task 8 (discovery), Task 9 (session)                                       |
| D2 — architecture as a first-class review dimension (`architecture` kind, design checks, "Architecture notes" summary outlet)                       | Task 5                                                                     |
| Latent gap — hosted app never passed `headSha`                                                                                                      | Task 2, Step 4                                                             |

## Known non-goals (YAGNI)

- No provider-level structured-output / JSON mode — multi-provider support makes this impractical; the tolerant extractor + reminders are the chosen mitigation.
- No retry-on-unparseable-JSON loop — strict failure remains the correct behavior for the main review (never post a misleading "good to go").
- No changes to `decideVerdict` (always `COMMENT`), noise filtering, or Context7 logic — these were assessed as already following best practice.
- No dedicated _architecture_ session yet — the main pass gains explicit architecture checks (Task 5); if architecture recall still lags after this lands, a parallel architecture session can reuse the Task 9 session pattern verbatim.
- No hosted-app env var for the guideline pass — the hosted app uses the `guidelinePass` default (`true`); add a `GUIDELINE_PASS` env var only if an operator asks for it.
