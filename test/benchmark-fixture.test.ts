import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { materializeBenchmarkFixture } from '../src/shared/benchmark-fixture.ts';

describe('synthetic benchmark fixtures', () => {
  it('materializes base/head lines and rejects paths outside the workspace', () => {
    const fixture = {
      cases: [
        {
          id: 'case-1',
          shape: { files: 1, additions: 1, deletions: 1, patchBytes: 10 },
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

  it('materializes every hunk without inserting hunk headers as source', () => {
    const [file] = materializeBenchmarkFixture(
      {
        cases: [
          {
            id: 'multi-hunk',
            shape: { files: 1, additions: 2, deletions: 2, patchBytes: 100 },
            files: [
              {
                path: 'src/a.ts',
                patch: '@@ -2,1 +2,1 @@\n-old-a\n+new-a\n@@ -5,1 +5,1 @@\n-old-b\n+new-b\n',
              },
            ],
          },
        ],
      },
      'multi-hunk',
    );
    assert.equal(file.base.split('\n')[1], 'old-a');
    assert.equal(file.base.split('\n')[4], 'old-b');
    assert.equal(file.head.split('\n')[1], 'new-a');
    assert.equal(file.head.split('\n')[4], 'new-b');
    assert.doesNotMatch(file.base, /@@/);
    assert.doesNotMatch(file.head, /@@/);
  });
});
