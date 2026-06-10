import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildReviewFocusBlock } from '../src/shared/runner.ts';

describe('buildReviewFocusBlock', () => {
  it('adds a snapshot/aliasing checklist for repository/ORM files', () => {
    const block = buildReviewFocusBlock([
      'libs/core-ledger-shared/src/counterparties/repository/write-counterparty.repository.ts',
    ]);

    assert.match(block, /Data layer: snapshot\/aliasing/);
    assert.match(block, /first-write-wins/);
  });

  it('matches data-access files by suffix as well as directory', () => {
    const block = buildReviewFocusBlock(['src/users/user.dao.ts']);

    assert.match(block, /Data layer: snapshot\/aliasing/);
  });

  it('falls back to general correctness for unclassified files', () => {
    const block = buildReviewFocusBlock(['src/util/math.ts']);

    assert.match(block, /General correctness/);
    assert.doesNotMatch(block, /snapshot\/aliasing/);
  });
});
