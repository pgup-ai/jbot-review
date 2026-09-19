import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildBlastRadiusBlock } from '../src/shared/blast-radius.ts';
import {
  buildJevPrefetch,
  selectJevCandidates,
  type JevPrefetchStats,
} from '../src/shared/jev-prefetch.ts';
import {
  buildJevRequest,
  formatJevPrefetch,
  formatEvidenceCoverage,
  JEV_MODEL,
} from '../src/shared/prompt.ts';
import { sessionEnvironment } from '../src/shared/opencode-config.ts';
import { sessionEnvDenyKeys } from '../src/shared/opencode-server.ts';
import { createTelemetryRecorder } from '../src/shared/telemetry.ts';
import { aggregatePerformance } from '../scripts/review-performance.ts';
import { emitReviewTelemetry, normalizeOptions } from '../src/shared/runner.ts';

const files = [
  {
    filename: 'changed.ts',
    patch: '@@ -1 +1 @@\n-export function pay() {}\n+export function pay(amount: number) {}',
  },
];
const candidate = {
  completeFile: false,
  symbol: 'pay',
  path: 'consumer.ts',
  line: 1,
  text: '1: pay(10);',
};
const answer = (scores: number[]) => ({
  model: JEV_MODEL,
  answers: Object.fromEntries(scores.map((noul, i) => [`c${i}`, { type: 'noul', noul }])),
  usage: { input_tokens: 1234, output_tokens: 20 },
});

test('request budgets bound escaped multi-byte state and explicitly bind independent questions', () => {
  const candidates = Array.from({ length: 36 }, (_, i) => ({
    ...candidate,
    path: `${i}.ts`,
    text: '😀"\\'.repeat(200),
  }));
  const request = buildJevRequest(
    [{ ...files[0], patch: files[0].patch + '😀'.repeat(5000) }],
    candidates,
  );
  assert.ok(Buffer.byteLength(request.body) <= 30_000);
  assert.ok(request.candidates.length > 0 && request.candidates.length < candidates.length);
  const parsed = JSON.parse(request.body);
  assert.equal(parsed.model, JEV_MODEL);
  assert.equal(Object.keys(parsed.questions).length, request.candidates.length);
  assert.match(parsed.questions.c1.instructions, /candidates\[1\]/);
  assert.match(parsed.state.changes[0].patch, /omitted|truncated/i);
  assert.equal(candidates.length, 36);
  const coverage = formatEvidenceCoverage(Array.from({ length: 1000 }, () => '😀'.repeat(100)));
  assert.ok(Buffer.byteLength(coverage) <= 900);
  assert.match(coverage, /omitted/);
});

test('ranking keeps source identities, stable ties, and bounded excerpts with omission notices', () => {
  const candidates = Array.from({ length: 6 }, (_, i) => ({
    ...candidate,
    path: `consumer-${i}.ts`,
    line: i + 1,
    text: `${i + 1}: pay();\n` + '😀'.repeat(200),
  }));
  candidates.push(candidates[5]);
  const result = selectJevCandidates(answer([0.1, 0.2, 0.8, 0.8, 0.7, 0.9, 0.9]), candidates);
  assert.deepEqual(result.selected, [5, 2, 3, 4]);
  const block = formatJevPrefetch(
    result.selected.map((i) => candidates[i]),
    candidates.filter((_, i) => !result.selected.includes(i)),
  );
  assert.ok(Buffer.byteLength(block) <= 6000);
  assert.match(block, /consumer-0.ts:1/);
  assert.match(block, /does not narrow review scope/);
  assert.equal(result.inputTokens, 1234);
  assert.deepEqual(selectJevCandidates(answer([0.1]), [candidate]).selected, []);
  for (const malformed of [
    null,
    {},
    { ...answer([0.1]), model: 'other' },
    answer([NaN]),
    answer([1.01]),
    { ...answer([0.5]), usage: {} },
  ]) {
    assert.throws(() => selectJevCandidates(malformed, [candidate]), /invalid-response/);
  }
});

