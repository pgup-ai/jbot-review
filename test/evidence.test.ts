import { reviewExperiment } from '../src/shared/review-experiment.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import {
  mkdir,
  mkdtemp,
  writeFile,
  rm,
  symlink,
  readFile,
  readdir,
  utimes,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  EvidenceStore,
  indexEvidenceSource,
  changedEvidenceLines,
  resolveEvidenceImport,
  evidenceMode,
  parseTsconfigPaths,
} from '../src/shared/evidence.ts';
import { normalizeOptions, requestFindingVerdicts } from '../src/shared/runner.ts';
import { EvidenceDiskCache, evidenceHash } from '../src/shared/evidence-cache.ts';
import { JEV_MODEL } from '../src/shared/prompt.ts';

const files = [
  {
    filename: 'money.ts',
    status: 'modified',
    additions: 1,
    deletions: 1,
    changes: 2,
    patch:
      '@@ -1,3 +1,3 @@\n export function total(n: number) {\n-  return n;\n+  return n * 100;\n }',
  },
];
const finding = {
  path: 'money.ts',
  line: 2,
  severity: 'P2',
  confidence: 'high',
  title: 'Double conversion',
  body: 'consumer.ts:2 multiplies the already converted total.',
};

test('syntax collection finds body-only changes and named import aliases without executing source', () => {
  const source = indexEvidenceSource(
    'money.TS',
    'export function total(n: number) {\nreturn n * 100;\n}\nthrow new Error("never executed");',
  );
  assert.deepEqual(changedEvidenceLines(files[0].patch), [2]);
  assert.ok(source.definitions.some((d) => d.symbol === 'total' && d.start === 1 && d.end === 3));
  const consumer = indexEvidenceSource(
    'consumer.ts',
    "import { total as amount } from './money.js';\namount(1); // total is only a comment here",
  );
  assert.deepEqual(consumer.imports, [
    { local: 'amount', imported: 'total', from: './money.js', line: 1 },
  ]);
  assert.deepEqual(
    consumer.uses.filter((u) => u.symbol === 'amount'),
    [{ symbol: 'amount', line: 2 }],
  );
  assert.equal(
    resolveEvidenceImport('consumer.ts', './money.js', new Set(['money.ts'])),
    'money.ts',
  );
  assert.equal(
    resolveEvidenceImport('consumer.ts', 'third-party/money', new Set(['money.ts'])),
    undefined,
  );
  assert.equal(evidenceMode('oops'), 'off');
  assert.equal(
    normalizeOptions({
      experiment: {
        ...reviewExperiment({}),
        preset: 'custom',
        verificationEvidence: 'deterministic',
      },
    }).experiment.verificationEvidence,
    'deterministic',
  );
});

test('retrieves unchanged callers of an unchanged export when an internal implementation changes', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'caller-evidence-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', workspace]);
  await writeFile(
    join(workspace, 'engine.ts'),
    'function internal() {\nreturn 2;\n}\nexport function review(options: unknown) { return internal(); }\n',
  );
  await writeFile(
    join(workspace, 'worker.ts'),
    [
      "import { review as run } from './engine.js';",
      ...Array.from(
        { length: 40 },
        () => '// Other worker setup outside the call-site evidence window.',
      ),
      'run({',
      ...Array.from({ length: 20 }, (_, i) => `  setting${i}: true,`),
      '  reviewShards: 1,',
      '});',
    ].join('\n'),
  );
  await writeFile(
    join(workspace, 'unrelated.ts'),
    "import { review as run } from './another-engine.js';\nrun({ WRONG_BINDING: true });",
  );
  execFileSync('git', ['add', '.'], { cwd: workspace });
  // A developer's global color.ui=always must not corrupt the parsed paths.
  execFileSync('git', ['config', 'color.ui', 'always'], { cwd: workspace });
  const store = new EvidenceStore(workspace, [
    {
      filename: 'engine.ts',
      patch: '@@ -1,3 +1,3 @@\n function internal() {\n-return 1;\n+return 2;\n }',
    },
  ]);
  const evidence = await store.prepare('exploration', [], 'deterministic', {
    locations: [{ path: 'engine.ts', line: 2 }],
    timeoutMs: 4000,
    log: () => {},
    onStats: () => {},
  });
  assert.match(evidence, /worker.ts/);
  assert.match(evidence, /reviewShards: 1/);
  assert.match(evidence, /import-linked reference/);
  assert.doesNotMatch(evidence, /WRONG_BINDING/);
});

