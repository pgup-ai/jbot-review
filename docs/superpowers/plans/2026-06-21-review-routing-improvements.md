# Review Routing Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make jbot-review's guideline/playbook routing relevance-aware — close the infra coverage hole, load DESIGN/ADR docs, and stop diluting bug-finder sessions with the full guideline corpus while the dedicated compliance session keeps it.

**Architecture:** Three independent, separately-shippable changes on the existing pure-module seams. (A) extend the shared `PATH_PATTERNS` taxonomy + playbook registry with an `infra` category and broaden the external-integration trigger; (B) add `DESIGN.md`/`DECISIONS.md` to the guideline discovery lists; (C) split guideline discovery into a structured pass (`discoverGuidelineDocs`) plus two pure renderers — `formatGuidelines` (full, for the compliance session) and `formatFinderGuidelines` (relevance-ranked, capped, for finder shards + lenses). `discoverGuidelines` stays as a thin string-returning wrapper so existing callers/tests are untouched.

**Tech Stack:** TypeScript ESM (`.ts` import specifiers, run via tsx), node:test + `node:assert/strict`, oxlint, prettier. No new dependencies.

---

## Invariants this plan must respect

- **#1 Full-diff scope, always.** None of these changes narrow what the model reviews — finders still receive the whole diff; only the *guideline text* attached to finder sessions shrinks. The compliance session still audits the full guideline set.
- **#3 Auxiliary sessions fail open.** The compliance and lens sessions keep their fail-open behavior; this plan does not add a failure path that can drop findings.
- **#4 Every injected context block has a hard byte budget and lists what it omitted.** The new finder render is capped and appends an omission notice (no silent truncation).
- **#5 Prompt assembly order unchanged.** Guidelines still land in the early prompt slot via `assembleReviewPrompt`; only the *content* attached to finders changes.
- **#10 Extract pure logic for tests; `runner.ts` only wires.** All routing/budget decisions live in `diff-context.ts`, `review-playbooks.ts`, `prompt.ts`, and `review-context.ts` as pure, unit-tested functions. `runner.ts` changes are wiring only.

**Out of scope (deliberate, YAGNI):**
- Item 2 (per-shard / per-category playbook scoping) — evaluated and rejected: playbooks are ~2 KB, not the dilution driver, and narrowing risks cross-category interaction recall.
- LLM/content-based categorization — the additive union-on-uncertainty design already absorbs path-regex misses.
- Recursive (>1 hop) reference following and whole-ADR-directory loading — would reintroduce dilution; we add specific filenames only.

**Not applicable to this repo (called out so reviewers know it was considered):** there is no Temporal usage and no DTO/ORM layer in jbot-review. The "schema/contract" surfaces here are (a) the review-finding JSON contract in `prompt.ts` and (b) the TypeScript interfaces in `review-context.ts`/`types.ts`; this plan keeps both stable (additive only).

---

## File Structure

| File | Change | Responsibility |
| --- | --- | --- |
| `src/shared/diff-context.ts` | Modify | Add `PATH_PATTERNS.infra`; add an infra `RISK_RULES` weight so infra hunks get embedded. |
| `test/diff-context.test.ts` | Modify | Cover the infra pattern + risk weight. |
| `src/shared/prompt.ts` | Modify | Add `'infra-ops'` to `ReviewPlaybookId`; add the `INFRA_OPS` playbook to `REVIEW_PLAYBOOKS`. |
| `test/prompt.test.ts` | Modify | Cover the infra playbook id is unioned-in (via review-playbooks) — see Task A3. |
| `src/shared/review-playbooks.ts` | Modify | Add `INFRA_OPS` selection + ordering; broaden `EXTERNAL_INTEGRATION_PATTERNS` to catch fetch/download scripts. |
| `test/review-playbooks.test.ts` | Modify | Cover infra selection + the `fetch-logos.mjs` supply-chain trigger. |
| `src/shared/review-context.ts` | Modify | Add `DESIGN.md`/`DECISIONS.md` to discovery lists; introduce structured `discoverGuidelineDocs` + `formatGuidelines` + `formatFinderGuidelines`; keep `discoverGuidelines` as a wrapper. |
| `test/review-context.test.ts` | Modify | Cover DESIGN.md discovery, structured docs, finder cap + scoped-first ranking, full render unchanged. |
| `src/shared/runner.ts` | Modify | Wire finders/lenses to the finder render and the compliance session to the full render; add infra focus bullet. |

---

## Phase A — Infra category + supply-chain trigger (Item 1)

### Task A1: Add the `infra` path pattern and diff-risk weight

**Files:**
- Modify: `src/shared/diff-context.ts:19-25` (`PATH_PATTERNS`) and `src/shared/diff-context.ts:66-76` (`RISK_RULES`)
- Test: `test/diff-context.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `test/diff-context.test.ts` (import `PATH_PATTERNS` alongside the existing imports at the top of the file):

```typescript
describe('PATH_PATTERNS.infra', () => {
  it('matches IaC, containers, and deploy manifests', () => {
    for (const file of [
      'infra/main.tf',
      'terraform/prod.tfvars',
      'Dockerfile',
      'services/api/Dockerfile.prod',
      'deploy/k8s/app.yaml',
      'helm/charts/web/values.yaml',
      'pulumi/index.ts',
    ]) {
      assert.ok(PATH_PATTERNS.infra.test(file), `expected infra match: ${file}`);
    }
  });

  it('does not match application code or CI workflows', () => {
    for (const file of ['src/shared/runner.ts', '.github/workflows/ci.yml', 'README.md']) {
      assert.ok(!PATH_PATTERNS.infra.test(file), `unexpected infra match: ${file}`);
    }
  });
});

