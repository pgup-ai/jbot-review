import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { classifyChangeShape } from '../src/shared/diff-context.ts';
import { planReviewFanout } from '../src/shared/fanout.ts';
import type { PrFile } from '../src/shared/github.ts';

function added(lines: number, name = 'src/util/calc.ts'): PrFile {
  const body = Array.from({ length: lines }, (_, i) => `+const x${i} = ${i};`).join('\n');
  return { filename: name, patch: `@@ -0,0 +1,${lines} @@\n${body}` };
}

function plan(files: PrFile[], requestedPasses = 3, requestedGuidelinePass = true) {
  return planReviewFanout({
    requestedPasses,
    requestedGuidelinePass,
    files,
    shape: classifyChangeShape(files),
  });
}

describe('planReviewFanout', () => {
  it('drops to minimal fan-out for a small low-risk diff', () => {
    const result = plan([added(10), added(15, 'src/util/format.ts')]);
    assert.equal(result.tier, 'minimal');
    assert.equal(result.reviewPasses, 1);
    assert.equal(result.guidelinePass, false);
  });

  it('keeps the requested ceiling for a sensitive path', () => {
    const result = plan([added(10, 'src/auth/session.ts')]);
    assert.equal(result.tier, 'full');
    assert.equal(result.reviewPasses, 3);
    assert.equal(result.guidelinePass, true);
  });

  it('keeps full fan-out when a dependency manifest changes', () => {
    const result = plan([
      { filename: 'go.mod', patch: '@@ -1 +1 @@\n+\trequire example.com/x v1.2.3' },
    ]);
    assert.equal(result.tier, 'full');
  });

  it('keeps full fan-out for a large deletion', () => {
    const removed = Array.from({ length: 60 }, (_, i) => `-const y${i} = ${i};`).join('\n');
    const removal: PrFile = { filename: 'src/util/old.ts', patch: `@@ -1,60 +0,0 @@\n${removed}` };
    assert.equal(plan([removal]).tier, 'full');
  });

  it('keeps full fan-out past the file-count ceiling', () => {
    const files = [added(2), added(2, 'src/a.ts'), added(2, 'src/b.ts'), added(2, 'src/c.ts')];
    assert.equal(plan(files).tier, 'full');
  });

  it('keeps full fan-out past the added-line ceiling', () => {
    assert.equal(plan([added(61)]).tier, 'full');
  });

  it('never raises fan-out above the requested values', () => {
    const result = plan([added(10)], 1, false);
    assert.equal(result.reviewPasses, 1);
    assert.equal(result.guidelinePass, false);
    assert.equal(result.tier, 'minimal');
  });
});