test('verification supplies distant imports and option-normalization definitions', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'verification-bindings-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', workspace]);
  const source = [
    "import { pathToFileURL } from 'node:url';",
    ...Array(40).fill(''),
    'function normalizeOptions(input) { return { experiment: input?.experiment ?? { enabled: true } }; }',
    ...Array(40).fill(''),
    'export function run(input) {',
    '  const options = normalizeOptions(input);',
    ...Array(40).fill(''),
    '  return [pathToFileURL("test"), options.experiment.enabled];',
    '}',
  ];
  await writeFile(join(workspace, 'entry.ts'), source.join('\n'));
  execFileSync('git', ['add', '.'], { cwd: workspace });
  const store = new EvidenceStore(workspace, []);
  const context = await store.sourceContext([
    {
      ...finding,
      path: 'entry.ts',
      line: source.length - 1,
      title: '`pathToFileURL` is missing and `options.experiment` has no default',
      body: 'Verify the import and initialization.',
    },
  ]);
  assert.match(context, /import \{ pathToFileURL \} from 'node:url'/);
  assert.match(context, /const options = normalizeOptions\(input\)/);
  assert.match(context, /experiment: input\?\.experiment \?\? \{ enabled: true \}/);
});

test('prepared arms share candidates, reuse hashes across phases, and invalidate changed source', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'evidence-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', workspace]);
  await writeFile(
    join(workspace, 'money.ts'),
    'export function total(n: number) {\nreturn n * 100;\n}\n',
  );
  await writeFile(
    join(workspace, 'consumer.ts'),
    "import { total as amount } from './money.js';\nexport const charge = amount(1) * 100;\n",
  );
  await writeFile(
    join(workspace, 'unrelated.ts'),
    "import { total as amount } from 'other-package';\namount(1);\n",
  );
  await writeFile(join(workspace, 'CONTRACT.PY'), 'total_unit = "cents"\n');
  execFileSync('git', ['add', '.'], { cwd: workspace });
  await writeFile(join(workspace, 'secret.ts'), 'DO_NOT_READ_SECRET');
  await symlink('secret.ts', join(workspace, 'link.ts'));
  execFileSync('git', ['add', 'link.ts'], { cwd: workspace });
  const docs = join(workspace, 'docs.json');
  await writeFile(
    docs,
    JSON.stringify([
      {
        url: 'https://docs.example.com/contract',
        version: 'v1',
        retrievedAt: '2026-09-19',
        text: 'Totals are cents.',
      },
    ]),
  );
  const rows = [];
  const fetch = t.mock.method(globalThis, 'fetch', async (_, init) => {
    const body = JSON.parse(init.body);
    assert.ok(Buffer.byteLength(init.body) <= 30000);
    assert.ok(body.state.task);
    assert.ok(!JSON.stringify(body).includes('DO_NOT_READ_SECRET'));
    return Response.json({
      model: JEV_MODEL,
      answers: Object.fromEntries(
        Object.keys(body.questions).map((k) => [k, { type: 'noul', noul: 0.9 }]),
      ),
      usage: { input_tokens: 100, output_tokens: 5 },
    });
  });
  const store = new EvidenceStore(workspace, files, docs);
  const options = { timeoutMs: 5000, log: () => {}, onStats: (row) => rows.push(row) };
  assert.equal(await store.prepare('exploration', [], 'off', options), '');
  const control = await store.prepare('exploration', [], 'deterministic', options);
  assert.equal(fetch.mock.callCount(), 0);
  assert.match(control, /consumer.ts/);
  assert.match(control, /import-linked reference/);
  assert.doesNotMatch(control, /DO_NOT_READ_SECRET/);
  const ranked = await store.prepare('exploration', [], 'on', { ...options, apiKey: 'TEST_ONLY' });
  assert.equal(rows[0].candidateHash, rows[1].candidateHash);
  assert.ok(rows[1].cacheHits >= 2);
  assert.ok(Buffer.byteLength(ranked) < 6800);
  const verification = await store.prepare('verification', [finding], 'deterministic', options);
  assert.match(verification, /docs.example.com/);
  assert.match(verification, /sha256=/);
  assert.ok(rows[2].cacheHits >= 2);
  await writeFile(
    join(workspace, 'consumer.ts'),
    "import { total as amount } from './money.js';\nexport const charge = amount(1);\n",
  );
  const updated = await store.prepare('verification', [finding], 'deterministic', options);
  assert.notEqual(rows[2].candidateHash, rows[3].candidateHash);
  assert.doesNotMatch(updated, /charge = amount\(1\) \* 100/);
  assert.equal(fetch.mock.callCount(), 1);
  const contract = await store.prepare(
    'verification',
    [{ ...finding, path: 'CONTRACT.PY', line: 1, body: '' }],
    'deterministic',
    options,
  );
  assert.match(contract, /total_unit = "cents"/);
});

