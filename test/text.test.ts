import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatUsageCost, isFiniteNumber } from '../src/shared/text.ts';

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
