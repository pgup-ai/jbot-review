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
import { buildJevRequest, formatJevPrefetch, JEV_MODEL } from '../src/shared/prompt.ts';
import { sessionEnvironment } from '../src/shared/opencode-config.ts';
import { sessionEnvDenyKeys } from '../src/shared/opencode-server.ts';
import { createTelemetryRecorder } from '../src/shared/telemetry.ts';
import { aggregatePerformance } from '../scripts/review-performance.ts';
import { emitReviewTelemetry } from '../src/shared/runner.ts';

const files = [
  {
    filename: 'changed.ts',
    patch: '@@ -1 +1 @@\n-export function pay() {}\n+export function pay(amount: number) {}',
  },
];
const candidate = { symbol: 'pay', path: 'consumer.ts', line: 1, text: '1: pay(10);' };
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