test('source exceeding the remaining admission budget is not indexed or persisted', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'evidence-budget-'));
  const cacheDir = await mkdtemp(join(tmpdir(), 'evidence-budget-cache-'));
  t.after(() =>
    Promise.all([workspace, cacheDir].map((p) => rm(p, { recursive: true, force: true }))),
  );
  execFileSync('git', ['init', '-q', workspace]);
  const largeFiles = Array.from({ length: 9 }, (_, i) => ({
    ...files[0],
    filename: `source-${i}.ts`,
  }));
  for (const file of largeFiles)
    await writeFile(
      join(workspace, file.filename),
      'export function total(n: number) {\nreturn n * 100;\n}\n/*' +
        ' '.repeat(250 * 1024) +
        '*/\n',
    );
  execFileSync('git', ['add', '.'], { cwd: workspace });
  const store = new EvidenceStore(workspace, largeFiles, undefined, {
    shared: true,
    handoff: false,
    prefetch: false,
    cacheDir,
  });
  const rows = [];
  await store.prepare('exploration', [], 'deterministic', {
    timeoutMs: 4000,
    log: () => {},
    onStats: (s) => rows.push(s),
  });
  assert.equal(rows[0].status, 'applied');
  assert.equal(rows[0].omittedFiles, 1);
  assert.equal(store.stats().diskWrites, 8);
});

test('invalid docs preserve source evidence and timeouts fail open without leaking error text', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'evidence-failure-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', workspace]);
  await writeFile(join(workspace, 'money.ts'), 'export function total(n) {\nreturn n * 100;\n}');
  execFileSync('git', ['add', 'money.ts'], { cwd: workspace });
  const docs = join(workspace, 'docs.json');
  const rows = [],
    logs = [];
  const store = new EvidenceStore(workspace, files, docs);
  const options = { timeoutMs: 5000, log: (s) => logs.push(s), onStats: (s) => rows.push(s) };
  for (const invalid of ['x'.repeat(70000), '{"private":']) {
    await writeFile(docs, invalid);
    const packet = await store.prepare('verification', [finding], 'deterministic', options);
    assert.match(packet, /export function total/);
    assert.equal(rows.at(-1).status, 'applied');
    assert.equal(rows.at(-1).scope, 'verification');
    assert.equal(rows.at(-1).model, null);
    assert.equal(rows.at(-1).apiMs, 0);
    assert.equal(rows.at(-1).inputTokens, undefined);
  }
  assert.equal(
    await store.prepare('exploration', [], 'deterministic', { ...options, timeoutMs: 0 }),
    '',
  );
  assert.equal(rows.at(-1).status, 'fallback');
  assert.equal(rows.at(-1).model, null);
  assert.match(logs.join('\n'), /Optional documentation unavailable/);
  assert.doesNotMatch(logs.join('\n'), /x{50}|private/);
});

