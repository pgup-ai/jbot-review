# Kilo CLI Review Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the Kilo CLI (`@kilocode/cli`, binary `kilo`) as a pluggable read-only review backend, authenticated by the operator's local `kilo auth login` reused in CI via a `KILO_AUTH_CONTENT` secret, defaulting to the free `kilo/kilo-auto/free` gateway model.

**Architecture:** One new module `src/shared/kilo.ts` implementing the `ReviewBackend` seam (5 review fns + factory), plus mechanical wiring in `backend-selection.ts`/`config.ts`/`runner.ts`, infra (`Dockerfile`/`action.yml`/workflow), README, and the sibling `jbot-review-app` `PROVIDER_CATALOG`. Kilo is an opencode fork: prompt on **stdin** (POC: 150KB ok, no cap), `--format json` NDJSON output parsed by taking the last `type:"text"` event's `part.text`, read-only via `--agent plan` + `NO_TOOLS_REVIEW_DIRECTIVE`, credential env-injected with a per-process temp `HOME`/`XDG_DATA_HOME` for SQLite-DB isolation.

**Tech Stack:** TypeScript ESM (`.ts` specifiers, run via tsx), node:test + `node:assert/strict`, esbuild bundle, GitHub Actions (Docker action), `@kilocode/cli`.

**Reference implementations (read before starting):** `src/shared/cursor.ts` (stdin delivery, env-carried key, model listing), `src/shared/cline.ts` (`NO_TOOLS_REVIEW_DIRECTIVE`, env stripping, NDJSON parse), `src/shared/codex.ts` (JSON auth validation). `test/cline.test.ts` is the test template. Spec: `docs/superpowers/specs/2026-07-01-kilo-cli-review-backend-design.md`.

**Invariants to honor (AGENTS.md):** #3 aux sessions fail open; #8 read-only in layers (never emit `--auto`/`--dangerously-skip-permissions`); #10 pure logic is unit-tested.

---

## File Structure

| File                                              | Responsibility                                                                              | Action                |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------- |
| `src/shared/kilo.ts`                              | Kilo backend: provider id, arg builder, auth env, NDJSON/model parsers, 5 review fns, spawn | Create                |
| `test/kilo.test.ts`                               | Pure-unit tests for the above                                                               | Create                |
| `src/shared/backend-selection.ts`                 | Register `kilo` in the CLI-backend union + key routing                                      | Modify                |
| `test/backend-selection.test.ts`                  | Assert `kilo` routing                                                                       | Modify                |
| `src/shared/config.ts`                            | `PROVIDERS.kilo` + `modelSupportsPromptCache`                                               | Modify                |
| `src/shared/runner.ts`                            | Import, `createKiloBackend`, startup block, `cliBackends`, model-list log                   | Modify                |
| `action.yml`                                      | `kilo-auth` input + `INPUT_KILO-AUTH` env                                                   | Modify                |
| `.github/workflows/jbot-review.yml`               | `kilo-auth` secret passthrough                                                              | Modify                |
| `Dockerfile`                                      | Install `@kilocode/cli@latest` + `kilo --version`                                           | Modify                |
| `README.md`                                       | Credential-table + provider-table + env-list + auth paragraph rows                          | Modify                |
| `../jbot-review-app/packages/shared/src/index.ts` | `Provider` union + model list + `PROVIDER_CATALOG.kilo`                                     | Modify (sibling repo) |

---

## Task 1: `kilo.ts` — provider id, arg builder, prompt input

**Files:**

- Create: `src/shared/kilo.ts`
- Test: `test/kilo.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/kilo.test.ts`:

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildKiloCliArgs, buildKiloPromptInput, isKiloProvider } from '../src/shared/kilo.ts';

