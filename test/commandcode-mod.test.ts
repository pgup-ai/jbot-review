import assert from 'node:assert/strict';
import childProcess, { execFileSync, spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import commandCodeReviewMod from '../src/shared/commandcode-mod.ts';
import {
  commandCodeEnvForHome,
  writeCommandCodeReadOnlySettings,
} from '../src/shared/commandcode.ts';

type ModApi = Parameters<typeof commandCodeReviewMod>[0];

it('reads literal bracketed filenames while refusing escapes and non-file reads', async (t) => {
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
    const reading = read.run({ input: { path: '[id].ts' } });
    renameSync(join(root, '[id].ts'), join(root, 'original.ts'));
    symlinkSync(join(parent, 'outside.ts'), join(root, '[id].ts'));
    const replaced = await reading;
    assert.equal(replaced.ok, true);
    assert.match(replaced.content[0].text, /safe/);
    assert.doesNotMatch(replaced.content[0].text, /outside/);
    writeFileSync(join(root, '.gitignore'), '.env\nracy.ts\n');
    writeFileSync(join(root, 'racy.ts'), 'IGNORED_SECRET');
    const spawn = childProcess.spawnSync;
    let swapped = false;
    const replacement = t.mock.method(childProcess, 'spawnSync', ((
      ...args: Parameters<typeof spawn>
    ) => {
      if (!swapped && args[1]?.includes('check-ignore') && args[1]?.includes('racy.ts')) {
        swapped = true;
        renameSync(join(root, 'racy.ts'), join(root, '.env'));
        writeFileSync(join(root, 'racy.ts'), 'safe replacement');
        execFileSync('git', ['-C', root, 'add', '-f', 'racy.ts']);
      }
      return spawn(...args);
    }) as typeof spawn);
    syncBuiltinESMExports();
    try {
      const raced = await read.run({ input: { path: 'racy.ts' } });
      assert.equal(raced.ok, true);
      assert.match(raced.content[0].text, /safe replacement/);
      assert.doesNotMatch(raced.content[0].text, /IGNORED_SECRET/);
    } finally {
      replacement.mock.restore();
      syncBuiltinESMExports();
    }
    rmSync(join(root, '.git'), { recursive: true });
    const gitFailed = await read.run({ input: { path: 'original.ts' } });
    assert.equal(gitFailed.ok, false);
    assert.equal(gitFailed.error, 'Cannot validate repository file visibility.');
    assert.equal('block' in hook({ toolName: 'read_directory', input: { path: parent } }), true);
    for (const toolName of ['shell_command', 'write_file', 'read_file', 'grep', 'glob'])
      assert.equal('block' in hook({ toolName, input: {} }), true);
  } finally {
    if (previous === undefined) delete process.env.JBOT_COMMANDCODE_WORKSPACE;
    else process.env.JBOT_COMMANDCODE_WORKSPACE = previous;
    rmSync(parent, { recursive: true, force: true });
  }
});

it('reads a foreign-owned worktree without following escapes or running fsmonitor', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'jbot-cc-search-'));
  const root = join(parent, 'repo');
  const outside = join(parent, 'outside');
  mkdirSync(root);
  mkdirSync(outside);
  const previous = process.env.JBOT_COMMANDCODE_WORKSPACE;
  const gitEnv = {
    GIT_TEST_ASSUME_DIFFERENT_OWNER: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  const previousGitEnv = Object.fromEntries(
    Object.keys(gitEnv).map((key) => [key, process.env[key]]),
  );
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
    const nested = join(root, 'nested');
    mkdirSync(nested);
    execFileSync('git', ['-C', nested, 'init', '-q']);
    writeFileSync(join(nested, 'source.ts'), 'needle\n');
    writeFileSync(join(nested, '.gitignore'), '.env\n');
    writeFileSync(join(nested, '.env'), 'OUTSIDE_SECRET_CANARY');
    writeFileSync(join(nested, '.git', 'private'), 'OUTSIDE_SECRET_CANARY');
    git('config', 'core.worktree', outside);
    git('config', 'core.fsmonitor', `touch ${join(parent, 'executed')}`);
    Object.assign(process.env, gitEnv);
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
    assert.match(found.content[0].text, /nested\/source.ts:1:needle/);
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
    for (const [key, value] of Object.entries(previousGitEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
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
        `const m = await import(${JSON.stringify(join(home, 'review.mjs'))}); await m.default({setActiveTools(){}, hooks(){}, addTool(){}}); console.log('unguarded');`,
      ],
      {
        env: { ...commandCodeEnvForHome(home), JBOT_COMMANDCODE_WORKSPACE: home },
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