test('failed or budget-starved evidence preparation cannot skip independent verification', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'evidence-verdict-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', workspace]);
  let calls = 0;
  const params = {
    workspace,
    model: 'opencode/test',
    prContext: 'full diff',
    targets: [finding],
    log: () => {},
    prepareEvidence: async () => {
      throw new Error('unavailable');
    },
    backend: {
      runFindingVerification: async (_, context, targets) => {
        calls++;
        assert.match(context, /full diff/);
        assert.equal(targets.length, 1);
        return [{ index: 0, verdict: 'confirmed', reason: 'actual trigger' }];
      },
    },
  };
  const verdicts = await requestFindingVerdicts(params);
  assert.equal(calls, 1);
  assert.equal(verdicts[0].verdict, 'confirmed');
  let prepared = false;
  const tight = await requestFindingVerdicts({
    ...params,
    timeoutMs: 5000,
    prepareEvidence: async () => {
      prepared = true;
      return '';
    },
  });
  assert.equal(prepared, false);
  assert.equal(calls, 2);
  assert.equal(tight[0].verdict, 'confirmed');
});

test('shared reads preserve packets, invalidate same-size edits, and reject removed tracking and symlinks', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'evidence-shared-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', workspace]);
  const path = join(workspace, 'money.ts');
  await writeFile(path, 'export function total(n: number) {\nreturn n * 100;\n}\n');
  execFileSync('git', ['add', '.'], { cwd: workspace });
  const options = { timeoutMs: 5000, log: () => {}, onStats: () => {} };
  const baseline = new EvidenceStore(workspace, files);
  const unused = new EvidenceStore(workspace, files, undefined, {
    shared: false,
    handoff: false,
    prefetch: true,
  });
  await unused.warm(options);
  assert.equal(unused.stats().inventoryReads, 0);
  assert.equal(unused.stats().prefetchStatus, 'disabled');
  const store = new EvidenceStore(workspace, files, undefined, {
    shared: true,
    handoff: false,
    prefetch: true,
  });
  const logs = [];
  const warming = store.warm({ ...options, log: (line) => logs.push(line) });
  assert.equal(store.stats().prefetchStatus, 'running');
  await warming;
  const logged = JSON.parse(logs[0].slice('Evidence preparation: '.length));
  assert.equal(logged.speculative, true);
  assert.equal(logged.injectedBytes, 0);
  assert.equal(logged.coverageBytes, 0);
  const [first, second] = await Promise.all([
    store.sourceContext([finding]),
    store.sourceContext([finding]),
  ]);
  assert.equal(first, second);
  assert.ok(store.stats().sharedRequests > 0);
  assert.equal(store.stats().prefetchedFiles, 1);
  assert.match(await store.sourceContext([finding]), /n \* 100/);
  assert.equal(
    await store.prepare('verification', [finding], 'deterministic', options),
    await baseline.prepare('verification', [finding], 'deterministic', options),
  );
  assert.equal(store.stats().sourceReads, 1);
  assert.ok(store.stats().sourceHits >= 2);
  assert.equal(store.stats().reusedPrefetchedFiles, 1);
  await writeFile(path, 'export function total(n: number) {\nreturn n * 200;\n}\n');
  assert.match(await store.sourceContext([finding]), /n \* 200/);
  assert.equal(store.stats().sourceReads, 2);
  execFileSync('git', ['rm', '--cached', '-f', 'money.ts'], { cwd: workspace });
  assert.doesNotMatch(await store.sourceContext([finding]), /n \* 200/);
  await rm(path);
  await writeFile(join(workspace, 'secret.ts'), 'DO_NOT_READ_SECRET');
  await symlink('secret.ts', path);
  execFileSync('git', ['add', 'money.ts'], { cwd: workspace });
  assert.doesNotMatch(await store.sourceContext([finding]), /DO_NOT_READ_SECRET/);
});