describe('diffRiskScore infra weighting', () => {
  it('ranks an infra change above prose and above a generic config file', () => {
    const infra = { filename: 'deploy/k8s/app.yaml', patch: '+ replicas: 3' };
    const genericYaml = { filename: 'config/app.yaml', patch: '+ key: value' };
    const doc = { filename: 'docs/guide.md', patch: '+ words' };
    assert.ok(diffRiskScore(infra) > diffRiskScore(genericYaml));
    assert.ok(diffRiskScore(genericYaml) > diffRiskScore(doc));
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --import tsx --test test/diff-context.test.ts`
Expected: FAIL — `PATH_PATTERNS.infra` is `undefined` (`Cannot read properties of undefined (reading 'test')`).

- [ ] **Step 3: Add the pattern and risk weight**

In `src/shared/diff-context.ts`, add an `infra` key to `PATH_PATTERNS` (after `tests`):

```typescript
export const PATH_PATTERNS = {
  security: /(^|\/)(auth|security|permissions?|policies)\//i,
  data: /(^|\/)(db|database|migrations?|prisma|drizzle|schema)\//i,
  api: /(^|\/)(api|routes?|controllers?|server|webhooks?)\//i,
  tooling: /(^|\/)(package\.json|action\.ya?ml)$|^\.github\/workflows\/.+\.ya?ml$/i,
  tests: /(^|\/)(test|tests|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$/i,
  infra: /(^|\/)(infra(?:structure)?|terraform|deploy(?:ment)?|k8s|kubernetes|helm|charts?|ansible|pulumi)\/|(^|\/)Dockerfile(?:\.[^/]+)?$|(^|\/)(?:docker-)?compose\.ya?ml$|\.(?:tf|tfvars|bicep)$/i,
} as const;
```

Then add a weight to `RISK_RULES` (place it between the `api` rule and the source-extension rule so infra ranks just under data/api):

```typescript
const RISK_RULES: RiskRule[] = [
  { pattern: PATH_PATTERNS.security, weight: 60 },
  { pattern: PATH_PATTERNS.data, weight: 50 },
  { pattern: PATH_PATTERNS.api, weight: 50 },
  { pattern: PATH_PATTERNS.infra, weight: 40 },
  { pattern: /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|cs|swift|c|cc|cpp|h)$/i, weight: 30 },
  { pattern: /\.(vue|svelte)$/i, weight: 30 },
  { pattern: PATH_PATTERNS.tooling, weight: 25 },
  { pattern: /\.(ya?ml|json|toml|ini|env)$/i, weight: 15 },
  { pattern: PATH_PATTERNS.tests, weight: -20 },
  { pattern: /\.(md|mdx|txt|rst)$/i, weight: -25 },
];
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --import tsx --test test/diff-context.test.ts`
Expected: PASS (all existing tests still green).

- [ ] **Step 5: Commit**

```bash
git add src/shared/diff-context.ts test/diff-context.test.ts
git commit -m "feat(diff-context): add infra path category and diff-risk weight"
```

---

### Task A2: Add the `infra-ops` review playbook

**Files:**
- Modify: `src/shared/prompt.ts:354-435` (`ReviewPlaybookId`, playbook consts, `REVIEW_PLAYBOOKS`)
- Test: covered via `test/review-playbooks.test.ts` in Task A3 (the block renderer is data-driven, so the existing `buildReviewPlaybookBlock` test in Task A3 asserts the new section).

- [ ] **Step 1: Add `'infra-ops'` to the id union**

In `src/shared/prompt.ts`, extend `ReviewPlaybookId`:

```typescript
export type ReviewPlaybookId =
  | 'code-review-core'
  | 'contract-api'
  | 'backend-data'
  | 'frontend-workflow'
  | 'external-integration'
  | 'infra-ops';
```

- [ ] **Step 2: Define the playbook**

Add after the `EXTERNAL_INTEGRATION` const (around `src/shared/prompt.ts:427`):

```typescript
const INFRA_OPS: ReviewPlaybook = {
  id: 'infra-ops',
  title: 'Infra/ops review',
  triggers: ['IaC, container, Kubernetes/Helm, or deployment-config changes'],
  checks: [
    'Check least privilege and exposure: IAM/roles, security groups, network policies, public ingress, and that no plaintext secrets are committed (secret refs only).',
    'Verify resource correctness: pinned image tags/digests (not floating latest), replica/probe/resource-limit config, and env/config wiring matching what the app reads.',
    'Confirm change safety: no destructive resource replacement, correct apply/migration ordering, and no drift between declared names and the names other manifests reference.',
  ],
};
```

- [ ] **Step 3: Register it in `REVIEW_PLAYBOOKS`**

```typescript
export const REVIEW_PLAYBOOKS = [
  CODE_REVIEW_CORE,
  CONTRACT_API,
  BACKEND_DATA,
  FRONTEND_WORKFLOW,
  EXTERNAL_INTEGRATION,
  INFRA_OPS,
] as const satisfies readonly ReviewPlaybook[];
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS — the `satisfies readonly ReviewPlaybook[]` and the `ReviewPlaybookId` union now include `infra-ops`. (If the order array in `review-playbooks.ts` is not yet updated, typecheck still passes — that array is widened in Task A3.)

- [ ] **Step 5: Commit**

```bash
git add src/shared/prompt.ts
git commit -m "feat(prompt): add infra-ops review playbook"
```

---

### Task A3: Select the infra playbook and broaden the supply-chain trigger

**Files:**
- Modify: `src/shared/review-playbooks.ts`
- Test: `test/review-playbooks.test.ts`

> Note: `buildReviewPlaybookBlock` and `selectReviewPlaybookIds` are both imported in `test/review-playbooks.test.ts` ([review-playbooks.test.ts:4-5](../../../test/review-playbooks.test.ts)); `test/prompt.test.ts` imports neither. All A3 tests therefore live in `review-playbooks.test.ts`.

- [ ] **Step 1: Write the failing tests**

Add to `test/review-playbooks.test.ts` inside `describe('selectReviewPlaybookIds', ...)`:

```typescript
it('selects infra-ops for IaC and container changes', () => {
  assert.ok(selectReviewPlaybookIds(['infra/main.tf']).includes('infra-ops'));
  assert.ok(selectReviewPlaybookIds(['Dockerfile']).includes('infra-ops'));
  assert.ok(selectReviewPlaybookIds(['deploy/k8s/app.yaml']).includes('infra-ops'));
});

it('routes remote-fetch scripts to external-integration (supply-chain)', () => {
  const ids = selectReviewPlaybookIds(['scripts/fetch-logos.mjs']);
  assert.ok(ids.includes('external-integration'), `got: ${ids.join(', ')}`);
});
```

Add to `test/review-playbooks.test.ts` inside `describe('buildReviewPlaybookBlock', ...)` (both functions are already imported at the top of this file):

```typescript
it('renders the infra-ops playbook when infra files change', () => {
  const block = buildReviewPlaybookBlock(selectReviewPlaybookIds(['infra/main.tf']));
  assert.match(block, /### Infra\/ops review \(infra-ops\)/);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --import tsx --test test/review-playbooks.test.ts`
Expected: FAIL — infra-ops not selected; `fetch-logos.mjs` returns only `code-review-core`.

- [ ] **Step 3: Implement selection + broadened trigger**

In `src/shared/review-playbooks.ts`:

Add the id constant and extend the order array:

```typescript
const CODE_REVIEW_CORE: ReviewPlaybookId = 'code-review-core';
const CONTRACT_API: ReviewPlaybookId = 'contract-api';
const BACKEND_DATA: ReviewPlaybookId = 'backend-data';
const FRONTEND_WORKFLOW: ReviewPlaybookId = 'frontend-workflow';
const EXTERNAL_INTEGRATION: ReviewPlaybookId = 'external-integration';
const INFRA_OPS: ReviewPlaybookId = 'infra-ops';

const REVIEW_PLAYBOOK_ORDER = [
  CODE_REVIEW_CORE,
  CONTRACT_API,
  BACKEND_DATA,
  FRONTEND_WORKFLOW,
  EXTERNAL_INTEGRATION,
  INFRA_OPS,
] as const satisfies readonly ReviewPlaybookId[];
```

Broaden `EXTERNAL_INTEGRATION_PATTERNS` by appending a remote-fetch script filename rule (keep the existing entries; add the last line):

```typescript
const EXTERNAL_INTEGRATION_PATTERNS = [
  PATH_PATTERNS.tooling,
  /(^|\/)(integrations?|clients?|providers?|webhooks?|workers?|jobs?|auth|oauth)\//i,
  /(^|\/)\.github\/workflows\/.+\.ya?ml$/i,
  /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|action\.ya?ml)$/i,
  /(^|\/)[^/]*(client|provider|webhook|oauth|github|octokit|stripe|openai|anthropic|sdk)[^/]*\.[cm]?[jt]sx?$/i,
  /(^|\/)[^/]*(fetch|download|scrape|crawl|ingest)[^/]*\.[cm]?[jt]sx?$/i,
];
```

Add the infra patterns (after `EXTERNAL_INTEGRATION_PATTERNS`):

```typescript
const INFRA_OPS_PATTERNS = [PATH_PATTERNS.infra];
```

Add the selection rule in `selectReviewPlaybookIds` (after the external-integration line):

```typescript
export function selectReviewPlaybookIds(changedFiles: string[]): ReviewPlaybookId[] {
  const selected = new Set<ReviewPlaybookId>([CODE_REVIEW_CORE]);

  if (matchesAny(changedFiles, CONTRACT_API_PATTERNS)) selected.add(CONTRACT_API);
  if (matchesAny(changedFiles, BACKEND_DATA_PATTERNS)) selected.add(BACKEND_DATA);
  if (matchesAny(changedFiles, FRONTEND_WORKFLOW_PATTERNS)) selected.add(FRONTEND_WORKFLOW);
  if (matchesAny(changedFiles, EXTERNAL_INTEGRATION_PATTERNS)) selected.add(EXTERNAL_INTEGRATION);
  if (matchesAny(changedFiles, INFRA_OPS_PATTERNS)) selected.add(INFRA_OPS);

  return REVIEW_PLAYBOOK_ORDER.filter((id) => selected.has(id));
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --import tsx --test test/review-playbooks.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/review-playbooks.ts test/review-playbooks.test.ts
git commit -m "feat(review-playbooks): select infra-ops and route remote-fetch scripts to external-integration"
```

---

### Task A4: Mirror infra in the runner focus block (wiring)

**Files:**
- Modify: `src/shared/runner.ts:1193-1234` (`buildReviewFocusBlock`)

> Note: `buildReviewFocusBlock` is a private wiring helper in `runner.ts` and is intentionally untested (the routing *decision* is tested in `selectReviewPlaybookIds` / `PATH_PATTERNS`). This step keeps the focus checklist consistent with the new playbook; it adds no new decision logic, so it follows invariant #10 by not introducing testable logic into the runner.

- [ ] **Step 1: Add the infra focus bullet**

In `buildReviewFocusBlock`, add a branch after the `security` branch:

```typescript
    if (PATH_PATTERNS.security.test(file)) {
      focusItems.add('Security: privilege, tokens, tenant isolation, unsafe input boundaries.');
    }
    if (PATH_PATTERNS.infra.test(file)) {
      focusItems.add('Infra/ops: least privilege, exposure, pinned versions, rollout/rollback safety.');
    }
```

- [ ] **Step 2: Typecheck + full test sweep**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/shared/runner.ts
git commit -m "feat(runner): add infra focus bullet to the review focus block"
```

---

## Phase B — DESIGN/ADR doc discovery (Item 4)

### Task B1: Add `DESIGN.md` and `DECISIONS.md` to the discovery lists

**Files:**
- Modify: `src/shared/review-context.ts:112-140` (`ROOT_GUIDELINE_FILES`, `SCOPED_GUIDELINE_FILES`)
- Test: `test/review-context.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `test/review-context.test.ts` inside `describe('discoverGuidelines', ...)`:

```typescript
it('loads DESIGN.md and DECISIONS.md as root guidance', async () => {
  await withTempRepo(async (repo) => {
    await writeFile(join(repo, 'DESIGN.md'), '# Design\nArchitecture decisions');
    await writeFile(join(repo, 'DECISIONS.md'), '# Decisions\nADR log');
    const guidelines = await discoverGuidelines(repo);
    assert.match(guidelines, /### DESIGN\.md\n# Design/);
    assert.match(guidelines, /### DECISIONS\.md\n# Decisions/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --import tsx --test test/review-context.test.ts`
Expected: FAIL — DESIGN.md / DECISIONS.md not loaded.

- [ ] **Step 3: Add the filenames**

In `src/shared/review-context.ts`, add `'DESIGN.md'` and `'DECISIONS.md'` to both lists (placed next to the other architecture docs):

```typescript
const ROOT_GUIDELINE_FILES = [
  'AGENTS.md',
  'REVIEW.md',
  'TECHNICAL_STANDARDS.md',
  'ARCHITECTURE.md',
  'DESIGN.md',
  'DECISIONS.md',
  'CLAUDE.md',
  'CONTRIBUTING.md',
  '.cursor/BUGBOT.md',
  '.github/copilot-instructions.md',
  '.cursorrules',
  '.windsurfrules',
  '.coderabbit.yaml',
  '.coderabbit.yml',
  'greptile.json',
];

const SCOPED_GUIDELINE_FILES = [
  'AGENTS.md',
  'REVIEW.md',
  'TECHNICAL_STANDARDS.md',
  'DESIGN.md',
  'CLAUDE.md',
  'CONTRIBUTING.md',
  '.cursor/BUGBOT.md',
  '.agents/REVIEW.md',
  '.devin/REVIEW.md',
  '.cursor/REVIEW.md',
  '.cursorrules',
  '.windsurfrules',
];
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --import tsx --test test/review-context.test.ts`
Expected: PASS (all existing discovery tests still green).

- [ ] **Step 5: Commit**

```bash
git add src/shared/review-context.ts test/review-context.test.ts
git commit -m "feat(review-context): discover DESIGN.md and DECISIONS.md guidance"
```

---

## Phase C — Per-session-role guideline budget (Item 3)

This is the dilution fix. C1 is a behavior-preserving refactor (existing tests are the regression guard). C2 adds the capped finder render. C3 wires roles in the runner.

### Task C1: Extract structured discovery (`discoverGuidelineDocs` + `formatGuidelines`)

**Files:**
- Modify: `src/shared/review-context.ts` (the `discoverGuidelines` function body + `formatGuidelineSections`)
- Test: `test/review-context.test.ts` (new structured-output test; all existing tests must stay green unchanged)

- [ ] **Step 1: Write the failing test**

Add to `test/review-context.test.ts` (extend the import to include the new symbols):

```typescript
import {
  buildReviewContext,
  discoverGuidelines,
  discoverGuidelineDocs,
  formatGuidelines,
  formatDiffScope,
} from '../src/shared/review-context.ts';
```

```typescript
describe('discoverGuidelineDocs', () => {
  it('returns structured docs and marks scoped guidance higher relevance', async () => {
    await withTempRepo(async (repo) => {
      await writeFile(join(repo, 'AGENTS.md'), '# Agents\nRoot');
      await mkdir(join(repo, 'apps', 'web'), { recursive: true });
      await writeFile(join(repo, 'apps', 'web', 'AGENTS.md'), '# Web Agents\nScoped');

      const discovered = await discoverGuidelineDocs(repo, ['apps/web/index.ts']);
      const root = discovered.docs.find((d) => d.label === 'AGENTS.md');
      const scoped = discovered.docs.find((d) => d.label === 'apps/web/AGENTS.md');

      assert.ok(root, 'root AGENTS.md present');
      assert.ok(scoped, 'scoped AGENTS.md present');
      assert.ok(scoped.relevance > root.relevance, 'scoped outranks root');
      // formatGuidelines still emits the legacy section markers for both docs.
      // (Asserting against discoverGuidelines() would be circular — it now
      // delegates to formatGuidelines. The pre-existing discoverGuidelines
      // regex assertions are the real behavior-preservation guard.)
      const full = formatGuidelines(discovered);
      assert.match(full, /### AGENTS\.md\n# Agents/);
      assert.match(full, /### apps\/web\/AGENTS\.md\n# Web Agents/);
    });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --import tsx --test test/review-context.test.ts`
Expected: FAIL — `discoverGuidelineDocs` / `formatGuidelines` are not exported.

- [ ] **Step 3: Add the structured types and renderer**

In `src/shared/review-context.ts`, add near the other interfaces (after `DiffScope`):

```typescript
/** Relevance tiers for finder-pass guideline ranking; higher = kept first. */
const GUIDELINE_RELEVANCE = { root: 1, governance: 2, scoped: 3 } as const;
type GuidelineRelevance = (typeof GUIDELINE_RELEVANCE)[keyof typeof GUIDELINE_RELEVANCE];

export interface GuidelineDoc {
  /** Relative-path label, e.g. "apps/web/AGENTS.md". */
  label: string;
  /** Trimmed, byte-bounded text (may end with a per-file truncation notice). */
  text: string;
  /** Higher = more relevant to the changed files (scoped > governance > root). */
  relevance: GuidelineRelevance;
}

export interface DiscoveredGuidelines {
  /** Loaded docs in discovery order. */
  docs: GuidelineDoc[];
  /** Labels referenced by loaded docs but not themselves loaded (sorted). */
  referenced: string[];
  /** True when the total discovery budget was exhausted before all files. */
  budgetExhausted: boolean;
}
```

Add the full renderer (replaces `formatGuidelineSections`; keep `formatGuidelineLabel`):

```typescript
export function formatGuidelines(discovered: DiscoveredGuidelines): string {
  const sections = discovered.docs.map((doc) => `### ${doc.label}\n${doc.text}`);

  if (discovered.budgetExhausted) {
    sections.push(
      [
        '### Review guidance budget',
        `Additional guidance was skipped after the ${MAX_GUIDELINE_TOTAL_BYTES} byte review guidance budget was reached.`,
      ].join('\n'),
    );
  }

  if (discovered.referenced.length > 0) {
    sections.push(
      [
        '### Referenced Markdown documents',
        'These docs were mentioned by loaded review guidance but were not preloaded. Read them only when relevant to the changed files or review question.',
        discovered.referenced.map((label) => `- ${label}`).join('\n'),
      ].join('\n'),
    );
  }

  return sections.join('\n\n');
}
```

- [ ] **Step 4: Convert `discoverGuidelines` into `discoverGuidelineDocs` + wrapper**

Rename the existing `export async function discoverGuidelines(...)` to `export async function discoverGuidelineDocs(...): Promise<DiscoveredGuidelines>` and change its accumulator and return sites. Concretely:

Replace the accumulator declarations near the top of the function:

```typescript
  const docs: GuidelineDoc[] = [];
  const seen = new Set<string>();
  const seenRealPaths = new Set<string>();
  const referencedDocs = new Map<string, string>();
  const workspaceRoot = await realpath(cwd);
  let remainingGuidelineBytes = MAX_GUIDELINE_TOTAL_BYTES;
  let budgetExhausted = false;
```

Replace `addBudgetNotice()` (it no longer pushes a section — it just flips the flag):

```typescript
  function markBudgetExhausted(): void {
    budgetExhausted = true;
  }
```

In `readBoundedGuidelineFile`, change the early `addBudgetNotice()` call to `markBudgetExhausted()`.

Change `addGuidelineFile` to accept a relevance tier and record a structured doc (it still returns the raw text + path for reference extraction):

```typescript
  async function addGuidelineFile(
    label: string,
    path: string,
    relevance: GuidelineRelevance,
  ): Promise<{ text: string; absolutePath: string } | undefined> {
    const resolved = await resolveExistingInsideWorkspace(path);
    if (!resolved) return undefined;
    if (seen.has(resolved.absolutePath) || seenRealPaths.has(resolved.realPath)) return undefined;
    try {
      const text = await readBoundedGuidelineFile(resolved.realPath);
      if (!text) return undefined;
      const trimmed = text.trim();
      if (!trimmed) return undefined;
      seen.add(resolved.absolutePath);
      seenRealPaths.add(resolved.realPath);
      docs.push({ label, text: trimmed, relevance });
      return { text, absolutePath: resolved.absolutePath };
    } catch {
      return undefined;
    }
  }
```

Thread `relevance` through the helpers that call `addGuidelineFile`:

```typescript
  async function preloadOrListReferencedDoc(baseDir: string, reference: string): Promise<void> {
    const referencedPath = resolveMarkdownReference(cwd, baseDir, reference);
    if (!referencedPath || seen.has(referencedPath)) return;
    const loaded = await addGuidelineFile(
      formatGuidelineLabel(cwd, referencedPath),
      referencedPath,
      GUIDELINE_RELEVANCE.governance,
    );
    if (!loaded) await addReferencedDoc(baseDir, reference);
  }

  async function addGuidelineWithReferences(
    relativePath: string,
    relevance: GuidelineRelevance,
  ): Promise<void> {
    const result = await addGuidelineFile(relativePath, resolve(cwd, relativePath), relevance);
    if (!result) return;
    const baseDir = ['AGENTS.md', 'REVIEW.md'].includes(relativePath)
      ? cwd
      : dirname(result.absolutePath);
    for (const reference of extractMarkdownDocumentReferences(result.text)) {
      deferredReferences.push({ baseDir, reference });
    }
  }

  async function addRuleDirectory(
    relativeDir: string,
    relevance: GuidelineRelevance,
  ): Promise<void> {
    const resolvedDir = await resolveExistingInsideWorkspace(resolve(cwd, relativeDir));
    if (!resolvedDir) return;
    try {
      const entries = await readdir(resolvedDir.realPath, { withFileTypes: true });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isFile()) continue;
        const ext = entry.name.match(/\.[^.]+$/)?.[0] ?? '';
        if (!RULE_DIRECTORY_FILES.has(ext)) continue;
        await addGuidelineWithReferences(`${relativeDir}/${entry.name}`, relevance);
      }
    } catch {
      /* directory absent */
    }
  }
```

Update the call sites in the body to pass relevance tiers:

```typescript
  for (const relativePath of ROOT_GUIDELINE_FILES) {
    await addGuidelineWithReferences(relativePath, GUIDELINE_RELEVANCE.root);
  }
  await addRuleDirectory('.cursor/rules', GUIDELINE_RELEVANCE.root);

  for (const dir of getChangedFileAncestorDirs(changedFiles)) {
    for (const name of SCOPED_GUIDELINE_FILES) {
      await addGuidelineWithReferences(`${dir}/${name}`, GUIDELINE_RELEVANCE.scoped);
    }
    await addRuleDirectory(`${dir}/.cursor/rules`, GUIDELINE_RELEVANCE.scoped);
  }

  const governanceDir = resolve(cwd, '.pr-governance');
  const readme = await addGuidelineFile(
    '.pr-governance/README.md',
    resolve(governanceDir, 'README.md'),
    GUIDELINE_RELEVANCE.governance,
  );
```

In the governance directory-listing fallback, pass governance relevance:

```typescript
        await addGuidelineFile(
          `.pr-governance/${entry.name}`,
          resolve(governanceDir, entry.name),
          GUIDELINE_RELEVANCE.governance,
        );
```

Replace BOTH `return formatGuidelineSections(sections, seen, referencedDocs);` sites with:

```typescript
    await flushDeferredReferences();
    return buildDiscoveredGuidelines(docs, seen, referencedDocs, budgetExhausted);
```

(The early-return governance-README branch and the final return both use this.)

Add the structured-result builder (replaces the available-docs logic inside the old `formatGuidelineSections`):

```typescript
function buildDiscoveredGuidelines(
  docs: GuidelineDoc[],
  loadedPaths: Set<string>,
  referencedDocs: Map<string, string>,
  budgetExhausted: boolean,
): DiscoveredGuidelines {
  const referenced = [...referencedDocs]
    .filter(([path]) => !loadedPaths.has(path))
    .map(([, label]) => label)
    .sort();
  return { docs, referenced, budgetExhausted };
}
```

Finally, add the back-compat wrapper so existing callers and tests are untouched:

```typescript
export async function discoverGuidelines(
  cwd: string,
  changedFiles: string[] = [],
): Promise<string> {
  return formatGuidelines(await discoverGuidelineDocs(cwd, changedFiles));
}
```

Delete the now-unused `formatGuidelineSections` function.

- [ ] **Step 5: Run the full review-context suite**

Run: `node --import tsx --test test/review-context.test.ts && npm run typecheck`
Expected: PASS — every pre-existing assertion (`### AGENTS.md`, `### Review guidance budget`, `### Referenced Markdown documents`, path-escape, symlink, scoped discovery) still holds because `formatGuidelines` reproduces the legacy string, and the new structured test passes.

- [ ] **Step 6: Commit**

```bash
git add src/shared/review-context.ts test/review-context.test.ts
git commit -m "refactor(review-context): structured guideline discovery behind a string-returning wrapper"
```

---

### Task C2: Add the capped, relevance-ranked finder render

**Files:**
- Modify: `src/shared/review-context.ts` (add `MAX_FINDER_GUIDELINE_BYTES`, `formatFinderGuidelines`)
- Test: `test/review-context.test.ts`

- [ ] **Step 1: Write the failing tests**

Extend the import in `test/review-context.test.ts` to add `formatFinderGuidelines` and `MAX_FINDER_GUIDELINE_BYTES`, then add:

```typescript
describe('formatFinderGuidelines', () => {
  it('keeps scoped guidance and drops lower-relevance root docs past the cap', async () => {
    await withTempRepo(async (repo) => {
      // One large root doc and one small scoped doc; a tiny cap forces a choice.
      await writeFile(join(repo, 'AGENTS.md'), '# Root\n' + 'x'.repeat(4000));
      await mkdir(join(repo, 'apps', 'web'), { recursive: true });
      await writeFile(join(repo, 'apps', 'web', 'REVIEW.md'), '# Scoped review\nfindme-scoped');

      const discovered = await discoverGuidelineDocs(repo, ['apps/web/index.ts']);
      const finder = formatFinderGuidelines(discovered, { capBytes: 1024 });

      assert.ok(Buffer.byteLength(finder, 'utf8') <= 1024 + 256, 'within cap (+ notice slack)');
      assert.match(finder, /findme-scoped/, 'scoped doc kept');
      assert.doesNotMatch(finder, /x{4000}/, 'large root doc dropped');
      assert.match(finder, /omitted from this pass/, 'omission notice present');
    });
  });

  it('returns the same docs as the full render when everything fits', async () => {
    await withTempRepo(async (repo) => {
      await writeFile(join(repo, 'AGENTS.md'), '# Agents\nsmall');
      const discovered = await discoverGuidelineDocs(repo, []);
      const finder = formatFinderGuidelines(discovered, { capBytes: 96 * 1024 });
      assert.match(finder, /### AGENTS\.md\n# Agents/);
      assert.doesNotMatch(finder, /omitted from this pass/);
    });
  });

  it('always keeps the highest-relevance doc even when it alone exceeds the cap', async () => {
    await withTempRepo(async (repo) => {
      await mkdir(join(repo, 'apps', 'web'), { recursive: true });
      await writeFile(join(repo, 'apps', 'web', 'REVIEW.md'), '# Scoped\n' + 'findme '.repeat(500));
      const discovered = await discoverGuidelineDocs(repo, ['apps/web/index.ts']);
      const finder = formatFinderGuidelines(discovered, { capBytes: 256 });
      assert.match(finder, /findme/, 'top doc kept despite exceeding the cap');
    });
  });

  it('uses MAX_FINDER_GUIDELINE_BYTES by default and is smaller than the total cap', () => {
    assert.ok(MAX_FINDER_GUIDELINE_BYTES < 96 * 1024);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --import tsx --test test/review-context.test.ts`
Expected: FAIL — `formatFinderGuidelines` / `MAX_FINDER_GUIDELINE_BYTES` not exported.

- [ ] **Step 3: Implement the finder render**

In `src/shared/review-context.ts`, add near the other budget constants:

```typescript
/**
 * Finder-pass guideline budget. Bug-finder shards and recall lenses get this
 * relevance-ranked slice instead of the full set; the dedicated
 * guideline-compliance session still receives every loaded doc via
 * formatGuidelines. Smaller than MAX_GUIDELINE_TOTAL_BYTES on purpose: finders
 * spend attention on the diff, not on the full standards corpus.
 */
export const MAX_FINDER_GUIDELINE_BYTES = 24 * 1024;
```

Add the renderer:

```typescript
export function formatFinderGuidelines(
  discovered: DiscoveredGuidelines,
  options: { capBytes?: number } = {},
): string {
  const capBytes = options.capBytes ?? MAX_FINDER_GUIDELINE_BYTES;

  // Decide INCLUSION by relevance (scoped > governance > root), discovery order
  // as a stable tiebreak. The referenced-docs pointer list is intentionally
  // omitted here: it invites extra reads, which is the opposite of the finder
  // budget's purpose (the compliance pass owns full coverage).
  const ranked = discovered.docs
    .map((doc, index) => ({ doc, index }))
    .sort((a, b) => b.doc.relevance - a.doc.relevance || a.index - b.index);

  const keptIndices = new Set<number>();
  let usedBytes = 0;
  let omitted = 0;
  for (const { doc, index } of ranked) {
    const separatorBytes = keptIndices.size > 0 ? 2 : 0;
    const sectionBytes = Buffer.byteLength(`### ${doc.label}\n${doc.text}`, 'utf8') + separatorBytes;
    // Always keep the single highest-relevance doc, even if it alone exceeds
    // the cap: the per-file read bound (MAX_GUIDELINE_FILE_BYTES) equals this
    // budget, and the `### label` header tips a max-size doc over — without
    // this, finders could be left with zero guidance plus a notice, a recall
    // hole. This makes the cap intentionally SOFT for the first doc only — a
    // deliberate recall-protecting exception, unlike buildReviewPlaybookBlock's
    // hard cap. The small omission notice likewise rides on top of the cap.
    if (keptIndices.size === 0 || usedBytes + sectionBytes <= capBytes) {
      keptIndices.add(index);
      usedBytes += sectionBytes;
    } else {
      omitted += 1;
    }
  }

  // Render in discovery order for readability (ranking only chose inclusion).
  const sections = discovered.docs
    .filter((_, index) => keptIndices.has(index))
    .map((doc) => `### ${doc.label}\n${doc.text}`);

  if (omitted > 0) {
    sections.push(
      [
        '### Review guidance budget',
        `${omitted} lower-relevance guideline file(s) were omitted from this pass to stay within the ${capBytes} byte finder budget. The guideline-compliance pass audits the full set.`,
      ].join('\n'),
    );
  }

  return sections.join('\n\n');
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --import tsx --test test/review-context.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/review-context.ts test/review-context.test.ts
git commit -m "feat(review-context): relevance-ranked, capped finder guideline render"
```

---

### Task C3: Wire roles in the runner

**Files:**
- Modify: `src/shared/runner.ts` (import; `discoverGuidelines` call site ~line 270; `guidelinesForPrompt` usage)
- Test: `test/runner.test.ts` (only if a runner unit test references the changed wiring; otherwise the full suite is the guard)

> Design: the finder render goes to the main shards (`runShardedReview`) and the lens passes (`startLensPasses`); the FULL render goes to the guideline-compliance session (`startGuidelineComplianceCheck`). The `hasGuidelines` gate and the byte-count log stay on the full set.

- [ ] **Step 1: Update the import**

In `src/shared/runner.ts`, change the `review-context` import:

```typescript
import {
  buildReviewContext,
  discoverGuidelineDocs,
  formatGuidelines,
  formatFinderGuidelines,
  formatDiffScope,
} from './review-context.ts';
```

- [ ] **Step 2: Replace the discovery call and split the renders**

Replace (around `src/shared/runner.ts:270-271`):

```typescript
  const guidelines = await discoverGuidelines(workspace, changedFiles);
  if (guidelines) log(`Guidelines loaded (${guidelines.length} bytes).`);