describe('Kilo CLI provider helpers', () => {
  it('matches only the kilo provider id', () => {
    assert.equal(isKiloProvider('kilo'), true);
    assert.equal(isKiloProvider('Kilo'), false);
    assert.equal(isKiloProvider(' kilo '), false);
    assert.equal(isKiloProvider('kilocode'), false);
  });

  it('maps default to the free gateway model, gateway-prefixed', () => {
    assert.deepEqual(buildKiloCliArgs({ model: 'kilo/default' }), [
      'run',
      '--format',
      'json',
      '--agent',
      'plan',
      '--model',
      'kilo/kilo-auto/free',
    ]);
  });

  it('preserves the kilo/ gateway prefix for explicit models', () => {
    // parseModelName strips the leading `kilo/`; buildKiloCliArgs must re-add it,
    // else the bare id 404s ("Model not found") — POC-observed.
    assert.deepEqual(buildKiloCliArgs({ model: 'kilo/kilo-auto/free' }).slice(-2), [
      '--model',
      'kilo/kilo-auto/free',
    ]);
    assert.deepEqual(buildKiloCliArgs({ model: 'kilo/anthropic/claude-opus-4.8' }).slice(-2), [
      '--model',
      'kilo/anthropic/claude-opus-4.8',
    ]);
  });

  it('never emits bypass flags (invariant #8)', () => {
    for (const model of ['kilo/default', 'kilo/kilo-auto/free']) {
      const args = buildKiloCliArgs({ model });
      assert.equal(args.includes('--auto'), false);
      assert.equal(args.includes('--dangerously-skip-permissions'), false);
      const agentIdx = args.indexOf('--agent');
      assert.equal(args[agentIdx + 1], 'plan');
    }
  });

  it('prepends the no-tools directive to the prompt input (avoids read-only stall)', () => {
    const input = buildKiloPromptInput('REVIEW BODY');
    assert.match(input, /Use no tools for this review/);
    assert.ok(input.endsWith('\n\nREVIEW BODY'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/kilo.test.ts`
Expected: FAIL — `Cannot find module '../src/shared/kilo.ts'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/shared/kilo.ts`:

```ts
import { parseModelName } from './model.ts';
import { NO_TOOLS_REVIEW_DIRECTIVE } from './prompt.ts';

export const KILO_PROVIDER_ID = 'kilo';
export const KILO_CLI_BIN = 'kilo';
/** Kilo's hardcoded free smart-router; the CI default. Gateway-prefixed (see buildKiloCliArgs). */
export const KILO_GATEWAY_FREE_MODEL = 'kilo-auto/free';

export function isKiloProvider(providerID: string): boolean {
  return providerID === KILO_PROVIDER_ID;
}

/**
 * Static `kilo run` argv. Read-only is enforced here (invariant #8): `--agent plan`
 * denies edit/write/terminal headless (POC: a write tool is auto-denied, no hang), and
 * the bypass flags (`--auto`, `--dangerously-skip-permissions`) are never emitted.
 * `--format json` yields the NDJSON we parse. The prompt goes on stdin (runKiloPrompt).
 *
 * Model mapping: jbot's provider id (`kilo`) is also Kilo's gateway provider id, so
 * parseModelName strips the leading `kilo/`; we re-add it so `--model` stays
 * gateway-qualified (`kilo/kilo-auto/free`) — the bare form 404s (POC). `default` maps
 * to the free smart-router.
 */
export function buildKiloCliArgs(input: { model: string }): string[] {
  const { modelID } = parseModelName(input.model);
  const model = modelID === 'default' ? KILO_GATEWAY_FREE_MODEL : modelID;
  return ['run', '--format', 'json', '--agent', 'plan', '--model', `${KILO_PROVIDER_ID}/${model}`];
}

/** Prompt input: the no-tools directive (a denied tool under `--agent plan` yields empty
 * text — POC) prepended so the model reviews the embedded context instead of stalling. */
export function buildKiloPromptInput(prompt: string): string {
  return `${NO_TOOLS_REVIEW_DIRECTIVE}\n\n${prompt}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/kilo.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/shared/kilo.ts test/kilo.test.ts
git commit -m "feat(kilo): provider id, read-only arg builder, prompt input"
```

---

## Task 2: `kilo.ts` — credential validation + env injection

**Files:**

- Modify: `src/shared/kilo.ts`
- Test: `test/kilo.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `test/kilo.test.ts` imports: `assertValidKiloAuth, kiloEnvForAuth, KILO_STRIPPED_ENV_KEYS`. Add a new describe block:

```ts
describe('Kilo CLI auth env', () => {
  it('accepts valid JSON and returns trimmed content', () => {
    assert.equal(
      assertValidKiloAuth('  {"kilo":{"type":"api","key":"k"}}  '),
      '{"kilo":{"type":"api","key":"k"}}',
    );
  });

  it('rejects a blank or non-JSON Kilo secret', () => {
    assert.throws(() => assertValidKiloAuth('   '), /Missing Kilo auth/);
    assert.throws(() => assertValidKiloAuth('not json'), /Invalid KILO_AUTH_CONTENT/);
  });

  it('injects KILO_AUTH_CONTENT + isolated HOME/XDG and strips ambient keys', () => {
    const previous = new Map(KILO_STRIPPED_ENV_KEYS.map((k) => [k, process.env[k]] as const));
    try {
      for (const key of KILO_STRIPPED_ENV_KEYS) process.env[key] = `ambient-${key}`;
      const env = kiloEnvForAuth('{"kilo":{"type":"api","key":"k"}}', '/tmp/jbot-kilo-test');
      assert.equal(env.KILO_AUTH_CONTENT, '{"kilo":{"type":"api","key":"k"}}');
      assert.equal(env.HOME, '/tmp/jbot-kilo-test');
      assert.equal(env.XDG_DATA_HOME, '/tmp/jbot-kilo-test/.local/share');
      for (const key of KILO_STRIPPED_ENV_KEYS) {
        assert.equal(env[key], undefined, `${key} must be stripped from the child env`);
        assert.equal(process.env[key], `ambient-${key}`, `${key} ambient env must be intact`);
      }
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('rejects a blank Kilo home', () => {
    assert.throws(() => kiloEnvForAuth('{"kilo":{}}', '   '), /Missing Kilo home/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/kilo.test.ts`
Expected: FAIL — `assertValidKiloAuth is not exported` / undefined.

- [ ] **Step 3: Write minimal implementation**

Add to `src/shared/kilo.ts` — first extend the top import:

```ts
import { join } from 'node:path';
```

Then append:

```ts
// Provider api-key envs Kilo could read above the injected KILO_AUTH_CONTENT; stripped so
// an ambient key can't silently redirect provider/billing (Kilo is multi-provider).
export const KILO_STRIPPED_ENV_KEYS = [
  'KILO_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENROUTER_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'DEEPSEEK_API_KEY',
  'XAI_API_KEY',
  'GROQ_API_KEY',
  'CEREBRAS_API_KEY',
] as const;

/**
 * Validates the `KILO_AUTH_CONTENT` secret — the contents of
 * `~/.local/share/kilo/auth.json` — is present and JSON, returning the trimmed content.
 * Throws a clear error so a bad secret fails fast at startup.
 */
export function assertValidKiloAuth(auth: string): string {
  const content = auth.trim();
  if (!content) {
    throw new Error('Missing Kilo auth. Set kilo-auth or KILO_AUTH_CONTENT.');
  }
  try {
    JSON.parse(content);
  } catch {
    throw new Error(
      'Invalid KILO_AUTH_CONTENT: expected the JSON contents of ~/.local/share/kilo/auth.json.',
    );
  }
  return content;
}

/**
 * Child env carrying the Kilo credential via `KILO_AUTH_CONTENT` (env-injected, no file
 * written). `HOME`/`XDG_DATA_HOME` point at a per-process temp dir so concurrent
 * sessions don't race kilo's SQLite data dir (every invocation opens/migrates
 * ~/.local/share/kilo/kilo.db) or any token-refresh writeback. Ambient provider api-key
 * envs are stripped so the carried auth wins.
 */
export function kiloEnvForAuth(auth: string, home: string): NodeJS.ProcessEnv {
  const content = assertValidKiloAuth(auth);
  const h = home?.trim();
  if (!h) {
    throw new Error('Missing Kilo home. A temp HOME is required for the kilo data dir.');
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    KILO_AUTH_CONTENT: content,
    HOME: h,
    XDG_DATA_HOME: join(h, '.local/share'),
  };
  for (const key of KILO_STRIPPED_ENV_KEYS) delete env[key];
  return env;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/kilo.test.ts`
Expected: PASS (all Task 1 + Task 2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/shared/kilo.ts test/kilo.test.ts
git commit -m "feat(kilo): KILO_AUTH_CONTENT env injection with isolated HOME/XDG"
```

---

## Task 3: `kilo.ts` — NDJSON + model-list parsers

**Files:**

- Modify: `src/shared/kilo.ts`
- Test: `test/kilo.test.ts`

- [ ] **Step 1: Write the failing test**

Add imports `parseKiloFinalMessage, parseKiloModelList, formatKiloPromptTimeoutMessage`. Add:

```ts
describe('Kilo CLI output parsing', () => {
  it('returns the LAST type:text event part.text (cumulative — never concat)', () => {
    const ndjson = [
      '{"type":"step_start"}',
      'INFO 2026-07-01 service=db opening database',
      '{"type":"text","part":{"type":"text","text":"PONG"}}',
      '{"type":"text","part":{"type":"text","text":"PONG"}}',
      '{"type":"step_finish"}',
    ].join('\n');
    // Two identical cumulative snapshots must yield "PONG", not "PONGPONG".
    assert.equal(parseKiloFinalMessage(ndjson), 'PONG');
  });

  it('returns the full text from a single cumulative event', () => {
    const ndjson = '{"type":"text","part":{"type":"text","text":"ALPHA\\nBRAVO"}}';
    assert.equal(parseKiloFinalMessage(ndjson), 'ALPHA\nBRAVO');
  });

  it('returns empty when no text event is present', () => {
    assert.equal(parseKiloFinalMessage('{"type":"error","error":{"data":{"message":"boom"}}}'), '');
    assert.equal(parseKiloFinalMessage('garbage\nlines'), '');
    assert.equal(parseKiloFinalMessage('{"type":"text","part":{"text":""}}'), '');
  });

  it('extracts provider/model lines and skips log/header lines', () => {
    const out = [
      'kilo/kilo-auto/free',
      'kilo/anthropic/claude-opus-4.8',
      'kilo/stepfun/step-3.7-flash:free',
      '',
      'INFO 2026-07-01 service=db opening database',
      'Available models:',
    ].join('\n');
    assert.deepEqual(parseKiloModelList(out), [
      'kilo/kilo-auto/free',
      'kilo/anthropic/claude-opus-4.8',
      'kilo/stepfun/step-3.7-flash:free',
    ]);
  });

  it('labels prompt timeouts with the session and model', () => {
    assert.equal(
      formatKiloPromptTimeoutMessage('finding-verification', 'kilo/kilo-auto/free', 1200_000),
      'kilo finding-verification prompt timed out after 1200s (model=kilo/kilo-auto/free)',
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/kilo.test.ts`
Expected: FAIL — parsers not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/shared/kilo.ts`:

```ts
/**
 * The clean final message is the LAST `type:"text"` event's `part.text` (NDJSON stdout).
 * POC: text lives at part.text and events are cumulative snapshots, so take-last
 * (concatenating would double-count). Non-JSON log lines are skipped.
 */
export function parseKiloFinalMessage(stdout: string): string {
  let text = '';
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (event && typeof event === 'object' && (event as { type?: unknown }).type === 'text') {
      const part = (event as { part?: { text?: unknown } }).part;
      if (part && typeof part.text === 'string') text = part.text;
    }
  }
  return text;
}

/**
 * Parses `kilo models` output. Each model line is a bare `provider/model-id` token; the
 * CLI's INFO log lines (which contain spaces) and headers/blanks are skipped. Pure.
 */
export function parseKiloModelList(output: string): string[] {
  const models: string[] = [];
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (/^[A-Za-z0-9~][^\s]*\/[^\s]+$/.test(trimmed)) models.push(trimmed);
  }
  return models;
}

export function formatKiloPromptTimeoutMessage(
  label: string,
  model: string,
  timeoutMs: number,
): string {
  return `kilo ${label} prompt timed out after ${Math.round(timeoutMs / 1000)}s (model=${model})`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/kilo.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/kilo.ts test/kilo.test.ts
git commit -m "feat(kilo): NDJSON final-message + model-list parsers"
```

---

## Task 4: `kilo.ts` — spawn, 5 review entrypoints, model listing

No new unit tests (the spawn path hits the CLI; matches how `cursor.ts`/`cline.ts` leave `run*Prompt` untested). Verified by `typecheck` + the Task 11 e2e.

**Files:**

- Modify: `src/shared/kilo.ts`

- [ ] **Step 1: Extend imports**

Replace the top of `src/shared/kilo.ts` (the two existing import lines) with:

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseModelName } from './model.ts';
import {
  assembleAddressedPriorCommentsPrompt,
  assembleChangesSinceLastReviewPrompt,
  assembleFindingVerificationPrompt,
  assembleGuidelineCompliancePrompt,
  assembleReviewPrompt,
  buildJsonRepairFollowupPrompt,
  NO_TOOLS_REVIEW_DIRECTIVE,
  type VerifiableFinding,
} from './prompt.ts';
import {
  parseChangesSinceLastReviewSummary,
  parseFindingVerdicts,
  parseReview,
  type TokenUsageRecorder,
} from './opencode.ts';
import { spawnWithTimeout } from './cli-process.ts';
import { truncateForLog } from './text.ts';
import type { AddressedPriorComment, Finding, FindingVerdict, ReviewResult } from './types.ts';
```

Then add the timeout/budget constants directly below the imports (before `KILO_PROVIDER_ID`):

```ts
const KILO_PROMPT_TIMEOUT_MS = 20 * 60_000;
const KILO_MODEL_LIST_TIMEOUT_MS = 60_000;
const KILO_REPAIR_PROMPT_BUDGET_BYTES = 80_000;
const KILO_REPAIR_RESPONSE_BUDGET_BYTES = 20_000;
```

- [ ] **Step 2: Append the review entrypoints + spawn + listing**

Append to `src/shared/kilo.ts`:

```ts
export async function runKiloReview(
  workspace: string,
  model: string,
  prContext: string,
  guidelines: string,
  log: (msg: string) => void,
  options: {
    lensAddendum?: string;
    label?: string;
    timeoutMs?: number;
    onTokenUsage?: TokenUsageRecorder;
    auth?: string;
  } = {},
): Promise<ReviewResult> {
  void options.onTokenUsage; // kilo --format json usage not wired; mirror the other CLI backends.
  const label = options.label ?? 'review';
  const prompt = assembleReviewPrompt(prContext, guidelines, options.lensAddendum ?? '');
  log(`Prompt assembled (${label}, kilo): ${prompt.length} chars, guidelines=${!!guidelines}`);
  const raw = await runKiloPrompt(
    workspace,
    model,
    prompt,
    label,
    log,
    options.auth,
    options.timeoutMs,
  );
  try {
    return parseReview(raw, label, log, { strict: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`${label} response unparseable; sending one JSON repair prompt via kilo: ${message}`);
    const repaired = await runKiloPrompt(
      workspace,
      model,
      buildJsonRepairFollowupPrompt({
        originalPrompt: prompt,
        invalidResponse: raw,
        parseError: message,
        promptBudgetBytes: KILO_REPAIR_PROMPT_BUDGET_BYTES,
        responseBudgetBytes: KILO_REPAIR_RESPONSE_BUDGET_BYTES,
      }),
      `${label}-repair`,
      log,
      options.auth,
      options.timeoutMs,
    );
    return parseReview(repaired, `${label}-repair`, log, { strict: true });
  }
}

export async function runKiloAddressedPriorCommentsCheck(
  workspace: string,
  model: string,
  prContext: string,
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
  auth?: string,
): Promise<AddressedPriorComment[]> {
  void onTokenUsage;
  const raw = await runKiloPrompt(
    workspace,
    model,
    assembleAddressedPriorCommentsPrompt(prContext),
    'addressed-prior-comments',
    log,
    auth,
    timeoutMs,
  );
  return parseReview(raw, 'addressed-prior-comments', log).addressedPriorComments;
}

export async function runKiloGuidelineComplianceCheck(
  workspace: string,
  model: string,
  prContext: string,
  guidelines: string,
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
  auth?: string,
): Promise<Finding[]> {
  void onTokenUsage;
  const raw = await runKiloPrompt(
    workspace,
    model,
    assembleGuidelineCompliancePrompt(prContext, guidelines),
    'guideline-compliance',
    log,
    auth,
    timeoutMs,
  );
  return parseReview(raw, 'guideline-compliance', log).findings;
}

export async function runKiloChangesSinceLastReview(
  workspace: string,
  model: string,
  prContext: string,
  deltaContext: string,
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
  auth?: string,
): Promise<string> {
  void onTokenUsage;
  const raw = await runKiloPrompt(
    workspace,
    model,
    assembleChangesSinceLastReviewPrompt(prContext, deltaContext),
    'changes-since-last-review',
    log,
    auth,
    timeoutMs,
  );
  return parseChangesSinceLastReviewSummary(raw, 'changes-since-last-review', log);
}

export async function runKiloFindingVerification(
  workspace: string,
  model: string,
  prContext: string,
  findings: VerifiableFinding[],
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
  auth?: string,
): Promise<FindingVerdict[] | undefined> {
  void onTokenUsage;
  const raw = await runKiloPrompt(
    workspace,
    model,
    assembleFindingVerificationPrompt(prContext, findings),
    'finding-verification',
    log,
    auth,
    timeoutMs,
  );
  return parseFindingVerdicts(raw, findings.length, log);
}

/**
 * Lists the models the auth can use via `kilo models`, for the startup observability log
 * (mirrors listCursorModels). Best-effort: the runner logs and continues on failure.
 */
export async function listKiloModels(workspace: string, auth: string): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), 'jbot-kilo-'));
  try {
    const result = await spawnWithTimeout(KILO_CLI_BIN, ['models'], {
      cwd: workspace,
      env: kiloEnvForAuth(auth, dir),
      timeoutMs: KILO_MODEL_LIST_TIMEOUT_MS,
      timeoutMessage: `kilo model listing timed out after ${Math.round(
        KILO_MODEL_LIST_TIMEOUT_MS / 1000,
      )}s`,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `kilo model listing exited ${result.exitCode}: ${truncateForLog(
          result.stderr || result.stdout,
          1000,
        )}`,
      );
    }
    return parseKiloModelList(result.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function runKiloPrompt(
  workspace: string,
  model: string,
  prompt: string,
  label: string,
  log: (msg: string) => void,
  auth: string | undefined,
  timeoutMs = KILO_PROMPT_TIMEOUT_MS,
): Promise<string> {
  const args = buildKiloCliArgs({ model });
  const input = buildKiloPromptInput(prompt);
  log(`Calling ${label} prompt (agent=kilo-cli, model=${model})`);
  // Per-process HOME/XDG so concurrent sessions don't race kilo's SQLite data dir or any
  // token-refresh writeback; the prompt goes on stdin (no argv size limit).
  const dir = mkdtempSync(join(tmpdir(), 'jbot-kilo-'));
  try {
    const result = await spawnWithTimeout(KILO_CLI_BIN, args, {
      cwd: workspace,
      input,
      env: kiloEnvForAuth(auth ?? '', dir),
      timeoutMs,
      timeoutMessage: formatKiloPromptTimeoutMessage(label, model, timeoutMs),
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `kilo ${label} exited ${result.exitCode}: ${truncateForLog(
          result.stderr || result.stdout,
          1000,
        )}`,
      );
    }
    const finalMessage = parseKiloFinalMessage(result.stdout).trim();
    log(
      `${label} prompt complete via kilo: stdout=${result.stdout.length} chars last-message=${finalMessage.length} chars`,
    );
    if (!finalMessage) {
      throw new Error(
        `kilo ${label} produced no text event; stdout: ${truncateForLog(result.stdout, 1000)}`,
      );
    }
    return finalMessage;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
```

**Note:** remove the now-duplicate `join` import and the standalone `parseModelName`/`NO_TOOLS_REVIEW_DIRECTIVE` imports added in Tasks 1–2 (the Step-1 block above supersedes them). There must be exactly one import of each.

- [ ] **Step 3: Typecheck + full unit run**

Run: `npm run typecheck && node --import tsx --test test/kilo.test.ts`
Expected: typecheck clean; kilo tests PASS.

- [ ] **Step 4: Commit**

```bash
git add src/shared/kilo.ts
git commit -m "feat(kilo): stdin spawn, 5 review entrypoints, model listing"
```

---

## Task 5: `config.ts` — provider entry + prompt-cache

**Files:**

- Modify: `src/shared/config.ts`

- [ ] **Step 1: Write the failing test**

Add to `test/kilo.test.ts` (new imports from config):

```ts
import { PROVIDERS, modelSupportsPromptCache } from '../src/shared/config.ts';

describe('Kilo config registration', () => {
  it('registers the kilo provider with the free-gateway default', () => {
    assert.equal(PROVIDERS.kilo?.defaultModel, 'kilo/kilo-auto/free');
    assert.equal(PROVIDERS.kilo?.keyEnv, 'KILO_AUTH_CONTENT');
    assert.equal(PROVIDERS.kilo?.keyInput, 'kilo-auth');
  });

  it('disables prompt cache for kilo (not opencode-driven)', () => {
    assert.equal(modelSupportsPromptCache('kilo', 'kilo-auto/free'), false);
    assert.equal(modelSupportsPromptCache('kilo', 'default'), false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/kilo.test.ts`
Expected: FAIL — `PROVIDERS.kilo` undefined.

- [ ] **Step 3: Implement — add the provider entry**

In `src/shared/config.ts`, add to the `PROVIDERS` object (after the `cline-pass` entry, before the closing `}`):

```ts
  // Kilo CLI (opencode fork). Auth via KILO_AUTH_CONTENT; default is the free gateway
  // smart-router. JBOT_REVIEW_MODEL: `kilo/kilo-auto/free` or `kilo/<vendor>/<model>`.
  kilo: {
    defaultModel: 'kilo/kilo-auto/free',
    keyEnv: 'KILO_AUTH_CONTENT',
    keyInput: 'kilo-auth',
    models: {
      // Kilo CLI is not driven through opencode, so prompt-cache options do not apply.
      default: { promptCache: false },
    },
  },
```

- [ ] **Step 4: Implement — disable prompt cache**

In `src/shared/config.ts`, in `modelSupportsPromptCache`, add `providerID === 'kilo'` to the CLI-backend early-return condition:

```ts
if (
  providerID === 'devin' ||
  providerID === 'commandcode' ||
  providerID === 'cursor' ||
  providerID === 'codex' ||
  providerID === 'cline' ||
  providerID === 'cline-pass' ||
  providerID === 'kilo'
)
  return false;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --import tsx --test test/kilo.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/shared/config.ts test/kilo.test.ts
git commit -m "feat(kilo): config provider entry + prompt-cache disable"
```

---

## Task 6: `backend-selection.ts` — register kilo routing

**Files:**

- Modify: `src/shared/backend-selection.ts`
- Test: `test/backend-selection.test.ts`

- [ ] **Step 1: Write the failing test**

Read `test/backend-selection.test.ts` first to match its `selectReviewBackends` call shape. Add a test asserting `provider=kilo` routes the key to `kiloAuth`, selects the `kilo` main CLI backend, and (with an opencode aux) sets `needsOpencode`:

```ts
it('routes kilo as a main CLI backend and carries kiloAuth', () => {
  const sel = selectReviewBackends({
    providerID: 'kilo',
    modelID: 'kilo-auto/free',
    apiKey: 'AUTH_JSON',
    auxProviderID: 'kilo',
    auxModelID: 'kilo-auto/free',
    auxApiKey: '',
  });
  assert.equal(sel.mainCliBackend, 'kilo');
  assert.equal(sel.kiloAuth, 'AUTH_JSON');
  assert.equal(sel.needsOpencode, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/backend-selection.test.ts`
Expected: FAIL — `sel.kiloAuth` undefined / `mainCliBackend` not `'kilo'`.

- [ ] **Step 3: Implement**

In `src/shared/backend-selection.ts`:

(a) Add the import:

```ts
import { KILO_PROVIDER_ID, isKiloProvider } from './kilo.ts';
```

(b) Extend the `CliBackendID` union:

```ts
  | typeof CLINE_PROVIDER_ID
  | typeof KILO_PROVIDER_ID;
```

(c) Add to the `ReviewBackendSelection` interface:

```ts
kiloAuth: string;
```

(d) In `selectReviewBackends`'s returned object, next to `clineAuth`:

```ts
    kiloAuth: keyFor(KILO_PROVIDER_ID),
```

(e) In `cliBackendForProvider`, before `return undefined;`:

```ts
if (isKiloProvider(providerID)) return KILO_PROVIDER_ID;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import tsx --test test/backend-selection.test.ts test/kilo.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/backend-selection.ts test/backend-selection.test.ts
git commit -m "feat(kilo): register kilo in backend selection + key routing"
```

---

## Task 7: `runner.ts` — factory, startup wiring, model log

No unit test (integration wiring; verified by `typecheck` + Task 11). Read `runner.ts` around the Cursor/Codex backends first (`createCursorBackend`, the `if (mainCliBackend === CURSOR_PROVIDER_ID …)` startup block, the `cliBackends` record, and the `if (commandCodeBackend) { … listCommandCodeModels … }` log block).

**Files:**

- Modify: `src/shared/runner.ts`

- [ ] **Step 1: Add imports**

Add a Kilo import group alongside the other backend imports near the top:

```ts
import {
  KILO_PROVIDER_ID,
  assertValidKiloAuth,
  createKiloBackendFns,
  listKiloModels,
  runKiloAddressedPriorCommentsCheck,
  runKiloChangesSinceLastReview,
  runKiloFindingVerification,
  runKiloGuidelineComplianceCheck,
  runKiloReview,
} from './kilo.ts';
```

(Import only the symbols used; `createKiloBackendFns` is a placeholder — the factory is defined locally in Step 2, so do NOT import it. Final import list: `KILO_PROVIDER_ID, assertValidKiloAuth, listKiloModels, runKilo*` ×5.)

- [ ] **Step 2: Add the factory**

After `createCursorBackend` (or `createClineBackend`), add:

```ts
function createKiloBackend(workspace: string, auth: string): ReviewBackend {
  return {
    name: KILO_PROVIDER_ID,
    runReview: (model, prContext, guidelines, log, options) =>
      runKiloReview(workspace, model, prContext, guidelines, log, { ...options, auth }),
    runAddressedPriorCommentsCheck: (model, prContext, log, timeoutMs, onTokenUsage) =>
      runKiloAddressedPriorCommentsCheck(
        workspace,
        model,
        prContext,
        log,
        timeoutMs,
        onTokenUsage,
        auth,
      ),
    runGuidelineComplianceCheck: (model, prContext, guidelines, log, timeoutMs, onTokenUsage) =>
      runKiloGuidelineComplianceCheck(
        workspace,
        model,
        prContext,
        guidelines,
        log,
        timeoutMs,
        onTokenUsage,
        auth,
      ),
    runFindingVerification: (model, prContext, findings, log, timeoutMs, onTokenUsage) =>
      runKiloFindingVerification(
        workspace,
        model,
        prContext,
        findings,
        log,
        timeoutMs,
        onTokenUsage,
        auth,
      ),
    runChangesSinceLastReview: (model, prContext, deltaContext, log, timeoutMs, onTokenUsage) =>
      runKiloChangesSinceLastReview(
        workspace,
        model,
        prContext,
        deltaContext,
        log,
        timeoutMs,
        onTokenUsage,
        auth,
      ),
  };
}
```

- [ ] **Step 3: Declare the backend var**

Next to `let clineBackend: ReviewBackend | undefined;` add:

```ts
let kiloBackend: ReviewBackend | undefined;
```

- [ ] **Step 4: Add the startup materialization block**

After the Cline `if (mainCliBackend === CLINE_PROVIDER_ID …)` block, add:

```ts
if (mainCliBackend === KILO_PROVIDER_ID || auxCliBackend === KILO_PROVIDER_ID) {
  const kiloAuth = backendSelection.kiloAuth;
  if (!kiloAuth) {
    cleanupCliHomes();
    throw new Error(`Missing auth for ${KILO_PROVIDER_ID} provider.`);
  }
  try {
    assertValidKiloAuth(kiloAuth); // fail fast on a malformed secret
  } catch (error) {
    cleanupCliHomes();
    throw error;
  }
  // No credential file/home to allocate: KILO_AUTH_CONTENT is env-injected and each
  // session self-manages a temp HOME/XDG for kilo's SQLite data dir.
  log('Kilo CLI auth configured via KILO_AUTH_CONTENT (env-injected; per-session temp HOME).');
  log('Kilo CLI token usage is unavailable; review metadata may omit those sessions.');
  kiloBackend = limitBackendConcurrency(createKiloBackend(workspace, kiloAuth), sessionSlots);
}
```

- [ ] **Step 5: Register in the `cliBackends` record**

Add the entry:

```ts
    [CLINE_PROVIDER_ID]: clineBackend,
    [KILO_PROVIDER_ID]: kiloBackend,
  };
```

- [ ] **Step 6: Add the model-list observability log**

Beside the `if (commandCodeBackend) { … listCommandCodeModels … }` block, add:

```ts
if (kiloBackend) {
  try {
    const models = await listKiloModels(workspace, backendSelection.kiloAuth);
    log(
      models.length > 0
        ? `Kilo models available (${models.length}): ${models.slice(0, 40).join(', ')}${models.length > 40 ? ', …' : ''}`
        : 'Kilo model listing returned no models.',
    );
  } catch (error) {
    log(
      `Kilo model listing failed (continuing): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
```

- [ ] **Step 7: Typecheck + full test suite**

Run: `npm run typecheck && npm test`
Expected: clean; all tests PASS.

- [ ] **Step 8: Commit**

```bash
git add src/shared/runner.ts
git commit -m "feat(kilo): wire kilo backend into the runner"
```

---

## Task 8: Infra — Dockerfile, action.yml, workflow

**Files:**

- Modify: `Dockerfile`, `action.yml`, `.github/workflows/jbot-review.yml`

- [ ] **Step 1: Install the CLI in the image**

In `Dockerfile` line ~15, add `@kilocode/cli@latest` to the `npm install -g` list and a verify. The line becomes:

```dockerfile
RUN npm install -g opencode-ai@latest command-code@latest @openai/codex@latest cline@latest @kilocode/cli@latest \
```

and add to the `&& …--version` verify chain:

```dockerfile
  && cline --version \
  && kilo --version
```

- [ ] **Step 2: Add the action input**

In `action.yml`, after the `cline-auth` input block, add:

```yaml
kilo-auth:
  description: 'Kilo CLI auth: the contents of ~/.local/share/kilo/auth.json. Used when provider or active aux-provider is kilo.'
  required: false
  default: ''
```

and in the `env:` block, after `INPUT_CLINE-AUTH`:

```yaml
INPUT_KILO-AUTH: ${{ inputs.kilo-auth }}
```

- [ ] **Step 3: Pass the secret through the workflow**

In `.github/workflows/jbot-review.yml`, in the action's `with:` block after `cline-auth`:

```yaml
kilo-auth: ${{ secrets.KILO_AUTH_CONTENT }}
```

- [ ] **Step 4: Build the bundle (verifies Docker COPY input compiles)**

Run: `npm run build`
Expected: esbuild bundles `dist/` with no errors.

- [ ] **Step 5: Commit**

```bash
git add Dockerfile action.yml .github/workflows/jbot-review.yml
git commit -m "feat(kilo): install CLI in image, add action input + workflow secret"
```

---

## Task 9: README — credential + provider tables

**Files:**

- Modify: `README.md`

- [ ] **Step 1: Read the surrounding rows**

Read `README.md` around the credential table (lines ~134–151), the provider table (~343–348), the env-var list (~125–127), and the workflow `with:` example (~110–114, ~237–239).

- [ ] **Step 2: Add the credential-table row**

After the `**Command Code**` row:

```markdown
| **Kilo** | `kilo auth login` → paste the whole `~/.local/share/kilo/auth.json` | `KILO_AUTH_CONTENT` (`kilo-auth`) |
```

- [ ] **Step 3: Add the provider-table row**

After the `cline-pass` row:

```markdown
| `kilo` | `kilo/kilo-auto/free` | `kilo-auth` | `KILO_AUTH_CONTENT` |
```

- [ ] **Step 4: Extend the env-var list and workflow examples**

Add `KILO_AUTH_CONTENT` to the env-var prose list (~125–127), and `kilo-auth: ${{ secrets.KILO_AUTH_CONTENT }}` to both `with:` example blocks. In the "how auth is materialized" paragraph, add a sentence:

```markdown
Kilo reads its credential from the `KILO_AUTH_CONTENT` env var (no file written) with an
isolated temporary `HOME`/`XDG_DATA_HOME` per session, removed after the run; it defaults
to the free `kilo/kilo-auto/free` gateway model.
```

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs(readme): Kilo CLI backend credential + provider rows"
```

---

## Task 10: App catalog — `jbot-review-app`

**Files:**

- Modify: `../jbot-review-app/packages/shared/src/index.ts`

- [ ] **Step 1: Verify the Kilo credential-source URL (don't guess)**

Run: `npx --yes ctx7@latest library "Kilo Code" "where do I get a Kilo API key or log in to the CLI"` (or WebFetch `https://kilo.ai`). Capture the real dashboard/login URL for `keysUrl`. If unresolved, use `https://kilo.ai` and leave a `// TODO verify` — do not invent a deep link.

- [ ] **Step 2: Read the sibling catalog shape**

Read `../jbot-review-app/packages/shared/src/index.ts`: the `Provider` union (~line 31–33/72–74), the `MODELS`/model-list object (~336–348), and the `PROVIDER_CATALOG` entries for `codex` (whole-file `credentialFile.extract`) and `cline`.

- [ ] **Step 3: Add `kilo` to the `Provider` union and model list**

Add `'kilo'` to the `Provider` union (both occurrences if duplicated) and a model list:

```ts
  kilo: [
    { modelId: 'kilo-auto/free', displayName: 'Kilo Auto (Free)' },
    { modelId: 'kilo-auto/small', displayName: 'Kilo Auto (Small)' },
    { modelId: 'kilo-auto/balanced', displayName: 'Kilo Auto (Balanced)' },
    { modelId: 'kilo-auto/frontier', displayName: 'Kilo Auto (Frontier)' },
  ],
```

- [ ] **Step 4: Add the `PROVIDER_CATALOG.kilo` entry**

Model it on the `codex` entry (whole-file JSON credential). Use the verified `keysUrl` from Step 1:

```ts
  kilo: {
    id: 'kilo',
    label: 'Kilo',
    keysUrl: '<VERIFIED_URL_FROM_STEP_1>',
    credentialLabel: 'auth.json',
    credentialHelp: 'Run `kilo auth login`, then paste the whole ~/.local/share/kilo/auth.json.',
    keyPattern: /"type"\s*:\s*"(oauth|api|wellknown)"/,
    keyPlaceholder: '{"kilo":{"type":"oauth",…}}',
    credentialFormat: 'json',
    credentialFile: {
      accept: '.json,application/json',
      hint: 'Upload ~/.local/share/kilo/auth.json',
      extract: (fileText: string) => {
        try {
          JSON.parse(fileText);
          return fileText.trim();
        } catch {
          return '';
        }
      },
    },
  },
```

- [ ] **Step 5: Typecheck the app**

Run: `cd ../jbot-review-app && pnpm -w typecheck` (or the app's typecheck script; check `package.json`).
Expected: clean.

- [ ] **Step 6: Commit (in the app repo)**

```bash
cd ../jbot-review-app
git add packages/shared/src/index.ts
git commit -m "feat(kilo): add Kilo provider to BYOK catalog"
```

---

## Task 11: Full verification + e2e sanity

**Files:** none (verification only)

- [ ] **Step 1: Gates**

Run: `npm run typecheck && npm run lint && npm test && npm run build`
Expected: all green.

- [ ] **Step 2: e2e sanity with the local Kilo login (free model, no cost)**

Confirm a real review path end-to-end using the operator's local auth. Run:

````bash
node --import tsx -e '
import { runKiloReview } from "./src/shared/kilo.ts";
import { readFileSync } from "node:fs";
const auth = readFileSync(`${process.env.HOME}/.local/share/kilo/auth.json`, "utf8");
const pr = "PR CONTEXT:\n```diff\n+ const x = 1 / 0;\n```\nReview this one-line diff.";
const res = await runKiloReview(process.cwd(), "kilo/kilo-auto/free", pr, "", (m)=>console.error("[log]", m), { auth });
console.log("findings:", JSON.stringify(res.findings?.length ?? res, null, 2));
'
````

Expected: logs show `agent=kilo-cli`, a non-empty final message, and `parseReview` yields a `ReviewResult` (findings array). No files written to the workspace.

- [ ] **Step 3: Update the spec status**

Set the spec header `Status:` to `implemented` and commit:

```bash
git add docs/superpowers/specs/2026-07-01-kilo-cli-review-backend-design.md
git commit -m "docs(spec): mark Kilo backend implemented"
```

- [ ] **Step 4: Finish the branch**

Use the `superpowers:finishing-a-development-branch` skill to open the PR(s) — one for `jbot-review`, one for `jbot-review-app`. Note the memory rule: fold same-theme follow-ups into the open PR branch rather than spawning new PRs.

---

## Self-Review

**Spec coverage:** credential flow (T2,T7), `kilo.ts` module (T1–T4), stdin delivery (T4), read-only + no-tools (T1,T4), model default + listing (T1,T4,T7), wiring T5/T6/T7, infra T8, README T9, app catalog T10, tests T1–T6, acceptance T11. All spec sections mapped.

**Placeholder scan:** the only intentional deferral is the app `keysUrl` (T10 Step 1 verifies it — explicitly not guessed, per house rule). No TBD/TODO code steps.

**Type consistency:** `runKilo*` signatures (auth as trailing param) match `createKiloBackend`'s closures and `kiloEnvForAuth(auth, home)`; `parseKiloFinalMessage` reads `part.text`; `KILO_GATEWAY_FREE_MODEL='kilo-auto/free'` prefixed to `kilo/…` consistently in T1 code + T1/T5 tests; `backendSelection.kiloAuth` defined in T6 and consumed in T7.
