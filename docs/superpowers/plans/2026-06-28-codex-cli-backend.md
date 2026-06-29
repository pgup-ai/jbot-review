# Codex CLI Review Backend — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add OpenAI Codex CLI as a fourth pluggable review backend, authenticated by a ChatGPT subscription (base64 `auth.json` secret → temp `CODEX_HOME`), running `codex exec` read-only.

**Architecture:** `src/shared/codex.ts` mirrors `commandcode.ts` (temp-HOME + auth file + the shared `spawnWithTimeout`) with `cursor.ts`'s lean error handling (no bespoke failure classifier). Output is read from `codex exec --output-last-message`. Six wiring edits register it like the other CLI backends.

**Tech Stack:** TypeScript ESM (`.ts` specifiers, tsx), node:test, esbuild, Docker.

**Design source:** `docs/superpowers/specs/2026-06-28-codex-cli-review-backend-design.md`. Deviations from the spec (current-code reality + "no duplication" bar): the repo now has a 4th backend (`cursor`) and a 5th `ReviewBackend` method (`runChangesSinceLastReview`); we drop the `classifyCodexPromptFailure` helper (cursor omits its equivalent — the raw error already carries the text); `defaultModel` is `codex/default` (omit `-m`), not a hardcoded model id.

---

## Task 1: `codex.ts` module + unit tests (TDD)

**Files:**
- Create: `src/shared/codex.ts`
- Create: `test/codex.test.ts`

Mirror `src/shared/commandcode.ts` structure exactly, swapping in Codex specifics:
- `CODEX_PROVIDER_ID = 'codex'`, `CODEX_CLI_BIN = 'codex'`, `isCodexProvider`.
- `codexAuthPath(codexHome)` → `join(codexHome, 'auth.json')`.
- `writeCodexAuth(authB64, codexHome)` → base64-decode, `JSON.parse` to validate, `mkdirSync(codexHome,{mode:0o700})`, write `auth.json` `0o600`. Throw on blank/invalid.
- `buildCodexCliArgs({model})` → `['exec','--sandbox','read-only','--skip-git-repo-check','--ephemeral','--ignore-user-config']` + `['--model', modelID]` unless `modelID==='default'`.
- `codexEnvForHome(codexHome)` → `{...process.env, CODEX_HOME}` with `OPENAI_API_KEY`/`CODEX_API_KEY`/`CODEX_ACCESS_TOKEN` deleted; throw on blank home.
- `formatCodexPromptTimeoutMessage(label,model,timeoutMs)`.
- `runCodexReview` / `runCodexAddressedPriorCommentsCheck` / `runCodexGuidelineComplianceCheck` / `runCodexChangesSinceLastReview` / `runCodexFindingVerification` — identical signatures to the CommandCode equivalents (trailing `home`), delegating to private `runCodexPrompt`.
- `runCodexPrompt` — `mkdtempSync` a temp dir for `--output-last-message`, final argv `[...buildCodexCliArgs({model}), '--output-last-message', outFile, '-']` (prompt on stdin via `input`), `spawnWithTimeout` with `env: codexEnvForHome(home)`, throw on nonzero exit, return the last-message file (fallback to stdout), `rmSync` the temp dir in `finally`.