test('handoff reloads bounded review read locations without executing shell or carrying conclusions', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'evidence-handoff-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', workspace]);
  await writeFile(join(workspace, 'guard.ts'), 'export const approvalRequired = true;');
  execFileSync('git', ['add', '.'], { cwd: workspace });
  const store = new EvidenceStore(workspace, [], undefined, {
    shared: true,
    handoff: true,
    prefetch: false,
  });
  store.observe('shell', { command: `cd ${workspace} && sed -n '1,20p' guard.ts` });
  store.observe('shell', { command: 'cat $(pwd)/secret.ts', path: 'secret.ts' });
  store.observe('read', { path: '../secret.ts' });
  assert.equal(store.stats().observedLocations, 1);
  const rows = [];
  const packet = await store.prepare('verification', [finding], 'deterministic', {
    timeoutMs: 5000,
    log: () => {},
    onStats: (row) => rows.push(row),
  });
  assert.equal(rows[0].selectedReadLocations, 1);
  assert.match(packet, /guard.ts/);
  assert.match(packet, /revalidated review read/);
  assert.match(packet, /approvalRequired = true/);
  assert.equal(store.stats().handoffCandidates, 1);
});

test(
  'an expired evidence caller releases its wait without cancelling shared reads',
  { timeout: 5000 },
  async (t) => {
    const workspace = await mkdtemp(join(tmpdir(), 'evidence-cancellation-'));
    t.after(() => rm(workspace, { recursive: true, force: true }));
    execFileSync('git', ['init', '-q', workspace]);
    await writeFile(
      join(workspace, 'money.ts'),
      'export function total(n: number) {\nreturn n * 100;\n}\n',
    );
    execFileSync('git', ['add', '.'], { cwd: workspace });
    let entered!: () => void, release!: () => void;
    const reading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const open = fs.open;
    t.mock.method(fs, 'open', async (...args) => {
      const handle = await open(...args);
      const stat = handle.stat.bind(handle);
      handle.stat = async (...statArgs) => {
        entered();
        await gate;
        return stat(...statArgs);
      };
      return handle;
    });
    syncBuiltinESMExports();
    t.after(() => {
      release();
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });
    const caller = new AbortController();
    const timeout = AbortSignal.timeout;
    let first = true;
    t.mock.method(AbortSignal, 'timeout', (ms) => {
      if (!first) return timeout(ms);
      first = false;
      return caller.signal;
    });
    const store = new EvidenceStore(workspace, files, undefined, {
      shared: true,
      handoff: false,
      prefetch: false,
    });
    const options = { timeoutMs: 4000, log: () => {}, onStats: () => {} };
    const expired = store.prepare('exploration', [], 'deterministic', options);
    await reading;
    const active = store.prepare('exploration', [], 'deterministic', options);
    caller.abort();
    assert.equal(await expired, '');
    release();
    assert.match(await active, /return n \* 100/);
    assert.equal(store.stats().sourceReads, 1);
  },
);

test('already-aborted evidence waits still handle shared process rejection', () => {
  execFileSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `
        import assert from 'node:assert/strict';
        import { EvidenceStore } from ${JSON.stringify(new URL('../src/shared/evidence.ts', import.meta.url).href)};
        AbortSignal.timeout = () => AbortSignal.abort(new Error('expired'));
        const store = new EvidenceStore(process.cwd(), [], undefined, {
          shared: true, handoff: false, prefetch: false,
        });
        assert.equal(await store.prepare('exploration', [], 'deterministic', {
          timeoutMs: 0, log: () => {}, onStats: () => {},
        }), '');
      `,
    ],
    { timeout: 5000, stdio: 'pipe' },
  );
});

