import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

import { parseLocalArgs, resolveConfiguredBase, resolveLocalPaths } from '../src/local/args.ts';

describe('local review arguments', () => {
  it('parses workspace, base, and preview in any order', () => {
    assert.deepEqual(
      parseLocalArgs(['--preview', '--base', 'origin/develop', '--workspace', '../target']),
      {
        preview: true,
        base: 'origin/develop',
        workspace: '../target',
      },
    );
    assert.deepEqual(parseLocalArgs([]), { preview: false });
  });

  it('rejects unknown, duplicate, and missing-value arguments', () => {
    assert.throws(() => parseLocalArgs(['target']), /Unknown local review argument "target"/);
    assert.throws(() => parseLocalArgs(['--head', 'main']), /Unknown local review argument/);
    assert.throws(
      () => parseLocalArgs(['--workspace', 'a', '--workspace', 'b']),
      /Duplicate local review argument "--workspace"/,
    );
    assert.throws(
      () => parseLocalArgs(['--base']),
      /Local review argument "--base" requires a value/,
    );
    assert.throws(
      () => parseLocalArgs(['--workspace', '--preview']),
      /Local review argument "--workspace" requires a value/,
    );
  });

  it('gives the CLI base precedence over the environment', () => {
    assert.equal(resolveConfiguredBase('topic-base', 'env-base'), 'topic-base');
    assert.equal(resolveConfiguredBase(undefined, ' env-base '), 'env-base');
    assert.equal(resolveConfiguredBase(undefined, '  '), undefined);
  });
});

describe('local review paths', () => {
  it('resolves workspace and output paths from the launch root', () => {
    const launchRoot = resolve('/tmp/jbot-launch');
    assert.deepEqual(
      resolveLocalPaths({ preview: false, workspace: '../target' }, launchRoot, 'results/run.json'),
      {
        workspace: resolve(launchRoot, '../target'),
        artifactRoot: join(launchRoot, '.jbot-review'),
        benchmarkOutput: join(launchRoot, 'results/run.json'),
      },
    );
    const output = resolve('/tmp/result.json');
    assert.equal(resolveLocalPaths({ preview: false }, launchRoot, output).benchmarkOutput, output);
    assert.equal(
      resolveLocalPaths({ preview: false }, launchRoot, '  ').benchmarkOutput,
      undefined,
    );
  });
});