```

with:

```typescript
  const discoveredGuidelines = await discoverGuidelineDocs(workspace, changedFiles);
  const guidelines = formatGuidelines(discoveredGuidelines);
  const finderGuidelines = formatFinderGuidelines(discoveredGuidelines);
  if (guidelines) {
    log(
      `Guidelines loaded (${guidelines.length} bytes; finder slice ${finderGuidelines.length} bytes).`,
    );
  }
```

- [ ] **Step 3: Point finder sessions at the finder slice, compliance at the full set**

The local `guidelinesForPrompt` currently feeds every session. Replace its definition (around `src/shared/runner.ts:316`):

```typescript
  let coreContext: string;
  const guidelinesForPrompt = guidelines;
```

with:

```typescript
  let coreContext: string;
  // Finder shards + recall lenses get the capped, relevance-ranked slice;
  // the guideline-compliance session (below) gets the full set — its job is
  // rule-by-rule auditing, so it must see every loaded doc.
  const guidelinesForPrompt = finderGuidelines;
```

Then change ONLY the guideline-compliance call to use the full set. In the `startGuidelineComplianceCheck({ ... })` call (around `src/shared/runner.ts:424-434`), set:

```typescript
    const guidelineComplianceCheck = startGuidelineComplianceCheck({
      client,
      model: auxModel,
      prContext: basePrContext,
      guidelinesForPrompt: guidelines,
      hasGuidelines: Boolean(guidelines),
      enabled: options.guidelinePass,
      timeoutMs: finderTimeoutMs,
      log,
      onTokenUsage: recordTokenUsage,
    });