- [ ] **Step 1: Write `test/codex.test.ts`** (mirror `test/cursor.test.ts` + CommandCode's auth-write test)

```ts
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  buildCodexCliArgs,
  codexAuthPath,
  codexEnvForHome,
  formatCodexPromptTimeoutMessage,
  isCodexProvider,
  writeCodexAuth,
} from '../src/shared/codex.ts';

describe('Codex CLI provider helpers', () => {
  it('matches only the explicit codex provider id', () => {
    assert.equal(isCodexProvider('codex'), true);
    assert.equal(isCodexProvider('Codex'), false);
    assert.equal(isCodexProvider(' codex '), false);
  });

  it('omits --model for the default Codex model and runs read-only', () => {
    assert.deepEqual(buildCodexCliArgs({ model: 'codex/default' }), [
      'exec',
      '--sandbox',
      'read-only',
      '--skip-git-repo-check',
      '--ephemeral',
      '--ignore-user-config',
    ]);
  });

  it('passes explicit Codex model ids without the provider prefix', () => {
    assert.deepEqual(buildCodexCliArgs({ model: 'codex/gpt-5.1-codex' }).slice(-2), [
      '--model',
      'gpt-5.1-codex',
    ]);
  });

  it('never force-bypasses the sandbox (invariant #8)', () => {
    for (const model of ['codex/default', 'codex/gpt-5.1-codex']) {
      const args = buildCodexCliArgs({ model });
      assert.equal(args.includes('--dangerously-bypass-approvals-and-sandbox'), false);
      const i = args.indexOf('--sandbox');
      assert.notEqual(i, -1);
      assert.equal(args[i + 1], 'read-only');
    }
  });

  it('writes auth.json from the base64 secret with 0600 perms', () => {
    const home = mkdtempSync(join(tmpdir(), 'jbot-codex-home-'));
    try {
      const auth = JSON.stringify({ tokens: { access_token: 'a' }, auth_mode: 'chatgpt' });
      const path = writeCodexAuth(Buffer.from(auth).toString('base64'), home);
      assert.equal(path, codexAuthPath(home));
      assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), JSON.parse(auth));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('rejects a blank or non-base64-JSON secret', () => {
    assert.throws(() => writeCodexAuth('   ', '/tmp/x'), /Missing Codex auth/);
    assert.throws(() => writeCodexAuth(Buffer.from('not json').toString('base64'), '/tmp/x'), /Invalid CODEX_AUTH_JSON/);
  });

  it('sets CODEX_HOME and strips ambient api-key envs so subscription auth wins', () => {
    const prev = { OPENAI_API_KEY: process.env.OPENAI_API_KEY };
    try {
      process.env.OPENAI_API_KEY = 'sk-ambient';
      const env = codexEnvForHome('/tmp/jbot-codex-home-test');
      assert.equal(env.CODEX_HOME, '/tmp/jbot-codex-home-test');
      assert.equal(env.OPENAI_API_KEY, undefined);
      assert.equal(env.CODEX_API_KEY, undefined);
      assert.equal(env.CODEX_ACCESS_TOKEN, undefined);
      assert.equal(process.env.OPENAI_API_KEY, 'sk-ambient'); // ambient untouched
    } finally {
      if (prev.OPENAI_API_KEY === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prev.OPENAI_API_KEY;
    }
  });

  it('rejects a blank Codex home', () => {
    assert.throws(() => codexEnvForHome('   '), /Missing Codex home/);
  });

  it('labels prompt timeouts with the session and model', () => {
    assert.equal(
      formatCodexPromptTimeoutMessage('finding-verification', 'codex/gpt-5.1-codex', 1200_000),
      'codex finding-verification prompt timed out after 1200s (model=codex/gpt-5.1-codex)',
    );
  });
});
```

- [ ] **Step 2: Run the test, expect FAIL** — `node --import tsx --test test/codex.test.ts` → cannot find `../src/shared/codex.ts`.
- [ ] **Step 3: Write `src/shared/codex.ts`** (see module spec above; copy `commandcode.ts` and apply the swaps).
- [ ] **Step 4: Run the test, expect PASS** — `node --import tsx --test test/codex.test.ts`.
- [ ] **Step 5: Commit** — `git add src/shared/codex.ts test/codex.test.ts && git commit -m "feat(review): codex CLI backend module"`

## Task 2: Wire backend-selection + config

**Files:**
- Modify: `src/shared/backend-selection.ts`
- Modify: `src/shared/config.ts`
- Modify: `test/backend-selection.test.ts`

- [ ] **Step 1:** In `backend-selection.test.ts`, add `codexAuth: ''` to every existing expectation object (all use full-object `deepEqual`), then add three codex cases (main=codex/aux=opencode; main=opencode/aux=codex; both=codex) mirroring the cursor cases, asserting `codexAuth` routes the right key.
- [ ] **Step 2: Run, expect FAIL** — `node --import tsx --test test/backend-selection.test.ts`.
- [ ] **Step 3:** In `backend-selection.ts`: import `CODEX_PROVIDER_ID, isCodexProvider`; add `| typeof CODEX_PROVIDER_ID` to `CliBackendID`; add `codexAuth: string` to `ReviewBackendSelection`; `codexAuth: keyFor(CODEX_PROVIDER_ID)` in the return; `if (isCodexProvider(providerID)) return CODEX_PROVIDER_ID;` in `cliBackendForProvider`.
- [ ] **Step 4:** In `config.ts`: add the `codex` provider entry after `cursor`:

```ts
  codex: {
    defaultModel: 'codex/default',
    keyEnv: 'CODEX_AUTH_JSON',
    keyInput: 'codex-auth',
    models: {
      // Codex CLI is not driven through opencode, so prompt-cache options do not apply.
      default: { promptCache: false },
    },
  },
```

and add `|| providerID === 'codex'` to the first `if` in `modelSupportsPromptCache`.

- [ ] **Step 5: Run, expect PASS** — `node --import tsx --test test/backend-selection.test.ts`.
- [ ] **Step 6: Commit** — `git commit -am "feat(review): register codex in backend selection + config"`

## Task 3: Wire runner

**Files:**
- Modify: `src/shared/runner.ts`

- [ ] **Step 1:** Add the codex import block (after the cursor import): `CODEX_PROVIDER_ID, runCodexAddressedPriorCommentsCheck, runCodexChangesSinceLastReview, runCodexFindingVerification, runCodexGuidelineComplianceCheck, runCodexReview, writeCodexAuth` from `./codex.ts`.
- [ ] **Step 2:** Add `createCodexBackend(workspace, codexHome)` mirroring `createCommandCodeBackend` (5 methods, pass `codexHome` as the trailing `home` arg).
- [ ] **Step 3:** Declare `codexBackend`/`codexHome`/`cleanupCodexHome` beside the CommandCode ones; add the credential-write block (mirror the CommandCode block) keyed on `CODEX_PROVIDER_ID` using `backendSelection.codexAuth`; add `[CODEX_PROVIDER_ID]: codexBackend` to the `cliBackends` record; call `cleanupCodexHome()` next to each existing `cleanupCommandCodeHome()` (the two `needsOpencode` error paths and the `finally`).
- [ ] **Step 4: Verify** — `npm run typecheck` (the `Record<CliBackendID, …>` literal forces the new key; passes only when all wired).
- [ ] **Step 5: Commit** — `git commit -am "feat(review): drive codex backend from the runner"`

## Task 4: Wire CI (action, workflow, Dockerfile) + docs

**Files:**
- Modify: `action.yml`, `.github/workflows/jbot-review.yml`, `Dockerfile`, `AGENTS.md`, the spec doc.

- [ ] **Step 1:** `action.yml` — add a `codex-auth` input after `cursor-api-key` and `INPUT_CODEX-AUTH: ${{ inputs.codex-auth }}` after `INPUT_CURSOR-API-KEY`.
- [ ] **Step 2:** `.github/workflows/jbot-review.yml` — add `codex-auth: ${{ secrets.CODEX_AUTH_JSON }}` after the `cursor-api-key` line.
- [ ] **Step 3:** `Dockerfile` — add `@openai/codex@latest` to the global npm install and `&& codex --version` to the verify chain.
- [ ] **Step 4:** `AGENTS.md` — add the `codex.ts` row; touch up the spec's method count (5) / classifier / defaultModel to match the implementation.
- [ ] **Step 5: Commit** — `git commit -am "feat(review): codex CI inputs, install, docs"`

## Task 5: Verify, self-review, PR

- [ ] `npm run typecheck && npm run lint && npm test && npm run build` — all green.
- [ ] Full self-review of the diff (correctness, read-only invariant, no duplication, comment terseness, secret handling). Fix findings.
- [ ] `git push -u origin feat/codex-cli-backend` and open the PR.

## Self-Review (plan vs spec)

- **Coverage:** module (T1), selection/config (T2), runner (T3), CI/docs (T4), verify/PR (T5) — every spec section maps to a task.
- **Placeholders:** none — code shown for the load-bearing test; module steps reference the concrete `commandcode.ts` twin.
- **Type consistency:** `codexAuth` (selection field) ↔ `backendSelection.codexAuth` (runner) ↔ `keyEnv: 'CODEX_AUTH_JSON'`/`keyInput: 'codex-auth'` (config) ↔ `codex-auth` input ↔ `CODEX_AUTH_JSON` secret — consistent. Method names match the `ReviewBackend` interface's five methods.
