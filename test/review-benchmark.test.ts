import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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

      const rescoredOutput = join(root, 'rescored');
      execFileSync(
        TSX,
        [
          join(ROOT, 'scripts/review-benchmark.ts'),
          '--manifest',
          MANIFEST,
          '--output',
          rescoredOutput,
          '--subset',
          'smoke',
          '--repetitions',
          '1',
          '--adjudicated-cases',
          join(output, 'cases.jsonl'),
        ],
        { encoding: 'utf8', stdio: 'pipe' },
      );
      const rescored = JSON.parse(readFileSync(join(rescoredOutput, 'summary.json'), 'utf8')) as {
        qualityGate: { status: string; passed: boolean | null };
      };
      assert.equal(rescored.qualityGate.status, 'passed');
      assert.equal(rescored.qualityGate.passed, true);

      const incompleteRows = readFileSync(join(output, 'cases.jsonl'), 'utf8').trim().split('\n');
      incompleteRows.pop();
      const incompletePath = join(root, 'incomplete.jsonl');
      writeFileSync(incompletePath, `${incompleteRows.join('\n')}\n`);
      assert.throws(
        () =>
          execFileSync(
            TSX,
            [
              join(ROOT, 'scripts/review-benchmark.ts'),
              '--manifest',
              MANIFEST,
              '--output',
              join(root, 'incomplete-output'),
              '--subset',
              'smoke',
              '--repetitions',
              '1',
              '--adjudicated-cases',
              incompletePath,
            ],
            { encoding: 'utf8', stdio: 'pipe' },
          ),
        /expected 24/,
      );
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
        cases: Array<Record<string, unknown> & { id: string }>;
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
      const hooks = join(root, 'ambient-hooks');
      mkdirSync(hooks);
      writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\nexit 1\n');
      chmodSync(join(hooks, 'pre-commit'), 0o755);
      const output = join(root, 'output');
      execFileSync(
        TSX,
        [join(ROOT, 'scripts/review-benchmark.ts'), '--manifest', manifestPath, '--output', output],
        {
          encoding: 'utf8',
          stdio: 'pipe',
          env: {
            ...process.env,
            GIT_CONFIG_COUNT: '1',
            GIT_CONFIG_KEY_0: 'core.hooksPath',
            GIT_CONFIG_VALUE_0: hooks,
          },
        },
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

      const additionCase = {
        ...largeCase,
        expectedClean: true,
        expectedFindings: [],
        categories: ['clean'],
        subsets: ['full'],
      };
      delete additionCase.counterfactualCaseId;
      source.cases = [additionCase];
      source.runner.command = [
        process.execPath,
        '-e',
        "require('node:fs').writeFileSync(process.env.JBOT_BENCHMARK_OUTPUT, '{\"findings\":[]}\\n')",
      ];
      const additionCorpus = Buffer.from(
        JSON.stringify({
          cases: [
            {
              id: additionCase.id,
              shape: { files: 1, additions: 1, deletions: 0, patchBytes: 20 },
              files: [{ path: 'new.ts', patch: '@@ -0,0 +1,1 @@\n+new\n' }],
              findings: [],
              telemetry: [],
            },
          ],
        }),
      );
      const additionHash = createHash('sha256')
        .update(benchmarkCanonicalJson(source.cases))
        .update('')
        .update(additionCorpus)
        .digest('hex');
      source.corpusHash = `sha256:${additionHash}`;
      source.control.configuration.corpusHash = source.corpusHash;
      source.treatment.configuration.corpusHash = source.corpusHash;
      writeFileSync(join(root, 'corpus.json'), additionCorpus);
      writeFileSync(manifestPath, JSON.stringify(source));
      const additionOutput = join(root, 'addition-output');
      execFileSync(
        TSX,
        [
          join(ROOT, 'scripts/review-benchmark.ts'),
          '--manifest',
          manifestPath,
          '--output',
          additionOutput,
        ],
        { encoding: 'utf8', stdio: 'pipe' },
      );
      const additionSummary = JSON.parse(
        readFileSync(join(additionOutput, 'summary.json'), 'utf8'),
      ) as { control: { successfulRuns: number }; treatment: { successfulRuns: number } };
      assert.equal(additionSummary.control.successfulRuns, 1);
      assert.equal(additionSummary.treatment.successfulRuns, 1);

      const noOpCorpus = Buffer.from(
        JSON.stringify({
          cases: [
            {
              id: additionCase.id,
              shape: { files: 1, additions: 0, deletions: 0, patchBytes: 20 },
              files: [{ path: 'same.ts', patch: '@@ -1,1 +1,1 @@\n unchanged\n' }],
              findings: [],
              telemetry: [],
            },
          ],
        }),
      );
      const noOpHash = createHash('sha256')
        .update(benchmarkCanonicalJson(source.cases))
        .update('')
        .update(noOpCorpus)
        .digest('hex');
      source.corpusHash = `sha256:${noOpHash}`;
      source.control.configuration.corpusHash = source.corpusHash;
      source.treatment.configuration.corpusHash = source.corpusHash;
      writeFileSync(join(root, 'corpus.json'), noOpCorpus);
      writeFileSync(manifestPath, JSON.stringify(source));
      const noOpOutput = join(root, 'no-op-output');
      execFileSync(
        TSX,
        [
          join(ROOT, 'scripts/review-benchmark.ts'),
          '--manifest',
          manifestPath,
          '--output',
          noOpOutput,
        ],
        { encoding: 'utf8', stdio: 'pipe' },
      );
      const noOpSummary = JSON.parse(readFileSync(join(noOpOutput, 'summary.json'), 'utf8')) as {
        control: { failedRuns: number };
        treatment: { failedRuns: number };
      };
      assert.equal(noOpSummary.control.failedRuns, 1);
      assert.equal(noOpSummary.treatment.failedRuns, 1);
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
        assert.ok(summary.qualityGate.reasons.some((reason) => /did not complete/.test(reason)));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
});
