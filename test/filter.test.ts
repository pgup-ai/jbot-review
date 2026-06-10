import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { demoteLowConfidenceBlockingFindings, isNoiseFile } from '../src/shared/filter.ts';
import type { Finding } from '../src/shared/types.ts';

function finding(overrides: Partial<Finding>): Finding {
  return {
    path: 'src/example.ts',
    line: 10,
    severity: 'P2',
    title: 'Example finding',
    body: 'Example body',
    ...overrides,
  };
}

describe('demoteLowConfidenceBlockingFindings', () => {
  it('demotes low-confidence P0/P1/P2 findings to P3', () => {
    const { findings, demotedCount } = demoteLowConfidenceBlockingFindings([
      finding({ severity: 'P0', confidence: 'low' }),
      finding({ severity: 'P1', confidence: 'low' }),
      finding({ severity: 'P2', confidence: 'low' }),
    ]);

    assert.equal(demotedCount, 3);
    assert.deepEqual(
      findings.map((f) => f.severity),
      ['P3', 'P3', 'P3'],
    );
  });

  it('keeps high/medium confidence blocking findings unchanged', () => {
    const input = [
      finding({ severity: 'P0', confidence: 'high' }),
      finding({ severity: 'P1', confidence: 'medium' }),
    ];
    const { findings, demotedCount } = demoteLowConfidenceBlockingFindings(input);

    assert.equal(demotedCount, 0);
    assert.deepEqual(findings, input);
  });

  it('does not demote findings without a confidence field', () => {
    const input = [finding({ severity: 'P0' })];
    const { findings, demotedCount } = demoteLowConfidenceBlockingFindings(input);

    assert.equal(demotedCount, 0);
    assert.equal(findings[0].severity, 'P0');
  });

  it('leaves low-confidence advisory findings (P3/nit) unchanged', () => {
    const input = [
      finding({ severity: 'P3', confidence: 'low' }),
      finding({ severity: 'nit', confidence: 'low' }),
    ];
    const { findings, demotedCount } = demoteLowConfidenceBlockingFindings(input);

    assert.equal(demotedCount, 0);
    assert.deepEqual(findings, input);
  });
});

describe('isNoiseFile', () => {
  it('still filters lockfiles', () => {
    assert.equal(isNoiseFile('package-lock.json'), true);
    assert.equal(isNoiseFile('src/app.ts'), false);
  });
});