test('persistent cache reuses indexes and exact judgments with zero rebilling; changes and corrupt entries miss', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'evidence-disk-source-'));
  const cacheDir = await mkdtemp(join(tmpdir(), 'evidence-disk-cache-'));
  t.after(() =>
    Promise.all([workspace, cacheDir].map((p) => rm(p, { recursive: true, force: true }))),
  );
  execFileSync('git', ['init', '-q', workspace]);
  await writeFile(
    join(workspace, 'money.ts'),
    'export function total(n: number) {\nreturn n * 100;\n}\n',
  );
  execFileSync('git', ['add', '.'], { cwd: workspace });
  const fetch = t.mock.method(globalThis, 'fetch', async (_, init) => {
    const body = JSON.parse(init.body);
    return Response.json({
      model: JEV_MODEL,
      answers: Object.fromEntries(
        Object.keys(body.questions).map((k) => [k, { type: 'noul', noul: 0.8 }]),
      ),
      usage: { input_tokens: 100, output_tokens: 5 },
    });
  });
  const reuse = { shared: true, handoff: false, prefetch: false, cacheDir };
  const rows = [];
  const options = {
    timeoutMs: 5000,
    apiKey: 'TEST_ONLY',
    log: () => {},
    onStats: (s) => rows.push(s),
  };
  const cold = new EvidenceStore(workspace, files, undefined, reuse);
  const packet = await cold.prepare('verification', [finding], 'on', options);
  const warm = new EvidenceStore(workspace, files, undefined, reuse);
  assert.equal(await warm.prepare('verification', [finding], 'on', options), packet);
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(warm.stats().indexDiskHits, 1);
  assert.equal(rows[1].judgmentCacheHit, true);
  assert.equal(rows[1].apiMs, 0);
  assert.equal(rows[1].estimatedCostUsd, 0);
  assert.deepEqual(rows[1].rawScores, rows[0].rawScores);
  const namespace = join(cacheDir, evidenceHash(workspace));
  const judgment = join(namespace, evidenceHash('jev-v1:' + rows[0].requestHash) + '.json');
  await writeFile(judgment, JSON.stringify({ model: 'other-model', answers: {} }));
  await warm.prepare('verification', [finding], 'on', options);
  assert.equal(fetch.mock.callCount(), 2);
  await warm.prepare(
    'verification',
    [{ ...finding, body: 'A different hypothesis' }],
    'on',
    options,
  );
  assert.equal(fetch.mock.callCount(), 3);
  await writeFile(
    join(workspace, 'money.ts'),
    'export function total(n: number) {\nreturn n;\n}\n',
  );
  const changed = await warm.prepare('verification', [finding], 'on', options);
  assert.doesNotMatch(changed, /n \* 100/);
  assert.equal(fetch.mock.callCount(), 4);
  assert.notEqual(rows[4].requestHash, rows[0].requestHash);
  const raw = await readFile(judgment, 'utf8');
  assert.doesNotMatch(raw, /TEST_ONLY|return n/);
  assert.ok((await readdir(namespace)).every((n) => n.endsWith('.json')));
  assert.equal(new EvidenceDiskCache(workspace, join(workspace, 'cache')).enabled, false);
  const disk = new EvidenceDiskCache(workspace, cacheDir);
  await utimes(judgment, new Date(0), new Date(0));
  assert.equal(await disk.get('jev-v1:' + rows[0].requestHash), undefined);
  await writeFile(judgment, '{broken');
  assert.equal(await disk.get('jev-v1:' + rows[0].requestHash), undefined);
  assert.equal(
    await new EvidenceDiskCache(cacheDir, cacheDir + '-other').get('jev-v1:' + rows[0].requestHash),
    undefined,
  );
});

test('indexes decorated NestJS sources and generic arrows in .ts files', () => {
  const service = indexEvidenceSource(
    'ledger.service.ts',
    [
      '@Injectable()',
      'export class LedgerService {',
      '  constructor(@Inject(TOKEN) private readonly repo: LedgerRepository) {}',
      // Quoted: with a parameter decorator in the file, neither decorator plugin parses a decorated [computed] key.
      "  @Transform(trim) 'status.in'?: string[];",
      '  post(id: string) {',
      '    return this.repo.save(id);',
      '  }',
      '}',
      'export const first = <T>(items: T[]) => items[0];',
    ].join('\n'),
  );
  assert.ok(service.definitions.some((d) => d.symbol === 'LedgerService'));
  assert.ok(service.definitions.some((d) => d.symbol === 'first'));
  assert.ok(service.uses.some((u) => u.symbol === 'repo' && u.line === 6));
  assert.ok(
    indexEvidenceSource('view.tsx', 'export const View = () => <div />;').definitions.length,
  );
  const dto = indexEvidenceSource(
    'query.dto.ts',
    "export class QueryDto {\n  @Transform(trim)\n  ['status.in']?: string[];\n}",
  );
  assert.ok(dto.definitions.some((d) => d.symbol === 'QueryDto'));
});