test('off and shadow preserve baseline context; on adds only tracked source and exports sanitized stats', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'jbot-jev-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', workspace]);
  await writeFile(join(workspace, 'consumer.ts'), 'import { pay } from "./changed";\npay(10);\n');
  await writeFile(join(workspace, 'private.ts'), 'SECRET_PAYLOAD pay();');
  await symlink('private.ts', join(workspace, 'linked.ts'));
  await mkdir(join(workspace, 'outside'));
  await writeFile(join(workspace, 'outside/secret.ts'), 'SECRET_PAYLOAD pay();');
  await symlink('outside', join(workspace, 'linked-dir'));
  execFileSync('git', ['add', 'consumer.ts', 'linked.ts', 'linked-dir'], { cwd: workspace });
  await writeFile(join(workspace, 'consumer.ts'), 'import { pay } from "./changed";\npay(42);\n');
  const grep = async () => [
    'consumer.ts',
    'private.ts',
    'linked.ts',
    'linked-dir/secret.ts',
    '.env',
  ];
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests++;
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(init.redirect, 'error');
    assert.doesNotMatch(init.body, /SECRET_PAYLOAD|TEST_KEY/);
    assert.match(init.body, /pay\(42\)/);
    const request = JSON.parse(init.body);
    return Response.json(answer(Object.keys(request.questions).map((_, i) => 0.7 + i / 10)));
  });
  const logs: string[] = [];
  const recorder = createTelemetryRecorder(true);
  const options = {
    apiKey: 'TEST_KEY',
    timeoutMs: 5000,
    log: (s: string) => logs.push(s),
    onStats: recorder.recordJevPrefetch,
  };
  const baseline = await buildBlastRadiusBlock(workspace, files, grep);
  assert.equal(
    await buildBlastRadiusBlock(workspace, files, grep, { ...options, mode: 'off' }),
    baseline,
  );
  assert.equal(requests, 0);
  assert.equal(
    await buildBlastRadiusBlock(workspace, files, grep, { ...options, mode: 'shadow' }),
    baseline,
  );
  const applied = await buildBlastRadiusBlock(workspace, files, grep, { ...options, mode: 'on' });
  assert.ok(applied.startsWith(baseline));
  assert.match(applied, /Prefetched caller evidence/);
  assert.match(applied, /pay\(42\)/);
  assert.doesNotMatch(applied, /SECRET_PAYLOAD/);
  assert.equal(requests, 2);
  const rows = recorder.toJsonl().split('\n').map(JSON.parse);
  assert.deepEqual(
    rows.map((r) => r.status),
    ['disabled', 'shadow', 'applied'],
  );
  assert.equal(rows[1].injectedBytes, 0);
  assert.ok(rows[2].injectedBytes > 0);
  assert.equal(rows[2].inputTokens, 1234);
  assert.equal(rows[2].version, 5);
  assert.equal(rows[2].completeFileCandidates, 1);
  assert.match(applied, /complete file/);
  assert.match(applied, /Do not spend a tool call rereading supplied lines/);
  assert.equal(rows[2].estimatedCostUsd, (1234 * 0.042) / 1_000_000);
  assert.doesNotMatch(
    logs.join('\n') + recorder.toJsonl(),
    /TEST_KEY|SECRET_PAYLOAD|pay\(42\)|consumer.ts/,
  );
  const report = aggregatePerformance([{ kind: 'run', runId: 'test' }, ...rows]);
  assert.equal(report.auxiliaryRuns[0].jevPrefetch.length, 3);
  recorder.beginRun({ runId: 'test', model: 'opencode/test' });
  recorder.recordSession({ kind: 'session', session: 'review', inputTokens: 10, outputTokens: 2 });
  recorder.finishRun('completed', 123);
  emitReviewTelemetry(recorder, workspace, (s) => logs.push(s));
  assert.ok(logs.some((s) => s.startsWith('Review timing:') && s.includes('123')));
  assert.ok(logs.some((s) => s.startsWith('Review metrics:') && s.includes('"inputTokens":10')));
  assert.equal(sessionEnvironment({ TYPESAFE_API_KEY: 'TEST_KEY' }).TYPESAFE_API_KEY, undefined);
  assert.deepEqual(sessionEnvDenyKeys(['TYPESAFE_API_KEY']), ['TYPESAFE_API_KEY']);
});

