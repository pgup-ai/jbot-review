import assert from 'node:assert/strict';
import { it } from 'node:test';
import {
  GuidelineVerifierShadow,
  observesGuidelineVerifier,
} from '../src/shared/guideline-verifier-shadow.ts';
import { requestFindingVerdicts } from '../src/shared/runner.ts';
import { runFindingVerification } from '../src/shared/opencode.ts';
import { Semaphore } from '../src/shared/opencode-session.ts';
import type { Finding } from '../src/shared/types.ts';
import { fakeOpencodeServer, fakeRuntime } from './support/opencode-fake.ts';

it('matches sharded preview prompts to the first passes dispatched by OpenCode', async () => {
  const targets: Finding[] = Array.from({ length: 6 }, (_, i) => ({
    title: 'Check the writer',
    path: 'a.ts',
    line: i + 1,
    severity: 'P2',
    body: 'Disputed condition.',
  }));
  const shadow = new GuidelineVerifierShadow();
  const fake = fakeOpencodeServer(() => ({
    text: JSON.stringify({
      verdicts: [0, 1, 2].map((index) => ({ index, verdict: 'uncertain', reason: 'needs lookup' })),
    }),
  }));
  const runtime = fakeRuntime(fake);
  runtime.onVerifierFirstPrompt = (text) => shadow.actualPrompt(text);
  const params = {
    workspace: '/unused',
    model: 'opencode-go/deepseek-v4.1-flash',
    prContext: 'diff',
    sourceContext: async () => 'tracked source',
    toolLessFirst: true,
    targets,
    log: () => {},
  };
  const slots = new Semaphore(10, true);
  const release = await slots.acquire('high');
  shadow.begin(1000, slots.freeSlots);
  release();
  await requestFindingVerdicts({
    ...params,
    previewPrompt: (text) => shadow.earlyPrompt(text),
    onCoverage: (row) => shadow.prepared(1050, row.state === 'completed'),
  });
  assert.equal(fake.prompts.length, 0);
  await requestFindingVerdicts({
    ...params,
    backend: { runFindingVerification: (...args) => runFindingVerification(runtime, ...args) },
  });
  assert.equal(fake.prompts.length, 4);
  const report = shadow.report(2000, false);
  assert.equal(report.actualBatches, 2);
  assert.equal(report.earlyBatches, 2);
  assert.equal(report.match, true);
  assert.equal(report.overlapMs, 1000);
  assert.equal(report.preparedOverlapMs, 950);
  assert.equal(report.freeSlots, 9);
  assert.equal(slots.freeSlots, 10);
  assert.equal(shadow.report(2000, true).match, null);
});

it('distinguishes changed text, extra waves, incomplete previews and zero-gain runs', () => {
  const shadow = new GuidelineVerifierShadow();
  assert.equal(shadow.report(20, false).match, null);
  assert.equal(shadow.report(20, false).overlapMs, 0);
  shadow.begin(10, 0);
  shadow.earlyPrompt('same title, earlier source');
  shadow.actualPrompt('same title, later source');
  assert.equal(shadow.report(20, false).match, null);
  shadow.prepared(21, true);
  const result = shadow.report(20, false);
  assert.equal(result.match, false);
  assert.equal(result.preparedOverlapMs, 0);
  assert.equal(result.freeSlots, 0);
  const extra = new GuidelineVerifierShadow();
  extra.begin(10, 2);
  extra.earlyPrompt('batch');
  extra.actualPrompt('batch');
  extra.actualPrompt('batch');
  extra.prepared(11, true);
  assert.equal(extra.report(20, false).match, false);
  extra.prepared(11, false);
  assert.equal(extra.report(20, false).match, null);
});

it('requires both roles on the specified model and engine at the effective cap', () => {
  const ds = 'opencode-go/deepseek-v4.1-flash';
  assert.equal(observesGuidelineVerifier(ds, ds, 'opencode', 'opencode', 10), true);
  for (const [main, aux, mainEngine, auxEngine, cap] of [
    [ds, 'other', 'opencode', 'opencode', 10],
    ['other', ds, 'opencode', 'opencode', 10],
    [ds, ds, 'dsh', 'opencode', 10],
    [ds, ds, 'opencode', 'dsh', 10],
    [ds, ds, 'opencode', 'opencode', 9],
  ] as const)
    assert.equal(observesGuidelineVerifier(main, aux, mainEngine, auxEngine, cap), false);
});