test('rich index records members, types, re-exports, injected services and this-member calls', () => {
  const text = [
    '@Injectable()',
    'export class LedgerService {',
    '  private readonly limit = 5;',
    '  constructor(private readonly repo: LedgerRepository, plain: number) {}',
    '  post(id: string) {',
    '    return [id].map((x) => this.repo.save(x));',
    '  }',
    '}',
    'export interface Entry { id: string }',
    "export { LedgerRepository as Repo } from './repo';",
    "export * from './types';",
    "export * as ns from './ns';",
    'const handlers = { run() { return 1; }, go: () => 2 };',
  ].join('\n');
  const index = indexEvidenceSource('ledger.service.ts', text, { rich: true });
  const declared = (symbol: string) => index.declarations.find((d) => d.symbol === symbol);
  assert.deepEqual(declared('LedgerService'), {
    symbol: 'LedgerService',
    start: 1,
    end: 8,
    kind: 'class',
  });
  assert.deepEqual(declared('post'), {
    symbol: 'post',
    start: 5,
    end: 7,
    kind: 'method',
    owner: 'LedgerService',
  });
  assert.deepEqual(
    ['limit', 'constructor', 'Entry', 'run', 'go', 'handlers'].map((s) => declared(s)?.kind),
    ['property', 'constructor', 'type', 'function', 'function', 'variable'],
  );
  assert.deepEqual(index.injected, [
    { owner: 'LedgerService', name: 'repo', type: 'LedgerRepository' },
  ]);
  assert.deepEqual(index.memberCalls, [
    { target: 'repo', member: 'save', line: 6 },
    { target: '', member: 'repo', line: 6 },
  ]);
  assert.deepEqual(index.callbacks, [{ start: 6, end: 6 }]);
  assert.deepEqual(index.reexports, [
    { exported: 'Repo', imported: 'LedgerRepository', from: './repo' },
    { exported: '*', imported: '*', from: './types' },
    { exported: 'ns', imported: '*', from: './ns' },
  ]);
  const outer = indexEvidenceSource(
    'outer.ts',
    'class Outer { make() { return class { run() {} }; } }',
    { rich: true },
  );
  assert.deepEqual(
    outer.declarations.map((d) => `${d.owner ?? ''}.${d.symbol}`),
    ['.Outer', 'Outer.make'],
  );
  const chained = indexEvidenceSource(
    'q.ts',
    [
      'class Q {',
      '  #repo: R;',
      '  run() {',
      '    return this.#repo',
      '      .find();',
      '  }',
      '  go() { return this.repo?.save(); }',
      '}',
    ].join('\n'),
    { rich: true },
  );
  assert.deepEqual(chained.memberCalls, [
    { target: 'repo', member: 'find', line: 5 },
    { target: '', member: 'repo', line: 4 },
    { target: 'repo', member: 'save', line: 7 },
    { target: '', member: 'repo', line: 7 },
  ]);
  assert.equal(
    indexEvidenceSource('h.ts', 'class H { handle = () => 1; }', { rich: true }).declarations.find(
      (d) => d.symbol === 'handle',
    )?.kind,
    'method',
  );
  const computedKey = indexEvidenceSource(
    'c.ts',
    'const KEY = "x"; class C { [KEY]() { return 1; } }',
    { rich: true },
  );
  assert.ok(!computedKey.declarations.some((d) => d.owner === 'C' && d.symbol === 'KEY'));
  assert.deepEqual(Object.keys(indexEvidenceSource('ledger.service.ts', text)), [
    'definitions',
    'imports',
    'uses',
  ]);
});

