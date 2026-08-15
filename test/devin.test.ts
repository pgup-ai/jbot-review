import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, statSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

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
      'auto',
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

  it('reuses one Devin home and workspace across prompt sessions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jbot-devin-test-'));
    const home = join(root, 'home');
    const workspace = join(root, 'workspace');
    const executable = join(root, 'devin');
    const previousPath = process.env.PATH!;
    mkdirSync(home);
    mkdirSync(workspace);
    writeFileSync(
      executable,
      `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const markers = [
  path.join(process.env.HOME, 'setup-complete'),
  path.join(process.cwd(), 'setup-complete'),
];
if (markers.some((marker) => !fs.existsSync(marker))) {
  for (const marker of markers) fs.writeFileSync(marker, '');
  process.stdout.write("Welcome to Devin CLI!\\nYou're all set. Run devin.\\n");
} else {
  process.stdout.write('{"summary":"ok","findings":[]}');
}
`,
      { mode: 0o700 },
    );
    try {
      process.env.PATH = `${root}:${previousPath}`;
      const logs: string[] = [];
      const backend = createDevinCliBackend(workspace, home);

      await backend.runReview('devin/default', 'context', '', (message) => logs.push(message));
      await backend.runReview('devin/default', 'context', '', (message) => logs.push(message));

      assert.equal(logs.filter((message) => message.includes('first-run setup')).length, 1);
    } finally {
      process.env.PATH = previousPath;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('truncates repair context by bytes with an omission notice', () => {
    const value = 'abc😃def';
    const truncated = truncateUtf8WithNotice(value, 6, 'Context');

    assert.equal(Buffer.byteLength(truncated.split('\n\n')[0]!, 'utf8') <= 6, true);
    assert.match(truncated, /\[Context truncated to \d+ bytes; omitted \d+ bytes\.\]/);
  });
});
