import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

import { validateBenchmarkManifest } from '../src/shared/benchmark-manifest.ts';
import { materializeBenchmarkFixture } from '../src/shared/benchmark-fixture.ts';
import { benchmarkCanonicalJson } from '../src/shared/benchmark-score.ts';

const ROOT = resolve(import.meta.dirname, '..');
const MANIFEST = join(ROOT, 'test/fixtures/review-benchmark/manifest.json');
const FAILURE_MANIFEST = join(ROOT, 'test/fixtures/review-benchmark/failure-manifest.json');
const TSX = join(ROOT, 'node_modules/.bin/tsx');

describe('review-benchmark', () => {
  it('loads the paired 100-case quality corpus and release subsets', () => {
    const manifest = validateBenchmarkManifest(JSON.parse(readFileSync(MANIFEST, 'utf8')));
    assert.equal(manifest.qualityCorpus, true);
    assert.equal(manifest.cases.length, 100);
    assert.equal(
      manifest.cases.filter((candidate) => candidate.subsets.includes('smoke')).length,
      12,
    );
    assert.equal(
      manifest.cases.filter((candidate) => candidate.subsets.includes('core')).length,
      60,
    );
    assert.ok(manifest.cases.every((candidate) => candidate.subsets.includes('full')));
    const defect = manifest.cases.find((candidate) => candidate.id === 'api-caller-contract');
    assert.ok(defect?.counterfactualCaseId);
    assert.equal(
      manifest.cases.find((candidate) => candidate.id === defect.counterfactualCaseId)
        ?.counterfactualOf,
      defect.id,
    );
    assert.equal(defect.expectedFindings[0].acceptableFindings.length, 2);
    assert.notEqual(
      defect.expectedFindings[0].anchors[0].path,
      defect.expectedFindings[0].requiredEvidence[0].path,
    );

    const fixture = JSON.parse(
      readFileSync(join(ROOT, 'test/fixtures/review-benchmark/corpus.json'), 'utf8'),
    ) as {
      cases: { id: string; shape: unknown; files: { path: string; patch: string }[] }[];
    };
    const fixtures = new Map(fixture.cases.map((candidate) => [candidate.id, candidate]));
    for (const candidate of manifest.cases.filter((item) => !item.expectedClean)) {
      const seeded = fixtures.get(candidate.id);
      const clean = fixtures.get(candidate.counterfactualCaseId!);
      assert.ok(seeded && clean);
      assert.deepEqual(seeded.shape, clean.shape);
      assert.deepEqual(
        seeded.files.map((file) => [file.path, file.patch.length]),
        clean.files.map((file) => [file.path, file.patch.length]),
      );
    }
    for (const candidate of manifest.cases) {
      assert.doesNotThrow(() => materializeBenchmarkFixture(fixture, candidate.id), candidate.id);
    }
  });

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

  it('rejects a broken counterfactual pair in the quality corpus', () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as {
      cases: { expectedClean: boolean; counterfactualCaseId?: string }[];
    };
    const defect = manifest.cases.find((candidate) => !candidate.expectedClean);
    assert.ok(defect);
    defect.counterfactualCaseId = 'missing-case';
    assert.throws(() => validateBenchmarkManifest(manifest), /counterfactual link/);
  });

  it('accepts immutable private case references without source in git', () => {
    const manifest = JSON.parse(readFileSync(FAILURE_MANIFEST, 'utf8')) as {
      cases: Array<{
        fixturePath?: string;
        privateCaseHash?: string;
        base: string;
        head: string;
      }>;
    };
    delete manifest.cases[0].fixturePath;
    manifest.cases[0].privateCaseHash = `sha256:${'a'.repeat(64)}`;
    manifest.cases[0].base = 'b'.repeat(40);
    manifest.cases[0].head = 'c'.repeat(40);
    assert.doesNotThrow(() => validateBenchmarkManifest(manifest));
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

  it('runs the smoke subset and emits an explicit quality gate', () => {
    const root = mkdtempSync(join(tmpdir(), 'jbot-benchmark-smoke-test-'));
    try {
      const output = join(root, 'output');
      execFileSync(
        TSX,
        [
          join(ROOT, 'scripts/review-benchmark.ts'),
          '--manifest',
          MANIFEST,
          '--output',
          output,
          '--subset',
          'smoke',
          '--repetitions',
          '1',
        ],
        { encoding: 'utf8', stdio: 'pipe' },
      );
      const summary = JSON.parse(readFileSync(join(output, 'summary.json'), 'utf8')) as {
        subset: string;
        subsetCases: number;
        qualityGate: {
          status: string;
          passed: boolean | null;
          reasons: string[];
          semanticAdjudication: {
            control: { complete: boolean };
            treatment: { complete: boolean };
          };
        };
        control: { variance: { status: string } };
      };
      assert.equal(summary.subset, 'smoke');
      assert.equal(summary.subsetCases, 12);
      assert.equal(summary.qualityGate.status, 'passed');
      assert.equal(summary.qualityGate.passed, true);
      assert.deepEqual(summary.qualityGate.reasons, []);
      assert.equal(summary.qualityGate.semanticAdjudication.control.complete, true);
      assert.equal(summary.qualityGate.semanticAdjudication.treatment.complete, true);
      assert.equal(summary.control.variance.status, 'insufficient-repetitions');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('materializes synthetic cases for the real local-review runner mode', () => {
    const root = mkdtempSync(join(tmpdir(), 'jbot-benchmark-git-fixture-test-'));
    try {
      const source = JSON.parse(readFileSync(MANIFEST, 'utf8')) as {
        corpusHash: string;
        qualityCorpus: boolean;
        repetitions: number;
        runner: { command: string[]; cwd: string; fixtureMode: string };
        control: { configuration: { corpusHash: string } };
        treatment: { configuration: { corpusHash: string } };
        cases: Array<{ id: string }>;
      };
      source.qualityCorpus = false;
      source.repetitions = 1;
      source.runner = {
        command: [
          '${projectRoot}/node_modules/.bin/tsx',
          '${projectRoot}/test/fixtures/review-benchmark/git-fixture-runner.ts',
        ],
        cwd: 'workspace',
        fixtureMode: 'git',
      };
      const largeCase = source.cases.find((candidate) => candidate.id === 'generated-source-edit');
      assert.ok(largeCase);
      source.cases = [largeCase];
      const corpus = readFileSync(join(ROOT, 'test/fixtures/review-benchmark/corpus.json'));
      const hash = createHash('sha256')
        .update(benchmarkCanonicalJson(source.cases))
        .update('')
        .update(corpus)
        .digest('hex');
      source.corpusHash = `sha256:${hash}`;
      source.control.configuration.corpusHash = source.corpusHash;
      source.treatment.configuration.corpusHash = source.corpusHash;
      writeFileSync(join(root, 'corpus.json'), corpus);
      const manifestPath = join(root, 'manifest.json');
      writeFileSync(manifestPath, JSON.stringify(source));
      const output = join(root, 'output');
      execFileSync(
        TSX,
        [join(ROOT, 'scripts/review-benchmark.ts'), '--manifest', manifestPath, '--output', output],
        { encoding: 'utf8', stdio: 'pipe' },
      );
      const summary = JSON.parse(readFileSync(join(output, 'summary.json'), 'utf8')) as {
        control: { successfulRuns: number };
        treatment: { successfulRuns: number };
        qualityGate: { status: string; passed: boolean | null };
      };
      assert.equal(summary.control.successfulRuns, 1);
      assert.equal(summary.treatment.successfulRuns, 1);
      assert.equal(summary.qualityGate.status, 'passed');
      assert.equal(summary.qualityGate.passed, true);
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
        const summary = JSON.parse(readFileSync(join(output, 'summary.json'), 'utf8')) as {
          control: {
            successfulRuns: number;
            failedRuns: number;
            timedOutRuns: number;
            score: { cases: number };
          };
          treatment: {
            successfulRuns: number;
            failedRuns: number;
            timedOutRuns: number;
            score: { cases: number };
          };
          qualityGate: { status: string; passed: boolean | null; reasons: string[] };
        };
        for (const arm of [summary.control, summary.treatment]) {
          assert.equal(arm.successfulRuns, 0);
          assert.equal(arm.failedRuns, 1);
          assert.equal(arm.timedOutRuns, mode === 'timeout' ? 1 : 0);
          assert.equal(arm.score.cases, 0);
        }
        assert.equal(summary.qualityGate.status, 'failed');
        assert.equal(summary.qualityGate.passed, false);
        assert.match(summary.qualityGate.reasons[0], /did not complete/);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
});
