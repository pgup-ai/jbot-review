import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { deriveBenchmarkLedgerRow } from '../src/shared/benchmark-ledger.ts';

export function armFixture(model: string) {
  return {
    name: `${model}-arm`,
    configuration: {
      model,
      modelRevision: '2026-08-01',
      engine: 'opencode',
      engineVersion: '1.0.0',
      reasoningEffort: 'medium',
      promptVersion: 'v42',
      sampling: { temperature: 0 },
      corpusHash: 'sha256:corpus',
      config: { OPENCODE_BASE_URL: 'https://secret-endpoint.example' },
    },
    runs: 36,
    successfulRuns: 35,
    failedRuns: 1,
    timedOutRuns: 0,
    program: {
      inputTokens: 1000,
      outputTokens: 200,
      reasoningTokens: 300,
      cacheReadTokens: 50,
      costUsd: 1.25,
      sessions: 12,
    },
    variance: {
      status: 'reportable',
      cases: 12,
      minRepetitions: 3,
      maxRepetitions: 3,
      findingAgreement: 0.9,
      latencyRelativeMad: 0.1,
    },
    score: {
      severityWeightedRecall: { value: 0.8, ci95: { low: 0.7, high: 0.9 } },
      precision: { value: 0.9, ci95: null },
      cleanFalsePositiveRate: { value: 0.05, ci95: null },
      missedBySeverity: { P0: 0, P1: 1, P2: 1, P3: 2, nit: 0 },
      latencyMs: {
        median: { value: 60000, ci95: null },
        p90: { value: 80000, ci95: null },
        p95: { value: 90000, ci95: null },
      },
      costPerRetainedFindingUsd: { value: 0.1, ci95: null },
    },
  };
}

export function summaryFixture(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    generatedAt: '2026-08-23T10:00:00.000Z',
    corpusHash: 'sha256:corpus',
    subset: 'core',
    subsetCases: 60,
    repetitions: 3,
    control: armFixture('model-a'),
    treatment: armFixture('model-b'),
    qualityGate: {
      status: 'passed',
      passed: true,
      reasons: [],
      semanticAdjudication: {},
    },
    mergeGate: { satisfied: false, missing: ['rollback instruction'] },
    treatmentCommit: 'headsha',
    ...overrides,
  };
}

const CONTEXT = { jbotSha: 'headsha', branch: 'feat/x' };

describe('deriveBenchmarkLedgerRow', () => {
  it('derives a sanitized two-arm row from a benchmark summary', () => {
    const row = deriveBenchmarkLedgerRow(summaryFixture(), {
      ...CONTEXT,
      auditDoc: 'docs/audits/2026-08-23-example.md',
    });
    assert.equal(row.date, '2026-08-23T10:00:00.000Z');
    assert.equal(row.jbotSha, 'headsha');
    assert.equal(row.branch, 'feat/x');
    assert.equal(row.corpusHash, 'sha256:corpus');
    assert.equal(row.subset, 'core');
    assert.equal(row.subsetCases, 60);
    assert.equal(row.repetitions, 3);
    assert.equal(row.gate, 'passed');
    assert.deepEqual(row.gateReasons, []);
    assert.equal(row.mergeGateSatisfied, false);
    assert.equal(row.auditDoc, 'docs/audits/2026-08-23-example.md');
    assert.equal(row.treatment.model, 'model-b');
    assert.equal(row.treatment.severityWeightedRecall, 0.8);
    assert.equal(row.treatment.precision, 0.9);
    assert.equal(row.treatment.cleanFalsePositiveRate, 0.05);
    assert.equal(row.treatment.missedP0, 0);
    assert.equal(row.treatment.missedP1, 1);
    assert.equal(row.treatment.latencyP50Ms, 60000);
    assert.equal(row.treatment.latencyP95Ms, 90000);
    assert.equal(row.treatment.inputTokens, 1000);
    assert.equal(row.treatment.variance, 'reportable');
    assert.equal(row.control.successfulRuns, 35);
    assert.equal(row.control.failedRuns, 1);
    // Sanitization is structural: the row never carries endpoints, sampling,
    // env config, or spend, no matter what the summary held.
    const serialized = JSON.stringify(row);
    assert.ok(!serialized.includes('secret-endpoint.example'));
    assert.ok(!serialized.includes('costUsd'));
    assert.ok(!serialized.includes('sampling'));
    assert.deepEqual(Object.keys(row.control).sort(), [
      'cacheReadTokens',
      'cleanFalsePositiveRate',
      'engine',
      'engineVersion',
      'failedRuns',
      'inputTokens',
      'latencyP50Ms',
      'latencyP95Ms',
      'missedP0',
      'missedP1',
      'model',
      'modelRevision',
      'name',
      'outputTokens',
      'precision',
      'promptVersion',
      'reasoningEffort',
      'reasoningTokens',
      'severityWeightedRecall',
      'successfulRuns',
      'variance',
    ]);
    assert.deepEqual(
      Object.keys(row).sort(),
      [
        'auditDoc',
        'branch',
        'control',
        'corpusHash',
        'date',
        'gate',
        'gateReasons',
        'jbotSha',
        'mergeGateSatisfied',
        'repetitions',
        'resultsHash',
        'schemaVersion',
        'subset',
        'subsetCases',
        'treatment',
      ].sort(),
    );
    // Null metric values (a zero denominator — e.g. precision with no
    // retained findings) flow through as null rather than throwing.
    const nullArm = armFixture('model-c');
    nullArm.score.precision = { value: null, ci95: null };
    const nullRow = deriveBenchmarkLedgerRow(summaryFixture({ treatment: nullArm }), CONTEXT);
    assert.equal(nullRow.treatment.precision, null);
  });

  it('rejects commit mismatches, malformed summaries, and unknown enums', () => {
    assert.throws(
      () => deriveBenchmarkLedgerRow(summaryFixture({ treatmentCommit: 'other' }), CONTEXT),
      /does not match HEAD/,
    );
    const { qualityGate: _omitted, ...withoutGate } = summaryFixture();
    assert.throws(() => deriveBenchmarkLedgerRow(withoutGate, CONTEXT), /qualityGate/);
    assert.throws(
      () =>
        deriveBenchmarkLedgerRow(
          summaryFixture({
            qualityGate: { status: 'sideways', passed: null, reasons: [] },
          }),
          CONTEXT,
        ),
      /qualityGate.status/,
    );
    assert.throws(() => deriveBenchmarkLedgerRow(null, CONTEXT), /benchmark summary/);
    const { treatmentCommit: _tc, ...withoutCommit } = summaryFixture();
    assert.throws(() => deriveBenchmarkLedgerRow(withoutCommit, CONTEXT), /treatmentCommit/);
  });

  it('computes a resultsHash that ignores key order', () => {
    const base = summaryFixture();
    const reordered = Object.fromEntries(Object.entries(base).reverse());
    const left = deriveBenchmarkLedgerRow(base, CONTEXT).resultsHash;
    const right = deriveBenchmarkLedgerRow(reordered, CONTEXT).resultsHash;
    assert.match(left, /^sha256:[0-9a-f]{64}$/);
    assert.equal(left, right);
    const changed = deriveBenchmarkLedgerRow(
      summaryFixture({ repetitions: 5 }),
      CONTEXT,
    ).resultsHash;
    assert.notEqual(left, changed);
  });
});
