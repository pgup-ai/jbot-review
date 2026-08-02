import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ASSEMBLED_CONTEXT_WARN_BYTES,
  assembledContextWarning,
  createTelemetryRecorder,
} from '../src/shared/telemetry.ts';
import type { Finding, Severity } from '../src/shared/types.ts';

function finding(
  path: string,
  line: number,
  severity: Severity,
  extra: Partial<Finding> = {},
): Finding {
  return { path, line, severity, title: `t ${path}:${line}`, body: 'b', ...extra };
}

describe('createTelemetryRecorder (disabled = inert)', () => {
  it('returns findings unchanged and produces no rows when disabled', () => {
    const rec = createTelemetryRecorder(false);
    const input = [finding('a.ts', 1, 'P1')];
    const out = rec.produced('review', input);

    assert.deepEqual(out, input, 'findings pass through untouched');
    assert.equal(out[0].id, undefined, 'no id assigned when disabled');
    rec.snapshot('deduped', out);
    rec.route({ inline: out, fileLevel: [], orphaned: [], rescued: [], anchorMissed: [] });
    rec.beginRun({ runId: 'r', model: 'm' });
    rec.recordCoverage({ session: 's', state: 'completed' });
    rec.finishRun('completed', 1);
    assert.deepEqual(rec.findingRows(), []);
    assert.equal(rec.toJsonl(), '');
  });
});

describe('createTelemetryRecorder finding dispositions', () => {
  it('tags produced findings with stable ids and origin session', () => {
    const rec = createTelemetryRecorder(true);
    const [a, b] = rec.produced('review-shard-1', [
      finding('a.ts', 1, 'P1'),
      finding('b.ts', 2, 'P2'),
    ]);

    assert.equal(a.id, 'f1');
    assert.equal(b.id, 'f2');
    const rows = rec.findingRows();
    assert.equal(rows.find((r) => r.id === 'f1')?.session, 'review-shard-1');
  });

  it('marks a finding that survives every stage and posts inline', () => {
    const rec = createTelemetryRecorder(true);
    const [f] = rec.produced('review', [finding('a.ts', 5, 'P1')]);
    for (const stage of ['gated', 'deduped', 'suppressed', 'verified', 'filtered'] as const) {
      rec.snapshot(stage, [f]);
    }
    rec.route({ inline: [f], fileLevel: [], orphaned: [], rescued: [], anchorMissed: [] });

    assert.equal(rec.findingRows()[0].disposition, 'posted-inline');
  });

  it('detects the stage each dropped finding fell out at', () => {
    const rec = createTelemetryRecorder(true);
    const [dedup, supp, refute, sevfilt, posted] = rec.produced('review', [
      finding('a.ts', 1, 'P1'),
      finding('b.ts', 2, 'P1'),
      finding('c.ts', 3, 'P1'),
      finding('d.ts', 4, 'nit'),
      finding('e.ts', 5, 'P1'),
    ]);
    rec.snapshot('gated', [dedup, supp, refute, sevfilt, posted]);
    rec.snapshot('deduped', [supp, refute, sevfilt, posted]); // dedup dropped
    rec.snapshot('suppressed', [refute, sevfilt, posted]); // supp dropped
    rec.snapshot('verified', [sevfilt, posted]); // refute dropped
    rec.snapshot('filtered', [posted]); // sevfilt dropped
    rec.route({ inline: [posted], fileLevel: [], orphaned: [], rescued: [], anchorMissed: [] });

    const byId = new Map(rec.findingRows().map((r) => [r.id, r.disposition]));
    assert.equal(byId.get('f1'), 'deduped');
    assert.equal(byId.get('f2'), 'suppressed');
    assert.equal(byId.get('f3'), 'refuted');
    assert.equal(byId.get('f4'), 'severity-filtered');
    assert.equal(byId.get('f5'), 'posted-inline');
  });

  it('classifies a survivor correctly when an intermediate stage snapshot is omitted', () => {
    // The recorder is a general module: a caller may snapshot a subset of
    // stages. A finding present in the snapshots taken must still classify by
    // its last-present stage, not by a stage that was never recorded.
    const rec = createTelemetryRecorder(true);
    const [f] = rec.produced('review', [finding('a.ts', 1, 'P1')]);
    rec.snapshot('gated', [f]);
    rec.snapshot('filtered', [f]); // 'deduped'/'suppressed'/'verified' omitted
    rec.route({ inline: [f], fileLevel: [], orphaned: [], rescued: [], anchorMissed: [] });

    assert.equal(rec.findingRows()[0].disposition, 'posted-inline');
  });

  it('records the demote modifier when the low-confidence gate lowers severity', () => {
    const rec = createTelemetryRecorder(true);
    const [f] = rec.produced('review', [finding('a.ts', 1, 'P1', { confidence: 'low' })]);
    rec.snapshot('gated', [{ ...f, severity: 'P3' }]); // gate demoted P1→P3
    for (const stage of ['deduped', 'suppressed', 'verified', 'filtered'] as const) {
      rec.snapshot(stage, [{ ...f, severity: 'P3' }]);
    }
    rec.route({
      inline: [],
      fileLevel: [],
      orphaned: [{ ...f, severity: 'P3' }],
      rescued: [],
      anchorMissed: [],
    });

    const row = rec.findingRows()[0];
    assert.equal(row.demoted, true);
    assert.equal(row.disposition, 'orphaned');
  });

  it('flags a rescued finding distinctly and reports the re-anchored (posted) line', () => {
    const rec = createTelemetryRecorder(true);
    const [f] = rec.produced('review', [finding('a.ts', 99, 'P1', { evidence: 'const x = 1;' })]);
    for (const stage of ['gated', 'deduped', 'suppressed', 'verified', 'filtered'] as const) {
      rec.snapshot(stage, [f]);
    }
    f.line = 2; // rescue re-anchors the model's bad line 99 to the real added line
    rec.route({ inline: [f], fileLevel: [], orphaned: [], rescued: [f], anchorMissed: [] });

    const row = rec.findingRows()[0];
    assert.equal(row.disposition, 'rescued');
    assert.equal(row.hasEvidence, true);
    assert.equal(
      row.line,
      2,
      'telemetry line matches where the finding was posted, not the bad one',
    );
  });

  it('reports the posted line for a model-declared file-level finding', () => {
    const rec = createTelemetryRecorder(true);
    const [f] = rec.produced('review', [finding('a.ts', 0, 'P2')]);
    for (const stage of ['gated', 'deduped', 'suppressed', 'verified', 'filtered'] as const) {
      rec.snapshot(stage, [f]);
    }
    rec.route({ inline: [], fileLevel: [f], orphaned: [], rescued: [], anchorMissed: [] });

    const row = rec.findingRows()[0];
    assert.equal(row.disposition, 'posted-file-level');
    assert.equal(row.line, 0);
  });

  it('flags an anchor-missed finding and keeps the line the model claimed', () => {
    const rec = createTelemetryRecorder(true);
    const [f] = rec.produced('review', [finding('a.ts', 99, 'P2', { evidence: 'const x = 1;' })]);
    for (const stage of ['gated', 'deduped', 'suppressed', 'verified', 'filtered'] as const) {
      rec.snapshot(stage, [f]);
    }
    f.line = 0; // demoted to a file-level thread once anchoring failed
    rec.route({ inline: [], fileLevel: [f], orphaned: [], rescued: [], anchorMissed: [f] });

    const row = rec.findingRows()[0];
    assert.equal(row.disposition, 'anchor-missed');
    assert.equal(row.line, 99, 'the claimed line is the diagnostic, not the 0 it was demoted to');
  });

  it('serializes one JSONL line per finding row plus session rows', () => {
    const rec = createTelemetryRecorder(true);
    const [f] = rec.produced('review', [finding('a.ts', 1, 'P1')]);
    for (const stage of ['gated', 'deduped', 'suppressed', 'verified', 'filtered'] as const) {
      rec.snapshot(stage, [f]);
    }
    rec.route({ inline: [f], fileLevel: [], orphaned: [], rescued: [], anchorMissed: [] });
    rec.recordSession({
      session: 'review',
      model: 'deepseek/deepseek-v4-flash',
      inputTokens: 100,
      outputTokens: 20,
    });

    const lines = rec
      .toJsonl()
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    assert.ok(lines.some((l) => l.kind === 'finding' && l.disposition === 'posted-inline'));
    assert.ok(lines.some((l) => l.kind === 'session' && l.model === 'deepseek/deepseek-v4-flash'));
  });
});

