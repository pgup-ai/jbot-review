import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { loadDotEnv, parseOwnerRepo, renderReport } from '../src/local/util.ts';

describe('loadDotEnv', () => {
  it('parses assignments, comments, quotes, and export prefixes without overriding real env', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jbot-env-'));
    const path = join(dir, '.env');
    try {
      writeFileSync(
        path,
        [
          '# comment',
          '',
          'PLAIN=one',
          'QUOTED="two words"',
          "SINGLE='three'",
          'export EXPORTED=four',
          'PRESET=from-file',
          'BROKEN LINE',
        ].join('\n'),
      );
      const env: NodeJS.ProcessEnv = { PRESET: 'from-shell' };
      assert.equal(loadDotEnv(path, env), true);
      assert.equal(env.PLAIN, 'one');
      assert.equal(env.QUOTED, 'two words');
      assert.equal(env.SINGLE, 'three');
      assert.equal(env.EXPORTED, 'four');
      assert.equal(env.PRESET, 'from-shell'); // real environment always wins
      assert.ok(!('export EXPORTED' in env));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns false when the file does not exist', () => {
    const env: NodeJS.ProcessEnv = {};
    assert.equal(loadDotEnv('/nonexistent/.env', env), false);
    assert.deepEqual(env, {});
  });
});

describe('parseOwnerRepo', () => {
  it('parses https and ssh remotes, with and without .git', () => {
    assert.deepEqual(parseOwnerRepo('https://github.com/pgup-ai/jbot-review.git'), {
      owner: 'pgup-ai',
      repo: 'jbot-review',
    });
    assert.deepEqual(parseOwnerRepo('git@github.com:pgup-ai/jbot-review.git'), {
      owner: 'pgup-ai',
      repo: 'jbot-review',
    });
    assert.deepEqual(parseOwnerRepo('https://github.com/pgup-ai/jbot-review/'), {
      owner: 'pgup-ai',
      repo: 'jbot-review',
    });
  });

  it('returns null for non-remote strings', () => {
    assert.equal(parseOwnerRepo(''), null);
    assert.equal(parseOwnerRepo('not a url'), null);
  });
});

describe('renderReport', () => {
  const meta = { branch: 'b', baseRef: 'origin/main', mergeBase: 'abcdef1234567890', model: 'm/x' };

  it('renders line anchors for inline findings and bare paths for file-level (line 0)', () => {
    const report = renderReport(
      {
        summary: 'S',
        findings: [
          { path: 'src/a.ts', line: 3, severity: 'P1', title: 'T1', body: 'B1' },
          { path: 'src/b.ts', line: 0, severity: 'P2', title: 'T2', body: 'B2' },
        ],
        addressedPriorComments: [],
      },
      meta,
    );
    assert.match(report, /`src\/a\.ts:3`/);
    assert.match(report, /`src\/b\.ts`/);
    assert.doesNotMatch(report, /src\/b\.ts:0/);
    assert.match(report, /## Findings \(2\)/);
  });

  it('says "No findings." on a clean run', () => {
    const report = renderReport({ summary: '', findings: [], addressedPriorComments: [] }, meta);
    assert.match(report, /No findings\./);
    assert.match(report, /_\(no summary\)_/);
  });
});
