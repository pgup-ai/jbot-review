import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

import { assertArenaPathIsolation, parseLocalArgs, resolveLocalPaths } from '../src/local/args.ts';

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
    assert.deepEqual(
      parseLocalArgs(['--pr-context', '/run/comparison.json', '--output', '/out/result.json']),
      {
        preview: false,
        prContext: '/run/comparison.json',
        output: '/out/result.json',
      },
    );
  });

  it('rejects unknown, duplicate, and missing-value arguments', () => {
    assert.throws(() => parseLocalArgs(['target']), /Unknown local review argument "target"/);
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
    assert.throws(() => parseLocalArgs(['--pr-context', '/run/c.json']), /supplied together/);
    assert.throws(() => parseLocalArgs(['--output', '/out/o.json']), /supplied together/);
    assert.throws(
      () => parseLocalArgs(['--preview', '--pr-context', '/run/c.json', '--output', '/out/o.json']),
      /cannot be combined with "--preview"/,
    );
    assert.throws(
      () =>
        parseLocalArgs([
          '--base',
          'main',
          '--pr-context',
          '/run/c.json',
          '--output',
          '/out/o.json',
        ]),
      /takes its base SHA/,
    );
  });

  it('resolves arena artifacts outside the workspace and rejects ambiguous paths', () => {
    const launchRoot = resolve('/tmp/jbot-target');
    assert.deepEqual(
      resolveLocalPaths(
        {
          preview: false,
          prContext: '/tmp/jbot-run/comparison.json',
          output: '/tmp/jbot-output/jbot-output.json',
        },
        launchRoot,
        undefined,
      ),
      {
        workspace: launchRoot,
        artifactRoot: '/tmp/jbot-output',
        prContext: '/tmp/jbot-run/comparison.json',
        arenaOutput: '/tmp/jbot-output/jbot-output.json',
      },
    );
    assert.throws(
      () =>
        resolveLocalPaths(
          { preview: false, prContext: 'comparison.json', output: '/tmp/out.json' },
          launchRoot,
          undefined,
        ),
      /paths must be absolute/,
    );
    assert.throws(
      () =>
        resolveLocalPaths(
          {
            preview: false,
            prContext: '/tmp/run.json',
            output: '/tmp/jbot-target/out.json',
          },
          launchRoot,
          undefined,
        ),
      /outside the reviewed workspace/,
    );
    assert.throws(
      () =>
        resolveLocalPaths(
          {
            preview: false,
            prContext: '/tmp/run.json',
            output: '/tmp/output.json',
          },
          launchRoot,
          'benchmark.json',
        ),
      /cannot be combined with JBOT_BENCHMARK_OUTPUT/,
    );
  });

  it('rejects symlinked context and output directories inside the real workspace', () => {
    const root = mkdtempSync(join(tmpdir(), 'jbot-arena-paths-'));
    const workspace = join(root, 'workspace');
    const outside = join(root, 'outside');
    try {
      mkdirSync(workspace);
      mkdirSync(outside);
      writeFileSync(join(workspace, 'comparison.json'), '{}');
      symlinkSync(join(workspace, 'comparison.json'), join(outside, 'comparison.json'));
      assert.throws(
        () =>
          assertArenaPathIsolation(
            workspace,
            join(outside, 'comparison.json'),
            join(outside, 'output.json'),
          ),
        /outside the reviewed workspace/,
      );
      rmSync(join(outside, 'comparison.json'));
      writeFileSync(join(outside, 'comparison.json'), '{}');
      symlinkSync(workspace, join(outside, 'workspace-link'));
      assert.throws(
        () =>
          assertArenaPathIsolation(
            workspace,
            join(outside, 'comparison.json'),
            join(outside, 'workspace-link', 'output.json'),
          ),
        /outside the reviewed workspace/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