describe('run and coverage telemetry', () => {
  it('emits a run header first with coverage rows carrying typed failure classes only', () => {
    const t = createTelemetryRecorder(true);
    t.beginRun({ runId: 'r1', baseSha: 'base', headSha: 'head', model: 'prov/model' });
    t.recordCoverage({
      session: 'review-shard-1',
      state: 'completed',
      durationMs: 1200,
      promptBytes: 64_000,
    });
    t.recordCoverage({
      session: 'review-interactions',
      state: 'failed',
      durationMs: 900_000,
      error: new Error('Request to https://secret.example/token?key=abc timed out after 900000ms'),
    });
    t.recordCoverage({ session: 'guideline-compliance', state: 'skipped' });
    t.finishRun('completed', 123_456);

    const lines = t
      .toJsonl()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(lines[0].kind, 'run');
    assert.equal(lines[0].schemaVersion, 1);
    assert.equal(lines[0].headSha, 'head');
    assert.equal(lines[0].terminalState, 'completed');
    assert.equal(lines[0].elapsedMs, 123_456);

    const coverage = lines.filter((line) => line.kind === 'coverage');
    assert.deepEqual(
      coverage.map((c) => [c.session, c.state, c.failureClass]),
      [
        ['review-shard-1', 'completed', undefined],
        ['review-interactions', 'failed', 'timeout'],
        ['guideline-compliance', 'skipped', undefined],
      ],
    );
    assert.equal(coverage[0].promptBytes, 64_000);
    // The redaction floor: only the class persists, never the error's own text.
    assert.doesNotMatch(t.toJsonl(), /secret\.example/);
  });

  it('classifies aborts, parse failures, provider errors, and defaults to unknown', () => {
    const t = createTelemetryRecorder(true);
    const cases: [string, string][] = [
      ['This operation was aborted', 'aborted'],
      ['Failed to parse review response as JSON', 'parse'],
      ['429 Too Many Requests from upstream', 'provider'],
      ['fetch failed: ECONNRESET', 'provider'],
      ['something inexplicable', 'unknown'],
    ];
    for (const [message] of cases) {
      t.recordCoverage({ session: message, state: 'failed', error: new Error(message) });
    }
    const rows = t
      .toJsonl()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((line) => line.kind === 'coverage');
    assert.deepEqual(
      rows.map((r) => r.failureClass),
      cases.map(([, cls]) => cls),
    );
  });

  it('warns only when an assembled session context exceeds the byte gate', () => {
    assert.equal(assembledContextWarning('review-shard-1', 1000), undefined);
    const warning = assembledContextWarning('review-shard-1', ASSEMBLED_CONTEXT_WARN_BYTES + 1);
    assert.match(warning ?? '', /review-shard-1/);
  });
});
