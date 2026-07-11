import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatFileList, formatUsageCost, isFiniteNumber } from '../src/shared/text.ts';

describe('isFiniteNumber', () => {
  it('accepts only finite numbers', () => {
    assert.equal(isFiniteNumber(0), true);
    assert.equal(isFiniteNumber(1.25), true);
    assert.equal(isFiniteNumber(Infinity), false);
    assert.equal(isFiniteNumber(-Infinity), false);
    assert.equal(isFiniteNumber(NaN), false);
    assert.equal(isFiniteNumber('1'), false);
    assert.equal(isFiniteNumber(undefined), false);
  });
});

describe('formatUsageCost', () => {
  it('formats integer, fractional, and non-finite values', () => {
    assert.equal(formatUsageCost(3), '3');
    assert.equal(formatUsageCost(2.5), '2.5000');
    assert.equal(formatUsageCost(Infinity), 'Infinity');
  });
});

describe('formatFileList', () => {
  it('caps file lists with a remainder', () => {
    const files = Array.from({ length: 12 }, (_, index) => `f${index}.ts`);
    assert.equal(
      formatFileList(files),
      'f0.ts, f1.ts, f2.ts, f3.ts, f4.ts, f5.ts, f6.ts, f7.ts, f8.ts, f9.ts, and 2 more',
    );
  });
});