test('resolves tsconfig path aliases to tracked files only', () => {
  const aliases = parseTsconfigPaths(`{
    // comment with "quotes"
    "compilerOptions": {
      "paths": {
        "@app/shared": ["libs/shared/src"],
        "@app/shared/*": ["libs/shared/src/*"], /* trailing */
        "@evil/*": ["../../etc/*"],
      },
    },
  }`);
  const tracked = new Set([
    'libs/shared/src/index.ts',
    'libs/shared/src/utils/money.ts',
    'apps/a/src/b.ts',
  ]);
  const from = 'apps/a/src/c.ts';
  assert.equal(
    resolveEvidenceImport(from, '@app/shared', tracked, aliases),
    'libs/shared/src/index.ts',
  );
  assert.equal(
    resolveEvidenceImport(from, '@app/shared/utils/money', tracked, aliases),
    'libs/shared/src/utils/money.ts',
  );
  assert.equal(resolveEvidenceImport(from, './b.js', tracked, aliases), 'apps/a/src/b.ts');
  assert.equal(resolveEvidenceImport(from, '@evil/passwd', tracked, aliases), undefined);
  assert.equal(resolveEvidenceImport(from, '@app/shared/utils/money', tracked), undefined);
  assert.throws(() => parseTsconfigPaths('{'));
  // The longer, more specific wildcard prefix wins over a shorter overlapping one, like tsc.
  const overlapping = parseTsconfigPaths(`{
    "compilerOptions": {
      "paths": {
        "@app/*": ["libs/app/*"],
        "@app/shared/*": ["libs/shared/src/*"]
      }
    }
  }`);
  const overlappingTracked = new Set([
    'libs/shared/src/utils/money.ts',
    'libs/app/shared/utils/money.ts',
  ]);
  assert.equal(
    resolveEvidenceImport(from, '@app/shared/utils/money', overlappingTracked, overlapping),
    'libs/shared/src/utils/money.ts',
  );
  assert.deepEqual(parseTsconfigPaths('\uFEFF{}'), []);
  const many = Object.fromEntries(
    Array.from({ length: 300 }, (_, i) => [
      `@a${i}/*`,
      Array.from({ length: 20 }, (_, j) => `lib${i}/${j}/*`),
    ]),
  );
  const capped = parseTsconfigPaths(JSON.stringify({ compilerOptions: { paths: many } }));
  assert.equal(capped.length, 256);
  assert.ok(capped.every((alias) => alias.targets.length === 8));
});

test('pack provider reads tracked head sources with tsconfig aliases and word references', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'pack-provider-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const store = new EvidenceStore(workspace, []);
  // A failed inventory read is not cached: after `git init` the same store retries it.
  await assert.rejects(store.packProvider(AbortSignal.timeout(4000)));
  execFileSync('git', ['init', '-q', workspace]);
  await mkdir(join(workspace, 'libs/money/src'), { recursive: true });
  await writeFile(
    join(workspace, 'tsconfig.json'),
    '{ // aliases\n "compilerOptions": { "paths": { "@app/money": ["libs/money/src"] } } }',
  );
  await writeFile(join(workspace, 'libs/money/src/index.ts'), "export * from './total';");
  await writeFile(
    join(workspace, 'libs/money/src/total.ts'),
    'export function total(n: number) {\n  return n;\n}',
  );
  await writeFile(join(workspace, 'libs/money/src/broken.ts'), 'export function (');
  await writeFile(
    join(workspace, 'libs/money/src/cr.ts'),
    'export const a = 1;\rexport const b = 2;',
  );
  await writeFile(join(workspace, 'untracked.ts'), 'export const total = 1;');
  execFileSync('git', ['add', 'tsconfig.json', 'libs'], { cwd: workspace });
  const provider = await store.packProvider(AbortSignal.timeout(4000));
  assert.deepEqual(provider.aliases, [
    { prefix: '@app/money', wildcard: false, targets: ['libs/money/src'] },
  ]);
  assert.equal(
    (await provider.load('libs/money/src/total.ts'))?.index.declarations[0]?.symbol,
    'total',
  );
  assert.equal(await provider.load('untracked.ts'), undefined);
  assert.equal(await provider.load('libs/money/src/broken.ts'), undefined);
  assert.equal(await provider.load('libs/money/src/cr.ts'), undefined);
  // A developer's color.ui=always must not wrap the line numbers in escape codes.
  execFileSync('git', ['config', 'color.ui', 'always'], { cwd: workspace });
  assert.deepEqual(await provider.references('total'), [
    { path: 'libs/money/src/index.ts', line: 1 },
    { path: 'libs/money/src/total.ts', line: 1 },
  ]);
  assert.deepEqual(await provider.references('total', ['libs/money/src/total.ts']), [
    { path: 'libs/money/src/total.ts', line: 1 },
  ]);
});
