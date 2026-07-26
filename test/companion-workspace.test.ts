import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { deepenUntilBase } from '../src/companion/workspace.ts';

describe('deepenUntilBase', () => {
  it('stops at the first depth that reaches the base', () => {
    const asked: number[] = [];
    // Reachable only after the first deepen, so the second step must not run.
    let reachable = false;
    const failure = deepenUntilBase(
      () => reachable,
      (depth) => {
        asked.push(depth);
        reachable = true;
        return undefined;
      },
    );

    assert.equal(failure, undefined);
    assert.deepEqual(asked, [200]);
  });

  it('skips fetching when the initial clone already reached the base', () => {
    let deepened = false;
    const failure = deepenUntilBase(
      () => true,
      () => {
        deepened = true;
        return undefined;
      },
    );

    assert.equal(failure, undefined);
    assert.equal(deepened, false);
  });

  it('reports the limit when no depth reaches it, and surfaces a fetch failure as-is', () => {
    const exhausted = deepenUntilBase(
      () => false,
      () => undefined,
    );
    assert.match(String(exhausted), /more than 1250 commits/);

    // A broken fetch must not be reported as a too-long history.
    const broken = deepenUntilBase(
      () => false,
      () => 'git fetch failed: boom',
    );
    assert.equal(broken, 'git fetch failed: boom');
  });
});
