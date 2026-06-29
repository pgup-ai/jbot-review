import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { classifyChangeShape } from '../src/shared/diff-context.ts';
import { planReviewFanout, planIncrementalLenses } from '../src/shared/fanout.ts';
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

describe('planIncrementalLenses', () => {
  const ALL = ['interactions', 'integrity', 'frontend'];
  const gate = (deltaFiles: PrFile[] | null, candidateLensKeys = ALL, guidelinePass = true) =>
    planIncrementalLenses({ candidateLensKeys, guidelinePass, deltaFiles });

  const exportAdd: PrFile = {
    filename: 'src/x.ts',
    patch: '@@ -0,0 +1 @@\n+export const foo = 1;',
  };
  const exportRemove: PrFile = {
    filename: 'src/x.ts',
    patch: '@@ -1 +0,0 @@\n-export function gone() {}',
  };

  it('does not gate when there is no prior delta', () => {
    const result = gate(null);
    assert.deepEqual(result.lensKeys, ALL);
    assert.equal(result.guidelinePass, true);
  });

  it('runs interactions only when the delta adds or removes an exported symbol', () => {
    assert.ok(gate([exportAdd]).lensKeys.includes('interactions'));
    assert.ok(gate([exportRemove]).lensKeys.includes('interactions'));
    assert.ok(!gate([added(5, 'src/util/calc.ts')]).lensKeys.includes('interactions'));
  });

  it('runs interactions when the delta re-exports via `export * from`', () => {
    const reexport: PrFile = {
      filename: 'src/index.ts',
      patch: "@@ -0,0 +1 @@\n+export * from './widget.ts';",
    };
    assert.ok(gate([reexport]).lensKeys.includes('interactions'));
  });

  it('runs interactions when a delta file has no patch (content unknown → fail open)', () => {
    // GitHub omits patches for large/binary diffs; we can't see its exports.
    assert.ok(gate([{ filename: 'src/big.ts' }]).lensKeys.includes('interactions'));
  });

  it('runs integrity only when the delta touches security/data/api paths', () => {
    assert.ok(gate([added(3, 'src/auth/session.ts')]).lensKeys.includes('integrity'));
    assert.ok(gate([added(3, 'src/db/migrations/001.ts')]).lensKeys.includes('integrity'));
    assert.ok(!gate([added(3, 'src/util/calc.ts')]).lensKeys.includes('integrity'));
  });

  it('runs frontend only when the delta touches frontend files', () => {
    assert.ok(gate([added(3, 'apps/web/src/pages/Config.tsx')]).lensKeys.includes('frontend'));
    assert.ok(!gate([added(3, 'src/util/calc.ts')]).lensKeys.includes('frontend'));
  });

  it('skips the guideline pass on a test-only or docs-only delta, keeps it on code', () => {
    assert.equal(gate([added(3, 'src/x.test.ts')]).guidelinePass, false);
    assert.equal(gate([added(3, 'README.md')]).guidelinePass, false);
    assert.equal(gate([added(3, 'src/util/calc.ts')]).guidelinePass, true);
  });

  it('never re-enables a guideline pass the caller already disabled', () => {
    assert.equal(gate([added(3, 'src/auth/session.ts')], ALL, false).guidelinePass, false);
  });

  it('keeps an unknown candidate lens (fails toward coverage)', () => {
    assert.deepEqual(gate([added(3, 'src/util/calc.ts')], ['future-lens']).lensKeys, [
      'future-lens',
    ]);
  });

  it('keeps all candidates for a delta that touches every class', () => {
    const broad = [
      exportAdd,
      added(3, 'src/auth/session.ts'),
      added(3, 'apps/web/src/pages/Config.tsx'),
    ];
    assert.deepEqual(gate(broad).lensKeys, ALL);
  });
});