```

(Leave `startLensPasses` and `runShardedReview` using `guidelinesForPrompt`, which is now the finder slice.)

- [ ] **Step 3b: Fix the now-stale comment in the enhanced-context branch**

The comment above the `buildReviewContext({ ..., guidelines: '' })` call (around `src/shared/runner.ts:329-331`) currently claims guidelines are injected "the full set, in every pass" — false after this change. Replace it:

```typescript
      // Guidelines are injected per pass via guidelinesForPrompt (the finder
      // slice for shards/lenses; the full set goes to the compliance pass),
      // kept out of the shared context so they land in the early prompt slot
      // (invariant #5) instead of being buried mid-context.
      guidelines: '',
```

- [ ] **Step 4: Full verification**

Run: `npm run typecheck && npm test`
Expected: PASS. (No runner test asserts guideline byte counts; if one does, update it to the new log wording.)

- [ ] **Step 5: Commit**

```bash
git add src/shared/runner.ts
git commit -m "feat(runner): give finders the capped guideline slice, compliance the full set"
```

---

### Task C4: Validate the dilution fix on the pr11 golden case

**Files:**
- None (validation only). Uses `fixtures/golden/jbot-app-pr11-recall`.

> This task proves the change recovers the two `mustFind` misses (pagination desync, SVG supply-chain) that context dilution caused, at the original `passes=2, shards=1` config — the headline metric from the evaluation.

- [ ] **Step 1: Run the golden benchmark for the pr11 case (3 runs, flash variance)**

Run (requires provider keys in `.env`):

```bash
npm run bench:golden -- --case jbot-app-pr11-recall --model opencode/deepseek-v4-flash-free
```

Expected: writes `fixtures/golden/jbot-app-pr11-recall/actual-findings.json`, then runs `npm run eval`.

- [ ] **Step 2: Confirm recall**

Run: `npm run eval`
Expected: the `jbot-app-pr11-recall` case reports its two `mustFind` findings (`logic` pagination desync; `security` SVG supply-chain) as matched, and the keyboard-nav recall anchor still matches. No regression in `noisePerCase` on the `exhaustive: true` clean cases.

- [ ] **Step 3: If recall is unchanged, tune the finder cap**

If the misses persist, raise/lower `MAX_FINDER_GUIDELINE_BYTES` and re-run; record the chosen value's eval delta in the PR description. (Do NOT commit `actual-findings.json` — it is gitignored on purpose.)

- [ ] **Step 4: Final sweep + commit any constant tuning**

```bash
git add src/shared/review-context.ts
git commit -m "chore(review-context): tune finder guideline budget against pr11 golden case"
```

(Skip the commit if no constant changed.)

---

## Self-Review (writing-plans checklist)

**1. Spec coverage:**
- Item 1 (path/regex mis-route + infra hole): Tasks A1–A4 (infra pattern, risk weight, playbook, selection, focus bullet) + the `fetch-logos.mjs` supply-chain trigger in A3. ✓
- Item 2 (leave alone): documented as out-of-scope. ✓
- Item 3 (per-role guideline budget, fix positional eviction): Tasks C1–C4. ✓
- Item 4 (DESIGN.md/ADRs, one-hop following kept): Task B1; deeper following explicitly out-of-scope. ✓
- Measurement (eval/replay): Task C4 + each task's test commands. ✓

**2. Placeholder scan:** No "TBD"/"add error handling"/"similar to Task N". Every code step shows complete code; every test step shows full assertions. ✓

**3. Type/name consistency:**
- `discoverGuidelineDocs` → `DiscoveredGuidelines` → `formatGuidelines`/`formatFinderGuidelines` used identically in tests (C1/C2) and runner (C3). ✓
- `GuidelineDoc.relevance` typed via `GUIDELINE_RELEVANCE`; set in C1, read in C2. ✓
- `MAX_FINDER_GUIDELINE_BYTES` defined in C2, used by default in C2 + runner C3. ✓
- `infra-ops` id consistent across `prompt.ts` (A2), `review-playbooks.ts` (A3), test assertions. ✓
- `PATH_PATTERNS.infra` defined in A1, reused (not re-declared) in `review-playbooks.ts` A3 and `runner.ts` A4. ✓
