import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { reviewRetrievalTool, installReviewRetrieval } from '../src/shared/review-retrieval.ts';
import {
  explorationCheckpoint,
  readExplorationStats,
  explorationExperiment,
} from '../src/shared/exploration-policy.ts';
import { evidenceHash } from '../src/shared/evidence-cache.ts';

const zero = { requests: 0, outputBytes: 0, repeatedResults: 0 };

test('checkpoints react to new pressure and leave a two-request runway after a checkpoint', () => {
  assert.equal(explorationCheckpoint({ ...zero, requests: 7 }, zero), undefined);
  assert.equal(explorationCheckpoint({ ...zero, requests: 8 }, zero), 'turns');
  const large = { requests: 2, outputBytes: 32768, repeatedResults: 0 };
  assert.equal(explorationCheckpoint(large, zero), 'bytes');
  assert.equal(
    explorationCheckpoint({ ...large, requests: 3, outputBytes: 70000 }, large),
    undefined,
  );
  assert.equal(
    explorationCheckpoint({ ...large, requests: 4, repeatedResults: 2 }, large),
    'repetition',
  );
  assert.deepEqual(explorationExperiment({}), { retrieval: false, checkpoints: false });
  assert.equal(readExplorationStats({ checkpoints: 'secret' }), undefined);
});

test('retrieval batches linked callers and imports, refreshes sources, and excludes symlinks and untracked files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'retrieval-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  await writeFile(
    join(root, 'value.ts'),
    "import { rate } from './rate.js';\nexport function total(n: number) { return n * rate; }\n",
  );
  await writeFile(join(root, 'rate.ts'), 'export const rate = 100;\n');
  await writeFile(
    join(root, 'caller.test.ts'),
    "import { total as amount } from './value.js';\nif (amount(2) !== 200) throw Error('wrong');\n",
  );
  execFileSync('git', ['add', '.'], { cwd: root });
  await writeFile(join(root, 'secret.ts'), 'DO_NOT_EXPOSE');
  await symlink('secret.ts', join(root, 'link.ts'));
  execFileSync('git', ['add', 'link.ts'], { cwd: root });
  const tool = reviewRetrievalTool(root);
  assert.equal(tool.options.codemode, false);
  const first = await tool.execute({ path: 'value.ts', line: 2 });
  for (const path of ['value.ts', 'rate.ts', 'caller.test.ts'])
    assert.ok(first.content.includes(path), first.content);
  assert.ok(Buffer.byteLength(first.content) < 7000);
  assert.ok(first.metadata?.jbotRetrieval.selected);
  await writeFile(join(root, 'rate.ts'), 'export const rate = 777;\n');
  assert.ok((await tool.execute({ path: 'value.ts', line: 2 })).content.includes('777'));
  for (const path of ['secret.ts', 'link.ts', '../secret.ts', '/etc/passwd']) {
    const result = await tool.execute({ path, line: 1 });
    assert.ok(!result.content.includes('DO_NOT_EXPOSE'));
    assert.equal(result.metadata?.jbotRetrieval.selected, 0);
  }
  assert.ok(!(await tool.execute({ path: 'value.ts', line: -1 })).metadata);
});

test('plugin checkpoint hooks preserve tool access, skip tool-less agents, and persist only counters', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'checkpoint-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let onContext: Parameters<
    Parameters<typeof installReviewRetrieval>[0]['session']['hook']
  >[1] = () => {};
  let onTool: Parameters<
    Parameters<typeof installReviewRetrieval>[0]['tool']['hook']
  >[1] = () => {};
  await installReviewRetrieval(
    {
      session: {
        hook: async (_name, fn) => {
          onContext = fn;
        },
      },
      tool: {
        transform: async () => assert.fail('retrieval disabled'),
        hook: async (_name, fn) => {
          onTool = fn;
        },
      },
    },
    directory,
    directory,
    { retrieval: false, checkpoints: true },
  );
  const event = () => ({
    sessionID: 'session',
    agent: 'plan',
    system: [] as { type: string; text: string }[],
  });
  for (let i = 0; i < 7; i++) {
    const e = event();
    onContext(e);
    assert.equal(e.system.length, 0);
  }
  const e = event();
  onContext(e);
  assert.equal(e.system.length, 1);
  const wrap = { ...event(), agent: 'jbot-wrapup' };
  onContext(wrap);
  assert.equal(wrap.system.length, 0);
  onTool({
    sessionID: 'session',
    tool: 'read',
    status: 'completed',
    result: { content: 'sensitive source' },
  });
  const raw = await readFile(
    join(directory, `exploration-${evidenceHash('session')}.json`),
    'utf8',
  );
  assert.ok(!raw.includes('sensitive'));
  assert.equal(readExplorationStats(JSON.parse(raw))?.turnCheckpoints, 1);
});
