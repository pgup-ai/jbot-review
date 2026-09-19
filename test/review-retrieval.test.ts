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
  selectReadEvidence,
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
  assert.deepEqual(explorationExperiment({}), {
    retrieval: false,
    checkpoints: false,
    readEvidence: false,
  });
  assert.equal(readExplorationStats({ checkpoints: 'secret' }), undefined);
  assert.equal(explorationExperiment({ JBOT_READ_EVIDENCE: 'linked' }).readEvidence, 'linked');
});

test('linked selection excludes the seed, known paths and unbound matches before reserving two files', () => {
  const candidate = (path: string, relatedTo?: string) => ({
    path,
    relatedTo,
    line: 1,
    symbol: 'total',
    text: 'source',
    completeFile: true,
  });
  const candidates = [
    candidate('value.ts', 'value.ts'),
    candidate('name-match.ts'),
    candidate('seen.ts', 'value.ts'),
    candidate('rate.ts', 'value.ts'),
    candidate('rate.ts', 'value.ts'),
    candidate('caller.ts', 'value.ts'),
    candidate('third.ts', 'value.ts'),
  ];
  assert.deepEqual(
    selectReadEvidence(candidates, 'value.ts', new Set(['seen.ts'])).map((c) => c.path),
    ['rate.ts', 'caller.ts'],
  );
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

test('read evidence preserves results and failures while bounding concurrent delivery per session', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'read-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  for (const path of ['a.ts', 'b.ts', 'c.ts'])
    await writeFile(join(root, path), 'export const value = 123;\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  let onTool: Parameters<
    Parameters<typeof installReviewRetrieval>[0]['tool']['hook']
  >[1] = () => {};
  await installReviewRetrieval(
    {
      session: { hook: async () => {} },
      tool: {
        transform: async () => assert.fail('no extra tool needed'),
        hook: async (_name, fn) => {
          onTool = fn;
        },
      },
    },
    root,
    root,
    { retrieval: false, checkpoints: false, readEvidence: true },
  );
  const event = (path: string, sessionID = 'review') => ({
    sessionID,
    agent: 'plan',
    tool: 'read',
    status: 'completed',
    input: { path },
    result: { content: [{ type: 'text', text: 'original' }], metadata: { original: true } },
  });
  const failed = { ...event('a.ts'), status: 'error' };
  const wrap = { ...event('a.ts'), agent: 'jbot-wrapup' };
  await onTool(failed);
  await onTool(wrap);
  assert.equal(failed.result.content.length, 1);
  assert.equal(wrap.result.content.length, 1);
  const events = ['a.ts', 'b.ts', 'c.ts'].map((p) => event(p));
  await Promise.all(events.map((e) => onTool(e)));
  assert.deepEqual(
    events.map((e) => e.result.content.length),
    [2, 2, 1],
  );
  for (const e of events) {
    assert.deepEqual(e.result.content[0], { type: 'text', text: 'original' });
    assert.deepEqual(e.result.metadata, { original: true });
  }
  const stats = readExplorationStats(
    JSON.parse(await readFile(join(root, `exploration-${evidenceHash('review')}.json`), 'utf8')),
  )!;
  assert.equal(stats.readEvidenceAttempts, 2);
  assert.equal(stats.readEvidencePackets, 2);
  assert.ok(stats.readEvidenceBytes > 0 && stats.readEvidenceBytes <= 14000);
  const untracked = event('secret.ts', 'other');
  await writeFile(join(root, 'secret.ts'), 'UNTRACKED_SECRET');
  await onTool(untracked);
  await onTool(untracked);
  assert.equal(untracked.result.content.length, 1);
  const other = readExplorationStats(
    JSON.parse(await readFile(join(root, `exploration-${evidenceHash('other')}.json`), 'utf8')),
  )!;
  assert.equal(other.readEvidenceAttempts, 1);
  assert.equal(other.readEvidenceFallbacks, 1);
});

test('linked packets exclude concurrent reads and prior delivery while reporting subsequent requests', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'linked-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  for (const [path, text] of Object.entries({
    'a.ts':
      "import { rate } from './b.js';\nexport function total(n: number) { return n * rate; }\n",
    'b.ts': 'export const rate = 137;\n',
    'c.ts': "import { total } from './a.js';\nexport const charge = total(2);\n",
    'd.ts': "import { rate } from './b.js';\nexport const discount = rate / 2;\n",
    'noise.ts': 'export const total = 42;\n',
  }))
    await writeFile(join(root, path), text);
  execFileSync('git', ['add', '.'], { cwd: root });
  let onTool: Parameters<
    Parameters<typeof installReviewRetrieval>[0]['tool']['hook']
  >[1] = () => {};
  let onContext: Parameters<
    Parameters<typeof installReviewRetrieval>[0]['session']['hook']
  >[1] = () => {};
  await installReviewRetrieval(
    {
      session: {
        hook: async (_, fn) => {
          onContext = fn;
        },
      },
      tool: {
        transform: async () => assert.fail('no new tool'),
        hook: async (_, fn) => {
          onTool = fn;
        },
      },
    },
    root,
    root,
    { retrieval: false, checkpoints: false, readEvidence: 'linked' },
  );
  const event = (path: string) => ({
    sessionID: 'review',
    agent: 'plan',
    tool: 'read',
    status: 'completed',
    input: { path },
    result: { content: 'original', metadata: { original: true } },
  });
  const first = event('a.ts'),
    concurrent = event('d.ts');
  await Promise.all([onTool(first), onTool(concurrent)]);
  assert.match(first.result.content, /### b.ts:/);
  assert.match(first.result.content, /### c.ts:/);
  for (const path of ['a.ts', 'd.ts', 'noise.ts'])
    assert.ok(!first.result.content.includes(`### ${path}:`));
  assert.equal(concurrent.result.content, 'original');
  assert.deepEqual(first.result.metadata, { original: true });
  await onTool(event('b.ts'));
  onContext({ sessionID: 'review', agent: 'plan', system: [] });
  await onTool(event('b.ts'));
  await onTool({ ...event('a.ts'), tool: 'shell', input: { command: 'cat $(pwd)/secret.ts' } });
  const raw = await readFile(join(root, `exploration-${evidenceHash('review')}.json`), 'utf8');
  const stats = readExplorationStats(JSON.parse(raw))!;
  assert.equal(stats.readEvidenceAttempts, 2);
  assert.equal(stats.readEvidencePackets, 1);
  assert.equal(stats.readEvidenceDeliveredFiles, 2);
  assert.equal(stats.readEvidenceObservedReads, 4);
  assert.equal(stats.readEvidenceSubsequentReads, 1);
  assert.equal(stats.readEvidenceUnclassifiedShellCalls, 1);
  assert.equal(stats.readEvidenceEmptyPackets, 1);
  assert.equal(stats.readEvidenceFallbacks, 0);
  assert.ok(stats.readEvidenceExcludedCandidates > 0);
  assert.doesNotMatch(raw, /a.ts|b.ts|secret/);
});
