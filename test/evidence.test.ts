import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  EvidenceStore,
  indexEvidenceSource,
  changedEvidenceLines,
  resolveEvidenceImport,
  evidenceMode,
} from '../src/shared/evidence.ts';
import { normalizeOptions, requestFindingVerdicts } from '../src/shared/runner.ts';
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
    'money.ts',
    'export function total(n: number) {\nreturn n * 100;\n}\nthrow new Error("never executed");',
  );
  assert.deepEqual(changedEvidenceLines(files[0].patch), [2]);
  assert.ok(source.definitions.some((d) => d.symbol === 'total' && d.start === 1 && d.end === 3));
  const consumer = indexEvidenceSource(
    'consumer.ts',
    "import { total as amount } from './money.js';\namount(1); // total is only a comment here",
  );
  assert.deepEqual(consumer.imports, [{ local: 'amount', imported: 'total', from: './money.js' }]);
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
    normalizeOptions({ explorationEvidence: 'off', verificationEvidence: 'deterministic' })
      .verificationEvidence,
    'deterministic',
  );
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
});

test('invalid docs and timeouts fail open with measurable fallback and no provider error text', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'evidence-failure-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', workspace]);
  const docs = join(workspace, 'docs.json');
  await writeFile(docs, 'x'.repeat(70000));
  const rows = [],
    logs = [];
  const store = new EvidenceStore(workspace, [], docs);
  const options = { timeoutMs: 5000, log: (s) => logs.push(s), onStats: (s) => rows.push(s) };
  assert.equal(await store.prepare('verification', [finding], 'on', options), '');
  assert.equal(rows[0].status, 'fallback');
  assert.equal(rows[0].scope, 'verification');
  assert.equal(
    await store.prepare('exploration', [], 'deterministic', { ...options, timeoutMs: 0 }),
    '',
  );
  assert.equal(rows[1].status, 'fallback');
  assert.ok(!logs.join('').includes('x'.repeat(50)));
});

test('failed evidence preparation cannot skip independent finding verification', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'evidence-verdict-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', workspace]);
  let calls = 0;
  const verdicts = await requestFindingVerdicts({
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
  });
  assert.equal(calls, 1);
  assert.equal(verdicts[0].verdict, 'confirmed');
});
