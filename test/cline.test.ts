import assert from 'node:assert/strict';
import { createCliProcessScope } from '../src/shared/cli-process.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  assertClinePromptArgWithinBudget,
  buildClineCliArgs,
  buildClinePromptArg,
  CLINE_MAX_ARGV_BYTES,
  ClineSdkForbiddenError,
  clineEnvForHome,
  clineFailureDetail,
  clineProvidersPath,
  clineSdkFailure,
  formatClinePromptTimeoutMessage,
  isClineProvider,
  parseClineFinalMessage,
  runClineFindingVerification,
  runClineReview,
  runClineSdkFindingVerification,
  stripClineModelReasoning,
  withClineSdkFallback,
  writeClineAuth,
} from '../src/shared/cline.ts';
import { readablePath, readOnlyTools } from '../src/shared/cline-sdk-worker.ts';

describe('Cline CLI provider helpers', () => {
  it('matches both cline billing-mode provider ids', () => {
    assert.equal(isClineProvider('cline'), true);
    assert.equal(isClineProvider('cline-pass'), true);
    assert.equal(isClineProvider('Cline'), false);
    assert.equal(isClineProvider(' cline '), false);
  });

  it('sets --provider to the billing mode and omits --model for default', () => {
    assert.deepEqual(buildClineCliArgs({ model: 'cline-pass/default', promptArg: 'P' }), [
      '--json',
      '--plan',
      '--auto-approve',
      'false',
      '--provider',
      'cline-pass',
      'P',
    ]);
    assert.deepEqual(buildClineCliArgs({ model: 'cline/default', promptArg: 'P' }).slice(-3), [
      '--provider',
      'cline',
      'P',
    ]);
  });

  it('builds --model as modelType/model per mode', () => {
    // cline-pass models are namespaced under the provider.
    assert.deepEqual(buildClineCliArgs({ model: 'cline-pass/glm-5.2', promptArg: 'P' }).slice(-3), [
      '--model',
      'cline-pass/glm-5.2',
      'P',
    ]);
    // pay-as-you-go cline models already carry their type.
    assert.deepEqual(
      buildClineCliArgs({ model: 'cline/deepseek/deepseek-v4-flash', promptArg: 'P' }).slice(-3),
      ['--model', 'deepseek/deepseek-v4-flash', 'P'],
    );
  });

  it('delivers the prompt as the final positional arg (cline ignores piped stdin headless)', () => {
    // Regression pin for PR #79: stdin delivery fails every session with
    // "JSON output mode requires a prompt argument or piped stdin".
    const promptArg = buildClinePromptArg('REVIEW BODY');
    assert.equal(buildClineCliArgs({ model: 'cline-pass/glm-5.2', promptArg }).at(-1), promptArg);
  });

  it('prepends the no-tools directive to the prompt argv', () => {
    const arg = buildClinePromptArg('REVIEW BODY');
    // Load-bearing override phrases: cline must not attempt tool calls it cannot approve.
    assert.match(arg, /Use no tools for this review/);
    assert.match(arg, /running the git diff command/);
    // The full review prompt is preserved verbatim after the directive.
    assert.ok(arg.endsWith('\n\nREVIEW BODY'));
  });

  it('guards the argv prompt with a clear backend cap', () => {
    assert.doesNotThrow(() =>
      assertClinePromptArgWithinBudget('review', 'x'.repeat(CLINE_MAX_ARGV_BYTES)),
    );
    assert.throws(
      () => assertClinePromptArgWithinBudget('review', 'x'.repeat(CLINE_MAX_ARGV_BYTES + 1)),
      /cline review prompt is \d+ bytes, over the \d+-byte argv limit.*Incomplete review coverage/,
    );
    assert.throws(
      () => assertClinePromptArgWithinBudget('review', '界'.repeat(CLINE_MAX_ARGV_BYTES / 2)),
      /argv limit/,
    );
  });

  it('never auto-approves tools or enables yolo (invariant #8)', () => {
    for (const model of ['cline/default', 'cline-pass/glm-5.2']) {
      const args = buildClineCliArgs({ model, promptArg: 'P' });
      assert.equal(args.includes('--yolo'), false);
      const approveIndex = args.indexOf('--auto-approve');
      assert.notEqual(approveIndex, -1);
      assert.equal(args[approveIndex + 1], 'false');
    }
  });

  it('strips model/reasoning but keeps the auth token', () => {
    const src = JSON.stringify({
      lastUsedProvider: 'cline-pass',
      providers: {
        'cline-pass': {
          settings: {
            provider: 'cline-pass',
            auth: { accessToken: 'tok' },
            model: 'x',
            reasoning: { effort: 'high' },
          },
        },
      },
    });
    const stripped = JSON.parse(stripClineModelReasoning(src));
    assert.equal(stripped.providers['cline-pass'].settings.model, undefined);
    assert.equal(stripped.providers['cline-pass'].settings.reasoning, undefined);
    assert.deepEqual(stripped.providers['cline-pass'].settings.auth, { accessToken: 'tok' });
    assert.equal(stripped.lastUsedProvider, 'cline-pass');
  });

  it('writes providers.json with 0600 perms, stripped to the auth token', () => {
    const home = mkdtempSync(join(tmpdir(), 'jbot-cline-home-'));
    try {
      const auth = JSON.stringify({
        lastUsedProvider: 'cline-pass',
        providers: {
          'cline-pass': { settings: { auth: { accessToken: 'tok' }, model: 'x', reasoning: {} } },
        },
      });
      const path = writeClineAuth(auth, home);

      assert.equal(path, clineProvidersPath(home));
      assert.equal(statSync(path).mode & 0o777, 0o600);
      const written = JSON.parse(readFileSync(path, 'utf8'));
      assert.equal(written.providers['cline-pass'].settings.model, undefined);
      assert.equal(written.providers['cline-pass'].settings.reasoning, undefined);
      assert.deepEqual(written.providers['cline-pass'].settings.auth, { accessToken: 'tok' });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('rejects a blank or non-JSON Cline secret', () => {
    assert.throws(() => writeClineAuth('   ', '/tmp/x'), /Missing Cline auth/);
    assert.throws(() => writeClineAuth('not json', '/tmp/x'), /Invalid CLINE_AUTH_JSON/);
  });

  it('sets HOME and strips credential-shaped env so carried auth wins', () => {
    const credentialKeys = [
      'CLINE_AUTH_JSON',
      'NVIDIA_API_KEY',
      'DIM_AUTH_BUNDLE',
      'FUTURE_PROVIDER_SECRET',
    ];
    const previous = new Map(credentialKeys.map((key) => [key, process.env[key]] as const));
    try {
      for (const key of credentialKeys) process.env[key] = `ambient-${key}`;

      const env = clineEnvForHome('/tmp/jbot-cline-home-test');

      assert.equal(env.HOME, '/tmp/jbot-cline-home-test');
      assert.equal(env.CLINE_NO_AUTO_UPDATE, '1');
      for (const key of credentialKeys) {
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

  it('rejects a blank Cline home', () => {
    assert.throws(() => clineEnvForHome('   '), /Missing Cline home/);
  });

  it('extracts the final message from the run_result NDJSON event', () => {
    const ndjson = [
      '{"type":"hook_event","event":{}}',
      '{"type":"agent_event","event":{"type":"content_start","text":"{\\"findings\\":[]}"}}',
      'not json — ignored',
      '{"type":"run_result","finishReason":"completed","text":"{\\"findings\\":[]}"}',
    ].join('\n');
    assert.equal(parseClineFinalMessage(ndjson), '{"findings":[]}');
  });

  it('returns empty when no run_result message is present', () => {
    assert.equal(parseClineFinalMessage('{"type":"agent_event","event":{}}'), '');
    assert.equal(parseClineFinalMessage('garbage\nlines'), '');
    assert.equal(parseClineFinalMessage('{"type":"run_result","text":""}'), '');
  });

  it('drops @-mention ENOENT warnings from failure output so the real error survives the cap', () => {
    // A quote or backtick swallowed by Cline's mention regex distinguishes these from missing files;
    // older CLI versions report either `statx` or `stat`.
    const warnings = Array.from(
      { length: 40 },
      (_, i) =>
        `[warning] ENOENT: no such file or directory, stat${i % 2 ? 'x' : ''} '/api/module-${i}${["';'", '",\'', "`'"][i % 3]}`,
    ).join('\n');
    const missing = "[warning] ENOENT: no such file or directory, stat '/root/.cline/rules'";
    const detail = clineFailureDetail(
      `${warnings}\n${missing}\nError: context length exceeded`,
      'events',
    );
    assert.match(
      detail,
      /^\[warning\] ENOENT: no such file or directory, stat '\/root\/\.cline\/rules'\nError: context length exceeded \(40 @-mention ENOENT warnings dropped\)$/,
    );
    // Only warnings: fall back to stdout rather than an empty message.
    assert.match(clineFailureDetail(warnings, 'events'), /^events \(40 @-mention/);
    assert.equal(clineFailureDetail('', ''), '');
  });

  it('labels prompt timeouts with the session and model', () => {
    assert.equal(
      formatClinePromptTimeoutMessage('finding-verification', 'cline/default', 1200_000),
      'cline finding-verification prompt timed out after 1200s (model=cline/default)',
    );
  });

  it('cancels a running Cline process before its deadline and reaps it', async (t) => {
    const workspace = mkdtempSync(join(tmpdir(), 'cline-cancel-'));
    const originalPath = process.env.PATH;
    const scope = createCliProcessScope();
    t.after(async () => {
      await scope.stop();
      process.env.PATH = originalPath;
      rmSync(workspace, { recursive: true, force: true });
    });
    process.env.PATH = `${workspace}:${originalPath}`;
    writeClineAuth('{"providers":{}}', workspace);
    const ready = join(workspace, 'pid');
    writeFileSync(
      join(workspace, 'cline'),
      `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid));setInterval(() => {}, 1000);`,
      { mode: 0o700 },
    );
    const result = scope.run('review-interactions', () =>
      runClineReview('cline/default', 'context', '', () => {}, {
        home: workspace,
        timeoutMs: 10000,
      }),
    );
    const rejected = assert.rejects(result, /aborted/);
    let pid = 0;
    for (let attempt = 0; attempt < 100 && !pid; attempt++) {
      try {
        pid = Number(readFileSync(ready, 'utf8'));
      } catch {
        await delay(10);
      }
    }
    assert.ok(pid > 0);
    assert.equal(scope.abort('review-interactions'), 1);
    await rejected;
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  });

  it('preserves the prompt outcome when temporary-home cleanup fails', async (t) => {
    const workspace = mkdtempSync(join(tmpdir(), 'cline-cleanup-'));
    const originalPath = process.env.PATH;
    const cleanup: string[] = [];
    const logs: string[] = [];
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      process.env.PATH = originalPath;
      for (const path of [...cleanup, workspace]) rmSync(path, { recursive: true, force: true });
    });
    process.env.PATH = `${workspace}:${originalPath}`;
    writeClineAuth('{"providers":{}}', workspace);
    t.mock.method(fs, 'rm', async (path: string) => {
      cleanup.push(path);
      throw Object.assign(new Error('private filesystem detail'), { code: 'ENOTEMPTY' });
    });
    syncBuiltinESMExports();
    for (const fail of [false, true]) {
      writeFileSync(
        join(workspace, 'cline'),
        `#!/usr/bin/env node\nif (process.env.CLINE_NO_AUTO_UPDATE !== '1') process.exit(3);\n${
          fail
            ? "console.error('original provider failure'); process.exit(7);"
            : 'console.log(JSON.stringify({type:"run_result",text:\'{"summary":"","findings":[]}\'}));'
        }\n`,
        { mode: 0o700 },
      );
      const result = runClineReview('cline/default', 'context', '', (m) => logs.push(m), {
        home: workspace,
        timeoutMs: 5000,
      });
      if (fail) await assert.rejects(result, /original provider failure/);
      else assert.deepEqual((await result).findings, []);
    }
    assert.equal(logs.filter((m) => /cleanup failed: ENOTEMPTY/.test(m)).length, 2);
    assert.doesNotMatch(logs.join('\n'), /private filesystem detail/);
  });

  it('runs Cline in an empty directory so hooks and rules a PR commits never load', async (t) => {
    const bin = mkdtempSync(join(tmpdir(), 'cline-cwd-'));
    const originalPath = process.env.PATH;
    t.after(() => {
      process.env.PATH = originalPath;
      rmSync(bin, { recursive: true, force: true });
    });
    process.env.PATH = `${bin}:${originalPath}`;
    writeClineAuth('{"providers":{}}', bin);
    const seen = join(bin, 'cwd.json');
    writeFileSync(
      join(bin, 'cline'),
      `#!/usr/bin/env node\nconst fs = require('fs');\nfs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ cwd: process.cwd(), entries: fs.readdirSync('.') }));\nconsole.log(JSON.stringify({type:"run_result",text:'{"summary":"","findings":[]}'}));\n`,
      { mode: 0o700 },
    );
    await runClineReview('cline/default', 'context', '', () => {}, { home: bin, timeoutMs: 5000 });
    const { cwd, entries } = JSON.parse(readFileSync(seen, 'utf8'));
    assert.notEqual(cwd, process.cwd());
    assert.deepEqual(entries, []);
  });

  it('verifies findings with the no-tools prompt', async (t) => {
    const bin = mkdtempSync(join(tmpdir(), 'cline-verify-'));
    const originalPath = process.env.PATH;
    t.after(() => {
      process.env.PATH = originalPath;
      rmSync(bin, { recursive: true, force: true });
    });
    process.env.PATH = `${bin}:${originalPath}`;
    writeClineAuth('{"providers":{}}', bin);
    const seen = join(bin, 'prompt.txt');
    const text = JSON.stringify({ verdicts: [{ index: 0, verdict: 'uncertain', reason: 'r' }] });
    writeFileSync(
      join(bin, 'cline'),
      `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(seen)}, process.argv.at(-1));\nconsole.log(${JSON.stringify(JSON.stringify({ type: 'run_result', text }))});\n`,
      { mode: 0o700 },
    );
    const finding = { path: 'a.ts', line: 1, severity: 'P2', title: 't', body: 'b' };
    await runClineFindingVerification(
      'cline/default',
      'ctx',
      [finding],
      () => {},
      5000,
      undefined,
      bin,
    );
    const prompt = readFileSync(seen, 'utf8');
    assert.match(prompt, /have no tools on this call/);
    assert.doesNotMatch(prompt, /full repository is checked out/);
  });

  it('retries a silent Cline exit once in a fresh home and reports what Cline logged', async (t) => {
    const bin = mkdtempSync(join(tmpdir(), 'cline-silent-'));
    const originalPath = process.env.PATH;
    t.after(() => {
      process.env.PATH = originalPath;
      rmSync(bin, { recursive: true, force: true });
    });
    process.env.PATH = `${bin}:${originalPath}`;
    writeClineAuth('{"providers":{}}', bin);
    const homes = join(bin, 'homes');
    for (const silentTwice of [false, true]) {
      rmSync(homes, { force: true });
      writeFileSync(
        join(bin, 'cline'),
        `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
fs.appendFileSync(${JSON.stringify(homes)}, process.env.HOME + '\\n');
if (${silentTwice} || fs.readFileSync(${JSON.stringify(homes)}, 'utf8').trim().split('\\n').length === 1) {
  const logs = path.join(process.env.HOME, '.cline', 'data', 'logs');
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(path.join(logs, 'cline.log'), '{"level":30,"msg":"CLI run started"}\\n{"level":50,"msg":"CLI run failed","err":{"message":"boom"}}\\n');
  process.exit(0);
}
console.log(JSON.stringify({ type: 'run_result', text: '{"summary":"","findings":[]}' }));
`,
        { mode: 0o700 },
      );
      const run = runClineReview('cline/default', 'context', '', () => {}, {
        home: bin,
        timeoutMs: 5000,
      });
      if (silentTwice) await assert.rejects(run, /no run_result.*cline\.log: CLI run failed: boom/);
      else assert.deepEqual((await run).findings, []);
      const seen = readFileSync(homes, 'utf8').trim().split('\n');
      assert.equal(seen.length, 2);
      assert.notEqual(seen[0], seen[1]);
    }
  });
});

describe('Cline SDK verifier', () => {
  it('reads only tracked checkout files outside .git', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jbot-cline-sdk-'));
    const outside = mkdtempSync(join(tmpdir(), 'jbot-cline-sdk-out-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: root });
      mkdirSync(join(root, 'src'));
      writeFileSync(join(root, 'src/a.ts'), 'export const answer = 42;\n');
      writeFileSync(join(outside, 'token'), 'secret');
      symlinkSync(outside, join(root, 'out'));
      execFileSync('git', ['add', '-A'], { cwd: root });
      for (const path of ['../token', '/etc/hosts', 'out/token', '.git', '.git/config'])
        assert.equal(readablePath(root, path), undefined, path);
      const calls: { denied: boolean }[] = [];
      const [read, grep] = readOnlyTools(root, calls);
      const run = (tool: typeof read, input: object) => tool.execute(input, {} as never);
      assert.equal(await run(read, { path: 'src/a.ts' }), '1: export const answer = 42;\n2: ');
      assert.match(String(await run(read, { path: '.git/config' })), /^Denied/);
      assert.match(String(await run(grep, { pattern: 'answer' })), /^src\/a\.ts:1:/);
      assert.match(String(await run(grep, { pattern: 'secret', path: 'out' })), /^Denied/);
      assert.deepEqual(
        calls.map((call) => call.denied),
        [false, true, false, true],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('returns oversized tool output truncated within the cap', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jbot-cline-sdk-big-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: root });
      writeFileSync(
        join(root, 'wide.txt'),
        Array.from({ length: 20_000 }, () => '日本語の行').join('\n'),
      );
      mkdirSync(join(root, 'many'));
      for (let i = 0; i < 2_000; i++)
        writeFileSync(join(root, 'many', `${'n'.repeat(80)}-${i}`), '');
      execFileSync('git', ['add', '-A'], { cwd: root });
      const [read, , list] = readOnlyTools(root, []);
      // The listing overflows git's output buffer; the multibyte file overflows the byte cap.
      for (const output of [
        await read.execute({ path: 'wide.txt', end_line: 20_000 }, {} as never),
        await list.execute({}, {} as never),
      ]) {
        assert.ok(Buffer.byteLength(String(output)) <= 32 * 1024);
        assert.match(String(output), /\[Output truncated to \d+ bytes/);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls back to the CLI verifier unless Cline refuses the SDK route', async () => {
    const logs: string[] = [];
    const log = (message: string) => logs.push(message);
    const cli = async (timeoutMs?: number) =>
      `cli within ${timeoutMs !== undefined && timeoutMs <= 1000}`;
    const failing = (stderr: string) => async () => {
      throw clineSdkFailure(1, stderr);
    };
    assert.equal(await withClineSdkFallback(async () => 'sdk', cli, 1000, log), 'sdk');
    assert.equal(
      await withClineSdkFallback(failing('socket hang up'), cli, 1000, log),
      'cli within true',
    );
    assert.match(logs.join('\n'), /socket hang up\); falling back to the CLI single pass/);
    await assert.rejects(
      withClineSdkFallback(
        failing('Error: Error 403: only via Cline product surfaces'),
        cli,
        1000,
        log,
      ),
      ClineSdkForbiddenError,
    );
    // `default` has no SDK model id, so it goes straight to the CLI without a worker.
    await assert.rejects(
      runClineSdkFindingVerification('cline/default', 'diff', [], log, undefined, '/unused'),
      /concrete model id/,
    );
  });

  it('pins one Cline SDK version for local runs and the full image', () => {
    const pin = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
      .devDependencies['@cline/sdk'];
    assert.match(pin, /^\d+\.\d+\.\d+$/);
    assert.ok(
      readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8').includes(`@cline/sdk@${pin}`),
    );
  });
});
