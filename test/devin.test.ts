import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import {
  buildDevinReadOnlyConfig,
  devinCredentialsPath,
  isDevinProvider,
  writeDevinCredentials,
} from '@symma/protocol';
import {
  buildDevinCliArgs,
  buildDevinCliConfig,
  createDevinCliBackend,
  devinEnvForHome,
  parseDevinCliOutput,
} from '../src/shared/devin-cli.ts';
import { truncateUtf8WithNotice } from '../src/shared/prompt.ts';

describe('Devin CLI provider helpers', () => {
  it('matches only the explicit devin provider id', () => {
    assert.equal(isDevinProvider('devin'), true);
    assert.equal(isDevinProvider(' openai '), false);
    assert.equal(isDevinProvider(' devin '), false);
  });

  it('writes the static credentials file with only the API key injected', () => {
    const home = mkdtempSync(join(tmpdir(), 'jbot-devin-home-'));
    try {
      const path = writeDevinCredentials('test-key', home);

      assert.equal(path, devinCredentialsPath(home));
      assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.equal(
        readFileSync(path, 'utf8'),
        [
          'windsurf_api_key = "test-key"',
          'api_server_url = "https://server.codeium.com"',
          'devin_webapp_host = "https://app.devin.ai"',
          'devin_api_url = "https://api.devin.ai"',
          '',
        ].join('\n'),
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('pins Devin sessions to read-only review permissions', () => {
    assert.deepEqual(buildDevinReadOnlyConfig(), {
      permissions: {
        allow: [
          'read',
          'grep',
          'glob',
          'Read(**)',
          'Exec(git status)',
          'Exec(git diff)',
          'Exec(git log)',
          'Exec(git show)',
          'Exec(git grep)',
          'Exec(git ls-files)',
          'Exec(git rev-parse)',
          'Exec(git merge-base)',
        ],
        deny: ['edit', 'write', 'Write(**)', 'Write(/**)'],
      },
    });
  });

  it('runs Devin headlessly with the selected model', () => {
    assert.deepEqual(buildDevinCliArgs('devin/swe-1.7', '/tmp/prompt', '/tmp/config'), [
      '--respect-workspace-trust',
      'false',
      '--permission-mode',
      'dangerous',
      '--config',
      '/tmp/config',
      '--prompt-file',
      '/tmp/prompt',
      '--model',
      'swe-1.7',
      '-p',
    ]);
    assert.equal(
      buildDevinCliArgs('devin/default', '/tmp/prompt', '/tmp/config').includes('--model'),
      false,
    );

    assert.deepEqual(
      parseDevinCliOutput(
        "\u001b[1mWelcome to Devin CLI!\u001b[0m\nLogged in.\nYou're all set. Run devin.\nOK",
      ),
      { response: 'OK', setupOnly: false },
    );
    assert.deepEqual(
      parseDevinCliOutput("Welcome to Devin CLI!\nLogged in.\nYou're all set. Run devin."),
      { response: '', setupOnly: true },
    );
    assert.deepEqual(parseDevinCliOutput('\u001b[32m{"summary":"ok"}\u001b[0m'), {
      response: '{"summary":"ok"}',
      setupOnly: false,
    });
  });

  it('isolates the Devin child environment and disables background updates', () => {
    const config = buildDevinCliConfig('/tmp/devin-home');
    assert.equal(config.auto_update, false);
    assert.deepEqual(config.permissions.deny, [
      'edit',
      'write',
      'Write(**)',
      'Write(/**)',
      'Read(/tmp/devin-home/**)',
    ]);
    assert.deepEqual(Object.values(config.read_config_from), Array(7).fill(false));
    const saved = { ...process.env };
    try {
      process.env.DEVIN_TEST_TOKEN = 'secret';
      process.env.INPUT_DEVIN_TEST = 'secret';
      process.env.DEVIN_TEST_SAFE = 'kept';
      process.env.XDG_CONFIG_HOME = '/tmp/ambient-config';
      process.env.XDG_DATA_HOME = '/tmp/ambient-data';
      process.env.XDG_CACHE_HOME = '/tmp/ambient-cache';
      process.env.XDG_RUNTIME_DIR = '/tmp/ambient-runtime';
      const env = devinEnvForHome('/tmp/devin-home');
      assert.equal(env.HOME, '/tmp/devin-home');
      assert.equal(env.DEVIN_TEST_TOKEN, undefined);
      assert.equal(env.INPUT_DEVIN_TEST, undefined);
      assert.equal(env.DEVIN_TEST_SAFE, 'kept');
      assert.equal(env.XDG_CONFIG_HOME, undefined);
      assert.equal(env.XDG_DATA_HOME, undefined);
      assert.equal(env.XDG_CACHE_HOME, undefined);
      assert.equal(env.XDG_RUNTIME_DIR, undefined);
    } finally {
      process.env = saved;
    }
  });

  function fakeDevin(script: string) {
    const root = mkdtempSync(join(tmpdir(), 'jbot-devin-test-'));
    const home = join(root, 'home');
    const workspace = join(root, 'workspace');
    const previousPath = process.env.PATH!;
    mkdirSync(home);
    writeDevinCredentials('test-key', home);
    mkdirSync(workspace);
    writeFileSync(
      join(root, 'devin'),
      `#!/usr/bin/env node
const fs = require('node:fs');
if (process.env.GIT_OPTIONAL_LOCKS !== '0') process.exit(2);
const config = JSON.parse(
  fs.readFileSync(process.argv[process.argv.indexOf('--config') + 1], 'utf8'),
);
const stamp = ${JSON.stringify(join(root, 'onboarded'))};
const banner = "Welcome to Devin CLI!\\nYou're all set. Run devin.\\n";
${script}
`,
      { mode: 0o700 },
    );
    process.env.PATH = `${root}:${previousPath}`;
    const logs: string[] = [];
    const backend = createDevinCliBackend(workspace, home);
    return {
      root,
      home,
      backend,
      logs,
      log: (message: string) => logs.push(message),
      async restore() {
        await backend.stop();
        process.env.PATH = previousPath;
        rmSync(root, { recursive: true, force: true });
      },
    };
  }

  it('skips Devin first-run onboarding via the pre-seeded config', async () => {
    const fake = fakeDevin(`
if (config.shell?.setup_complete) process.stdout.write('{"summary":"ok","findings":[]}');
else process.stdout.write(banner);
`);
    try {
      const review = await fake.backend.runReview('devin/default', 'context', '', fake.log);

      assert.equal(review.summary, 'ok');
      assert.equal(
        fake.logs.some((message) => message.includes('first-run setup')),
        false,
      );
    } finally {
      await fake.restore();
    }
  });

  it('still retries once if Devin onboards despite the seeded config', async () => {
    const fake = fakeDevin(`
if (fs.existsSync(stamp)) process.stdout.write('{"summary":"ok","findings":[]}');
else {
  fs.writeFileSync(stamp, '');
  process.stdout.write(banner);
}
`);
    try {
      const review = await fake.backend.runReview('devin/default', 'context', '', fake.log);

      assert.equal(review.summary, 'ok');
      assert.equal(fake.logs.filter((message) => message.includes('first-run setup')).length, 1);
    } finally {
      await fake.restore();
    }
  });

  it('retries an empty model catalog once but preserves an unsupported-model error', async () => {
    for (const [available, recovers, acp] of [
      ['', true, false],
      ['', false, false],
      ['swe-1', false, false],
      ['', true, true],
      ['', false, true],
      ['swe-1', false, true],
    ] as const) {
      const error = acp
        ? 'Error: session/set_config_option (model) failed: Resource not found: ' +
          JSON.stringify(
            { uri: 'Model not found: swe-2-high. Available models: ' + available },
            null,
            2,
          )
        : "Error: Unknown model: 'swe-2'\nAvailable: " + available + '\n';
      const fake = fakeDevin(`
const attempt = fs.existsSync(stamp) ? Number(fs.readFileSync(stamp, 'utf8')) + 1 : 1;
fs.writeFileSync(stamp, String(attempt));
if (${acp && recovers} && attempt === 1) process.stdout.write('');
else if (${recovers} && attempt > ${acp ? 2 : 1}) process.stdout.write('{"summary":"recovered","findings":[]}');
else {
  process.stderr.write(${JSON.stringify(error)});
  process.exitCode = 1;
}
`);
      try {
        const review = fake.backend.runReview('devin/swe-2', 'context', '', fake.log, {
          timeoutMs: 3000,
        });
        if (recovers) assert.equal((await review).summary, 'recovered');
        else await assert.rejects(review, /Unknown model|Model not found/);
        assert.equal(
          readFileSync(join(fake.root, 'onboarded'), 'utf8'),
          acp && recovers ? '3' : available ? '1' : '2',
        );
        assert.equal(
          fake.logs.some((line) => line.includes('empty model catalog')),
          !available,
        );
      } finally {
        await fake.restore();
      }
    }
  });

  it('allows onboarding and catalog recovery once each within one invocation', async () => {
    for (const sequence of [
      ['setup', 'catalog'],
      ['catalog', 'setup'],
    ]) {
      const fake = fakeDevin(`
const attempt = fs.existsSync(stamp) ? Number(fs.readFileSync(stamp, 'utf8')) : 0;
fs.writeFileSync(stamp, String(attempt + 1));
const result = ${JSON.stringify(sequence)}[attempt];
if (result === 'setup') process.stdout.write(banner);
else if (result === 'catalog') {
  process.stderr.write("Error: Unknown model: 'swe-2'\\nAvailable: ");
  process.exitCode = 1;
} else process.stdout.write('{"summary":"recovered","findings":[]}');
`);
      try {
        const result = await fake.backend.runReview('devin/swe-2', 'context', '', fake.log, {
          timeoutMs: 10000,
        });
        assert.equal(result.summary, 'recovered');
        assert.equal(readFileSync(join(fake.root, 'onboarded'), 'utf8'), '3');
      } finally {
        await fake.restore();
      }
    }
  });

  it('cancels only the selected Devin session and reaps remaining sessions before cleanup', async () => {
    const fake = fakeDevin(`
const prompt = fs.readFileSync(process.argv[process.argv.indexOf('--prompt-file') + 1], 'utf8');
const label = prompt.includes('LENS_MARKER') ? 'lens' : 'main';
fs.writeFileSync(stamp + '-' + label, JSON.stringify({ home: process.env.HOME, pid: process.pid }));
setInterval(() => {}, 1000);
`);
    const lens = fake.backend.runReview('devin/default', 'LENS_MARKER', '', fake.log, {
      label: 'review-interactions',
      timeoutMs: 60000,
    });
    const main = fake.backend.runReview('devin/default', 'MAIN_MARKER', '', fake.log, {
      timeoutMs: 60000,
    });
    const lensRejected = assert.rejects(lens, /aborted/);
    const mainRejected = assert.rejects(main, /runtime stopped/);
    try {
      const records = ['lens', 'main'].map((label) => join(fake.root, 'onboarded-' + label));
      const deadline = Date.now() + 5000;
      while (!records.every(existsSync) && Date.now() < deadline) await delay(10);
      assert.ok(records.every(existsSync));
      const [a, b] = records.map((path) => JSON.parse(readFileSync(path, 'utf8')));
      assert.notEqual(a.home, b.home);
      for (const session of [a, b]) {
        assert.equal(dirname(session.home), fake.home);
        const config = JSON.parse(readFileSync(join(session.home, 'config.json'), 'utf8'));
        assert.ok(config.permissions.deny.includes(`Read(${fake.home}/**)`));
        assert.equal(statSync(devinCredentialsPath(session.home)).mode & 0o777, 0o600);
        assert.equal(
          readFileSync(devinCredentialsPath(session.home), 'utf8'),
          readFileSync(devinCredentialsPath(fake.home), 'utf8'),
        );
      }
      assert.equal(fake.backend.abortSessionsByLabel!('review-interactions', fake.log), 1);
      await lensRejected;
      assert.equal(existsSync(a.home), false);
      assert.throws(() => process.kill(a.pid, 0));
      process.kill(b.pid, 0);
      assert.equal(existsSync(b.home), true);
      await fake.backend.stop();
      await mainRejected;
      assert.equal(existsSync(b.home), false);
      assert.throws(() => process.kill(b.pid, 0));
      assert.equal(existsSync(devinCredentialsPath(fake.home)), true);
    } finally {
      await fake.backend.stop();
      await Promise.allSettled([lensRejected, mainRejected]);
      await fake.restore();
    }
  });

  it('relaunches once and surfaces the CLI log when Devin exits 0 without output', async () => {
    for (const [logLines, stderr, expected] of [
      [
        [
          'INFO chisel: CLI init complete',
          'ERROR handoff: session/new failed: 429 Too Many Requests',
        ],
        '',
        /exited 0 with no output[\s\S]*429 Too Many Requests/,
      ],
      [
        ['INFO chisel: CLI init complete', 'INFO repl_mode: close time.idle=21s'],
        '',
        /close time\.idle=21s/,
      ],
      [
        [],
        'warning: bridge closed',
        /exited 0 with no output[\s\S]*stderr: warning: bridge closed/,
      ],
    ] as const) {
      const fake = fakeDevin(`
fs.appendFileSync(stamp, 'launch\\n');
const logs = process.env.HOME + '/.local/share/devin/cli/logs';
fs.mkdirSync(logs, { recursive: true });
fs.writeFileSync(logs + '/devin_20260911-000000_1.log', ${JSON.stringify(logLines.map((line) => `2026-09-11T00:00:00Z  ${line}`).join('\n'))});
process.stderr.write(${JSON.stringify(stderr)});
`);
      try {
        await assert.rejects(
          fake.backend.runReview('devin/default', 'context', '', fake.log, { timeoutMs: 5000 }),
          expected,
        );
        await assert.rejects(
          fake.backend.runGuidelineComplianceCheck('devin/default', 'context', '', fake.log, 5000),
          expected,
        );
        assert.equal(readFileSync(join(fake.root, 'onboarded'), 'utf8'), 'launch\n'.repeat(4));
        assert.equal(
          fake.logs.filter((line) => line.includes('no output; retrying once')).length,
          2,
        );
        assert.equal(
          fake.logs.some((line) => line.includes('continuation')),
          false,
        );
        assert.deepEqual(
          readdirSync(fake.home).filter((entry) => entry.startsWith('session-')),
          [],
        );
      } finally {
        await fake.restore();
      }
    }
  });

  it('rejects incomplete auxiliary replies while accepting explicit empty results', async () => {
    for (const response of [
      "I'll audit this PR. Let me regenerate the complete current diff.",
      '{}',
      '[]',
      '{"findings":[]}',
      '{"addressedPriorComments":[]}',
    ]) {
      const fake = fakeDevin('process.stdout.write(' + JSON.stringify(response) + ');');
      try {
        const guideline = fake.backend.runGuidelineComplianceCheck(
          'devin/default',
          'context',
          'guidelines',
          fake.log,
          60000,
        );
        if (response === '{"findings":[]}') assert.deepEqual(await guideline, []);
        else await assert.rejects(guideline, /unparseable JSON|non-object|findings array/);

        const addressed = fake.backend.runAddressedPriorCommentsCheck(
          'devin/default',
          'context',
          fake.log,
          60000,
        );
        if (response === '{"addressedPriorComments":[]}') assert.deepEqual(await addressed, []);
        else
          await assert.rejects(
            addressed,
            /unparseable JSON|non-object|addressedPriorComments array/,
          );
      } finally {
        await fake.restore();
      }
    }
  });

  it('shares the review deadline with continuation and JSON repair', async () => {
    for (const response of ['I will inspect the code.', '{"summary":']) {
      const fake = fakeDevin(
        "fs.appendFileSync(stamp, 'launch\\n'); process.stdout.write(" +
          JSON.stringify(response) +
          ');',
      );
      const now = Date.now;
      let elapsed = 0;
      Date.now = () => now() + elapsed;
      try {
        await assert.rejects(
          fake.backend.runReview(
            'devin/default',
            'context',
            '',
            (message) => {
              fake.log(message);
              if (message.includes('prompt complete via devin')) elapsed = 120000;
            },
            { timeoutMs: 60000 },
          ),
          /deadline expired/,
        );
        assert.equal(readFileSync(join(fake.root, 'onboarded'), 'utf8'), 'launch\n');
      } finally {
        Date.now = now;
        await fake.restore();
      }
    }
  });

  it('reaps the CLI before fatal-signal credential cleanup', async () => {
    const fake = fakeDevin(`
process.on('SIGTERM', () => {
  setTimeout(() => {
    fs.writeFileSync(stamp + '-terminated', String(fs.existsSync(process.env.HOME)));
    process.exit(0);
  }, 50);
});
fs.writeFileSync(stamp, JSON.stringify({ pid: process.pid, home: process.env.HOME }));
setInterval(() => {}, 1000);
`);
    const driver = join(fake.root, 'driver.mjs');
    writeFileSync(
      driver,
      `
import { rmSync } from 'node:fs';
import { createDevinCliBackend } from ${JSON.stringify(new URL('../src/shared/devin-cli.ts', import.meta.url).href)};
import { onCliFatalSignal } from ${JSON.stringify(new URL('../src/shared/cli-process.ts', import.meta.url).href)};
const backend = createDevinCliBackend(${JSON.stringify(join(fake.root, 'workspace'))}, ${JSON.stringify(fake.home)});
onCliFatalSignal(async () => {
  await backend.stop();
  rmSync(${JSON.stringify(fake.home)}, { recursive: true, force: true });
});
backend.runReview('devin/default', 'context', '', () => {}, { timeoutMs: 60000 }).catch(() => {});
setInterval(() => {}, 1000);
`,
    );
    const child = spawn(process.execPath, ['--import', 'tsx', driver], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15000,
      killSignal: 'SIGKILL',
    });
    const closed = once(child, 'close');
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    let record: { pid: number; home: string } | undefined;
    try {
      const limit = Date.now() + 10000;
      while (!existsSync(join(fake.root, 'onboarded')) && Date.now() < limit) await delay(10);
      assert.ok(existsSync(join(fake.root, 'onboarded')), stderr);
      record = JSON.parse(readFileSync(join(fake.root, 'onboarded'), 'utf8'));
      child.kill('SIGTERM');
      const [code, signal] = await closed;
      assert.equal(code, null, stderr);
      assert.equal(signal, 'SIGTERM', stderr);
      assert.equal(readFileSync(join(fake.root, 'onboarded-terminated'), 'utf8'), 'true');
      assert.equal(existsSync(fake.home), false);
      assert.throws(() => process.kill(record!.pid, 0));
    } finally {
      child.kill('SIGKILL');
      if (record) {
        try {
          process.kill(-record.pid, 'SIGKILL');
        } catch {}
      }
      await closed;
      await fake.restore();
    }
  });

  it('truncates repair context by bytes with an omission notice', () => {
    const value = 'abc😃def';
    const truncated = truncateUtf8WithNotice(value, 6, 'Context');

    assert.equal(Buffer.byteLength(truncated.split('\n\n')[0]!, 'utf8') <= 6, true);
    assert.match(truncated, /\[Context truncated to \d+ bytes; omitted \d+ bytes\.\]/);
  });
});