test('HTTP errors, invalid or oversized responses, and timeout fail open without leaking provider text', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'jbot-jev-fail-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', workspace]);
  await writeFile(join(workspace, 'consumer.ts'), 'pay(1);');
  execFileSync('git', ['add', '.'], { cwd: workspace });
  const grep = async () => ['consumer.ts'];
  const baseline = await buildBlastRadiusBlock(workspace, files, grep);
  const logs: string[] = [];
  const rows: JevPrefetchStats[] = [];
  const options = {
    mode: 'on' as const,
    apiKey: 'TEST_KEY',
    timeoutMs: 5000,
    log: (s: string) => logs.push(s),
    onStats: (s: JevPrefetchStats) => rows.push(s),
  };
  let reply = () => new Response('SECRET_ERROR', { status: 429 });
  const mock = t.mock.method(globalThis, 'fetch', async () => reply());
  for (const [response, reason] of [
    [() => new Response('SECRET_ERROR', { status: 429 }), 'http'],
    [() => new Response('SECRET_ERROR'), 'invalid-response'],
    [() => Response.json(answer([2])), 'invalid-response'],
    [() => new Response('x'.repeat(20_000)), 'invalid-response'],
  ] as const) {
    reply = response;
    assert.equal(await buildBlastRadiusBlock(workspace, files, grep, options), baseline);
    assert.equal(rows.at(-1).reason, reason);
    assert.equal(rows.at(-1).status, 'fallback');
  }
  reply = () => Response.json(answer([0.1]));
  assert.equal(await buildBlastRadiusBlock(workspace, files, grep, options), baseline);
  assert.equal(rows.at(-1).reason, 'no-relevant-candidates');
  assert.equal(rows.at(-1).status, 'skipped');
  assert.equal(rows.at(-1).inputTokens, 1234);
  mock.mock.mockImplementation(
    async (_, init) =>
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error('SECRET_ERROR')), 200);
        init.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(init.signal.reason);
          },
          { once: true },
        );
      }),
  );
  assert.equal(
    await buildBlastRadiusBlock(workspace, files, grep, { ...options, timeoutMs: 50 }),
    baseline,
  );
  assert.equal(rows.at(-1).reason, 'timeout');
  const count = mock.mock.callCount();
  await buildBlastRadiusBlock(workspace, files, grep, { ...options, apiKey: undefined });
  assert.equal(rows.at(-1).reason, 'missing-key');
  await buildJevPrefetch(workspace, [], [], options);
  assert.equal(rows.at(-1).reason, 'no-candidates');
  assert.equal(mock.mock.callCount(), count);
  assert.doesNotMatch(logs.join('\n'), /SECRET_ERROR|TEST_KEY/);
});

test('source completeness never hides byte truncation or a dependency beyond a partial window', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'jbot-jev-windows-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', workspace]);
  await writeFile(join(workspace, 'complete.ts'), 'pay(1);\n' + '\n'.repeat(18) + 'checkResult();');
  await writeFile(join(workspace, 'partial.ts'), 'pay(1);\n' + 'const padding = 1;\n'.repeat(200));
  await writeFile(join(workspace, 'clipped.ts'), 'pay(1);\n//' + 'x'.repeat(300_000));
  execFileSync('git', ['add', '.'], { cwd: workspace });
  t.mock.method(globalThis, 'fetch', async (_, init) => {
    const { state, questions } = JSON.parse(init.body);
    const byPath = Object.fromEntries(state.candidates.map((c) => [c.path, c]));
    assert.equal(byPath['complete.ts'].completeFile, true);
    assert.match(byPath['complete.ts'].text, /checkResult/);
    assert.equal(byPath['partial.ts'].completeFile, false);
    assert.equal(byPath['clipped.ts'].completeFile, false);
    return Response.json(answer(Object.keys(questions).map(() => 0.9)));
  });
  const block = await buildJevPrefetch(
    workspace,
    files,
    [{ symbol: 'pay', callSites: ['complete.ts', 'partial.ts', 'clipped.ts'] }],
    {
      mode: 'on',
      apiKey: 'TEST_KEY',
      timeoutMs: 5000,
      log: () => {},
      onStats: () => {},
    },
  );
  assert.match(block, /complete.ts:1 \(pay; complete file\)/);
  assert.match(block, /partial.ts:1 \(pay; partial file/);
  assert.match(block, /clipped.ts:1 \(pay; partial file/);
  assert.ok(Buffer.byteLength(block) <= 6000);
});

