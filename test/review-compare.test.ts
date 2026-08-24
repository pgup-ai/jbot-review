import assert from 'node:assert/strict';
import { it } from 'node:test';

import {
  classifyReviewOutput,
  parseCompareArgs,
  renderComparison,
} from '../src/shared/review-compare.ts';

it('parses models, workspace, and base', () => {
  const args = parseCompareArgs([
    '--models',
    'zai/glm-5.2, opencode/grok-code ,zai/glm-5.2',
    '--workspace',
    '/repo',
    '--base',
    'origin/dev',
  ]);
  assert.deepEqual(args.models, ['zai/glm-5.2', 'opencode/grok-code']);
  assert.equal(args.workspace, '/repo');
  assert.equal(args.base, 'origin/dev');
  assert.equal(parseCompareArgs(['--models', 'a']).workspace, undefined);
  assert.throws(() => parseCompareArgs([]), /--models/);
  assert.throws(() => parseCompareArgs(['--models', ' , ']), /--models/);
  assert.throws(() => parseCompareArgs(['--models', 'a', '--nope', 'x']), /--nope/);
});

it('classifies missing, unparseable, and malformed review output', () => {
  const finding = { path: 'a.ts', line: 1, severity: 'P2', title: 'Finding' };
  assert.deepEqual(classifyReviewOutput(JSON.stringify({ findings: [finding] })), {
    findings: [finding],
  });
  assert.match(classifyReviewOutput(undefined).error!, /nothing to review/);
  assert.match(classifyReviewOutput('{not json').error!, /unreadable/);
  assert.match(classifyReviewOutput('{"findings":"nope"}').error!, /unreadable/);
});

it('renders a comparison table with per-model findings and failures', () => {
  const table = renderComparison([
    {
      model: 'zai/glm-5.2',
      seconds: 62,
      findings: [
        { path: 'src/a.ts', line: 10, severity: 'P1', title: 'Race on shared cache' },
        { path: 'src/b.ts', line: 3, severity: 'P3', title: 'Stale comment' },
      ],
    },
    { model: 'opencode/grok-code', seconds: 41, findings: [], error: 'exit 1' },
  ]);
  assert.match(table, /zai\/glm-5\.2\s+62s\s+2\s+P1,P3/);
  assert.match(table, /Race on shared cache/);
  assert.match(table, /src\/a\.ts:10/);
  assert.match(table, /exit 1/);
  // A model that produced nothing still gets a row, so a silent model is visible.
  assert.match(table, /opencode\/grok-code/);
});
