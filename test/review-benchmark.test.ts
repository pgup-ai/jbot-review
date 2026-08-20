import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

import { validateBenchmarkManifest } from '../src/shared/benchmark-manifest.ts';

const ROOT = resolve(import.meta.dirname, '..');
const MANIFEST = join(ROOT, 'test/fixtures/review-benchmark/manifest.json');
const FAILURE_MANIFEST = join(ROOT, 'test/fixtures/review-benchmark/failure-manifest.json');
const TSX = join(ROOT, 'node_modules/.bin/tsx');

describe('review-benchmark', () => {
  it('rejects undeclared executable environment differences', () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as {
      treatment: { env?: Record<string, string> };
    };
    manifest.treatment.env = { JBOT_REASONING_EFFORT: 'low' };
    assert.throws(() => validateBenchmarkManifest(manifest), /env\.JBOT_REASONING_EFFORT/);
  });

  it('rejects non-clean cases without expected findings', () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as {
      cases: { id: string; expectedClean: boolean; expectedFindings: unknown[] }[];
    };
    const benchmarkCase = manifest.cases.find((candidate) => !candidate.expectedClean);
    assert.ok(benchmarkCase);
    benchmarkCase.expectedFindings = [];
    assert.throws(() => validateBenchmarkManifest(manifest), /must declare an expected finding/);
  });

  it('rejects an undeclared reasoning mismatch before executing a runner', () => {
    const root = mkdtempSync(join(tmpdir(), 'jbot-benchmark-test-'));
    try {
      const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as {
        treatment: { configuration: { reasoningEffort: string } };
      };
      manifest.treatment.configuration.reasoningEffort = 'low';
      const path = join(root, 'manifest.json');
      writeFileSync(path, JSON.stringify(manifest));
      assert.throws(
        () =>
          execFileSync(
            TSX,
            [
              join(ROOT, 'scripts/review-benchmark.ts'),
              '--manifest',
              path,
              '--output',
              join(root, 'output'),
            ],
            { encoding: 'utf8', stdio: 'pipe' },
          ),
        (error: unknown) => {
          const stderr = (error as { stderr?: string }).stderr ?? '';
          assert.match(stderr, /undeclared difference\(s\): reasoningEffort/);
          return true;
        },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('classifies failed runners and excludes them from quality scores', () => {
    const expected = {
      timeout: 'timeout',
      'runner-exit': 'runner-exit',
      signal: 'signal',
      'invalid-output': 'invalid-output',
      'missing-output': 'missing-output',
      spawn: 'spawn',
    } as const;

    for (const [mode, failureClass] of Object.entries(expected)) {
      const root = mkdtempSync(join(tmpdir(), 'jbot-benchmark-failure-test-'));
      try {
        const manifest = JSON.parse(readFileSync(FAILURE_MANIFEST, 'utf8')) as {
          timeoutMs: number;
          runner: { command: string[] };
          control: { env?: Record<string, string> };
          treatment: { env?: Record<string, string> };
        };
        if (mode === 'spawn') {
          manifest.runner.command = ['/jbot-review-missing-benchmark-runner'];
        } else if (mode === 'signal') {
          manifest.runner.command = [
            process.execPath,
            '-e',
            "process.kill(process.pid, 'SIGTERM')",
          ];
        } else {
          manifest.control.env = { JBOT_TEST_RUNNER_MODE: mode };
          manifest.treatment.env = { JBOT_TEST_RUNNER_MODE: mode };
        }
        if (mode === 'timeout') manifest.timeoutMs = 50;
        const path = join(root, 'manifest.json');
        const output = join(root, 'output');
        cpSync(join(ROOT, 'test/fixtures/review-benchmark/corpus.json'), join(root, 'corpus.json'));
        writeFileSync(path, JSON.stringify(manifest));
        execFileSync(
          TSX,
          [join(ROOT, 'scripts/review-benchmark.ts'), '--manifest', path, '--output', output],
          { encoding: 'utf8', stdio: 'pipe' },
        );
        const rows = readFileSync(join(output, 'cases.jsonl'), 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        assert.equal(rows.length, 2);
        assert.ok(
          rows.every((row) => row.failureClass === failureClass),
          `${mode}: ${JSON.stringify(rows)}`,
        );
        assert.ok(rows.every((row) => row.timedOut === (mode === 'timeout')));
        assert.ok(
          rows.every(
            (row) => row.signal === (mode === 'timeout' || mode === 'signal' ? 'SIGTERM' : null),
          ),
        );
        const summary = JSON.parse(readFileSync(join(output, 'summary.json'), 'utf8')) as Record<
          'control' | 'treatment',
          {
            successfulRuns: number;
            failedRuns: number;
            timedOutRuns: number;
            score: { cases: number };
          }
        >;
        for (const arm of [summary.control, summary.treatment]) {
          assert.equal(arm.successfulRuns, 0);
          assert.equal(arm.failedRuns, 1);
          assert.equal(arm.timedOutRuns, mode === 'timeout' ? 1 : 0);
          assert.equal(arm.score.cases, 0);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
});
