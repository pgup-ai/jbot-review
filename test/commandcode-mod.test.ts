import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import commandCodeReviewMod from '../src/shared/commandcode-mod.ts';
import {
  commandCodeEnvForHome,
  writeCommandCodeReadOnlySettings,
} from '../src/shared/commandcode.ts';

type ModApi = Parameters<typeof commandCodeReviewMod>[0];

it('reads literal bracketed filenames while refusing escapes and non-file reads', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'jbot-cc-mod-'));
  const root = join(parent, 'repo');
  mkdirSync(root);
  execFileSync('git', ['-C', root, 'init', '-q']);
  writeFileSync(join(root, '[id].ts'), 'safe');
  writeFileSync(join(root, '.gitignore'), '.env\n');
  writeFileSync(join(root, '.env'), 'private');
  symlinkSync(join(root, '.env'), join(root, 'private-link'));
  writeFileSync(join(parent, 'outside.ts'), 'outside');
  symlinkSync(join(parent, 'outside.ts'), join(root, 'escape.ts'));
  const previous = process.env.JBOT_COMMANDCODE_WORKSPACE;
  let hook!: Parameters<ModApi['hooks']>[0]['beforeToolCall'];
  const tools: Parameters<ModApi['addTool']>[0][] = [];
  try {
    process.env.JBOT_COMMANDCODE_WORKSPACE = root;
    commandCodeReviewMod({
      setActiveTools(names) {
        assert.deepEqual(names, ['jbot_read_file', 'jbot_search', 'jbot_list_files']);
      },
      hooks(hooks) {
        hook = hooks.beforeToolCall;
      },
      addTool(tool) {
        tools.push(tool);
      },
    });
    const read = tools.find((t) => t.schema.name === 'jbot_read_file')!;
    for (const path of ['../outside.ts', 'escape.ts', root, join(parent, 'outside.ts')]) {
      const result = await read.run({ input: { path } });
      assert.equal(result.ok, false, path);
      assert.match(result.error, /outside the reviewed repository|not a regular file/);
    }
    for (const path of ['.env', 'private-link', '.git/config']) {
      const denied = await read.run({ input: { path } });
      assert.equal(denied.ok, false);
      assert.match(denied.error, /unavailable/);
    }
    const result = await read.run({ input: { path: '[id].ts' } });
    assert.equal(result.ok, true);
    assert.match(result.content[0].text, /safe/);
    assert.equal('block' in hook({ toolName: 'read_directory', input: { path: parent } }), true);
    for (const toolName of ['shell_command', 'write_file', 'read_file', 'grep', 'glob'])
      assert.equal('block' in hook({ toolName, input: {} }), true);
  } finally {
    if (previous === undefined) delete process.env.JBOT_COMMANDCODE_WORKSPACE;
    else process.env.JBOT_COMMANDCODE_WORKSPACE = previous;
    rmSync(parent, { recursive: true, force: true });
  }
});

it('searches and lists the actual worktree without following symlinks or running fsmonitor', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'jbot-cc-search-'));
  const root = join(parent, 'repo');
  const outside = join(parent, 'outside');
  mkdirSync(root);
  mkdirSync(outside);
  const previous = process.env.JBOT_COMMANDCODE_WORKSPACE;
  const tools: Parameters<ModApi['addTool']>[0][] = [];
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
  try {
    writeFileSync(join(root, 'inside.ts'), 'needle\n');
    writeFileSync(join(outside, 'secret.ts'), 'OUTSIDE_SECRET_CANARY\n');
    symlinkSync(join(outside, 'secret.ts'), join(root, 'escape.ts'));
    mkdirSync(join(root, 'replaced'));
    writeFileSync(join(root, 'replaced', 'secret.ts'), 'safe');
    writeFileSync(join(root, 'ignored.ts'), 'needle\n');
    git('init', '-q');
    git('add', '.');
    rmSync(join(root, 'replaced'), { recursive: true });
    symlinkSync(outside, join(root, 'replaced'));
    writeFileSync(join(root, 'untracked.ts'), 'needle\n');
    writeFileSync(join(root, '.gitignore'), 'ignored.ts\n');
    git('config', 'core.worktree', outside);
    git('config', 'core.fsmonitor', `touch ${join(parent, 'executed')}`);
    process.env.JBOT_COMMANDCODE_WORKSPACE = root;
    commandCodeReviewMod({
      setActiveTools() {},
      hooks() {},
      addTool(tool) {
        tools.push(tool);
      },
    });
    for (const tool of tools) assert.ok(Array.isArray(tool.schema.input_schema.required));
    const search = tools.find((t) => t.schema.name === 'jbot_search')!;
    for (const input of [{}, { query: '' }]) {
      const invalid = await search.run({ input });
      assert.equal(invalid.ok, false);
      assert.match(invalid.error, /query must be nonempty/);
    }
    const found = await search.run({ input: { query: 'needle' } });
    assert.equal(found.ok, true);
    assert.match(found.content[0].text, /inside.ts:1:needle/);
    assert.match(found.content[0].text, /untracked.ts:1:needle/);
    assert.doesNotMatch(found.content[0].text, /ignored.ts/);
    const tracked = await tools
      .find((t) => t.schema.name === 'jbot_read_file')!
      .run({ input: { path: 'ignored.ts' } });
    assert.equal(tracked.ok, true);
    assert.match(tracked.content[0].text, /needle/);
    const escaped = await search.run({ input: { query: 'OUTSIDE_SECRET_CANARY' } });
    assert.equal(escaped.ok, true);
    assert.equal(escaped.content[0].text, '(no matches)');
    const list = await tools.find((t) => t.schema.name === 'jbot_list_files')!.run({ input: {} });
    assert.equal(list.ok, true);
    assert.match(list.content[0].text, /inside.ts/);
    assert.equal(existsSync(join(parent, 'executed')), false);
  } finally {
    if (previous === undefined) delete process.env.JBOT_COMMANDCODE_WORKSPACE;
    else process.env.JBOT_COMMANDCODE_WORKSPACE = previous;
    rmSync(parent, { recursive: true, force: true });
  }
});

it('stops the process if the trusted mod cannot initialize', () => {
  const home = mkdtempSync(join(tmpdir(), 'jbot-cc-loader-'));
  try {
    writeCommandCodeReadOnlySettings(home, true);
    const child = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `const m = await import(${JSON.stringify(join(home, 'review.mjs'))}); await m.default({}); console.log('unguarded');`,
      ],
      {
        env: { ...commandCodeEnvForHome(home), JBOT_COMMANDCODE_WORKSPACE: join(home, 'missing') },
        encoding: 'utf8',
      },
    );
    assert.equal(child.status, 1);
    assert.equal(child.stdout, '');
    assert.match(child.stderr, /failed to initialize/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
