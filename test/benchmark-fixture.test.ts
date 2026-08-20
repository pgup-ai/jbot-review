import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { materializeBenchmarkFixture } from '../src/shared/benchmark-fixture.ts';

describe('synthetic benchmark fixtures', () => {
  it('materializes base/head lines and rejects paths outside the workspace', () => {
    const fixture = {
      cases: [
        {
          id: 'case-1',
          files: [{ path: 'src/a.ts', patch: '@@ -3,1 +3,1 @@\n-old\n+new\n' }],
        },
      ],
    };
    assert.deepEqual(materializeBenchmarkFixture(fixture, 'case-1'), [
      { path: 'src/a.ts', base: '\n\nold\n', head: '\n\nnew\n' },
    ]);
    fixture.cases[0].files[0].path = '../outside.ts';
    assert.throws(() => materializeBenchmarkFixture(fixture, 'case-1'), /invalid file/);
  });
});