test('deterministic control uses the same candidate pool and budgets without credentials or API usage', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'jbot-prefetch-control-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', workspace]);
  const paths = Array.from({ length: 7 }, (_, i) => `consumer-${i}.ts`);
  for (const path of paths) await writeFile(join(workspace, path), 'pay(1);\n//' + 'x'.repeat(500));
  execFileSync('git', ['add', '.'], { cwd: workspace });
  let narrow = false;
  const fetch = t.mock.method(globalThis, 'fetch', async (_, init) => {
    const { questions } = JSON.parse(init.body);
    return Response.json(
      answer(Object.keys(questions).map((_, i) => (narrow ? (i === 3 ? 0.9 : 0.1) : 0.5 + i / 20))),
    );
  });
  const rows: JevPrefetchStats[] = [];
  const options = {
    timeoutMs: 5000,
    log: () => {},
    onStats: (s: JevPrefetchStats) => rows.push(s),
  };
  const entries = [{ symbol: 'pay', callSites: paths }];
  const control = await buildJevPrefetch(workspace, files, entries, {
    ...options,
    mode: 'deterministic',
  });
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(rows[0].status, 'applied');
  assert.equal(rows[0].model, null);
  assert.equal(rows[0].apiMs, 0);
  assert.equal(rows[0].requestBytes, 0);
  assert.equal(rows[0].scoredCandidates, 0);
  assert.equal(rows[0].estimatedCostUsd, 0);
  assert.equal(rows[0].selectedScores, undefined);
  assert.equal(rows[0].inputTokens, undefined);
  assert.deepEqual(
    [...control.matchAll(/^### (consumer-\d.ts)/gm)].map((m) => m[1]),
    paths.slice(0, 4),
  );
  const treatment = await buildJevPrefetch(workspace, files, entries, {
    ...options,
    mode: 'on',
    apiKey: 'TEST_KEY',
  });
  assert.equal(rows[0].candidateHash, rows[1].candidateHash);
  assert.equal(rows[0].collectedCandidates, rows[1].scoredCandidates);
  assert.equal(fetch.mock.callCount(), 1);
  assert.deepEqual(
    [...treatment.matchAll(/^### (consumer-\d.ts)/gm)].map((m) => m[1]),
    paths.slice(3).reverse(),
  );
  assert.ok(Buffer.byteLength(control) <= 6000 && Buffer.byteLength(treatment) <= 6000);
  assert.equal(rows[0].deterministicOverlap, 4);
  assert.equal(rows[1].deterministicOverlap, 1);
  narrow = true;
  await buildJevPrefetch(workspace, files, entries, { ...options, mode: 'on', apiKey: 'TEST_KEY' });
  assert.equal(rows[2].selectedCandidates, 1);
  assert.equal(rows[2].deterministicOverlap, 1);
  assert.equal(fetch.mock.callCount(), 2);
  const previous = process.env.JBOT_JEV_PREFETCH;
  t.after(() => {
    if (previous === undefined) delete process.env.JBOT_JEV_PREFETCH;
    else process.env.JBOT_JEV_PREFETCH = previous;
  });
  process.env.JBOT_JEV_PREFETCH = 'deterministic';
  assert.equal(normalizeOptions(undefined).jevPrefetch, 'deterministic');
  assert.equal(normalizeOptions({ jevPrefetch: 'off' }).jevPrefetch, 'off');
});
