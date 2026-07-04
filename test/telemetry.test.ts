import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createTelemetryRecorder } from '../src/shared/telemetry.ts';
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
    rec.route({ inline: out, fileLevel: [], orphaned: [], rescued: [] });
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
    rec.route({ inline: [f], fileLevel: [], orphaned: [], rescued: [] });

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
    rec.route({ inline: [posted], fileLevel: [], orphaned: [], rescued: [] });

    const byId = new Map(rec.findingRows().map((r) => [r.id, r.disposition]));
    assert.equal(byId.get('f1'), 'deduped');
    assert.equal(byId.get('f2'), 'suppressed');
    assert.equal(byId.get('f3'), 'refuted');
    assert.equal(byId.get('f4'), 'severity-filtered');
    assert.equal(byId.get('f5'), 'posted-inline');
  });

  it('records the demote modifier when the low-confidence gate lowers severity', () => {
    const rec = createTelemetryRecorder(true);
    const [f] = rec.produced('review', [finding('a.ts', 1, 'P1', { confidence: 'low' })]);
    rec.snapshot('gated', [{ ...f, severity: 'P3' }]); // gate demoted P1→P3
    for (const stage of ['deduped', 'suppressed', 'verified', 'filtered'] as const) {
      rec.snapshot(stage, [{ ...f, severity: 'P3' }]);
    }
    rec.route({ inline: [], fileLevel: [], orphaned: [{ ...f, severity: 'P3' }], rescued: [] });

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
    rec.route({ inline: [f], fileLevel: [], orphaned: [], rescued: [f] });

    const row = rec.findingRows()[0];
    assert.equal(row.disposition, 'rescued');
    assert.equal(row.hasEvidence, true);
    assert.equal(
      row.line,
      2,
      'telemetry line matches where the finding was posted, not the bad one',
    );
  });

  it('serializes one JSONL line per finding row plus session rows', () => {
    const rec = createTelemetryRecorder(true);
    const [f] = rec.produced('review', [finding('a.ts', 1, 'P1')]);
    for (const stage of ['gated', 'deduped', 'suppressed', 'verified', 'filtered'] as const) {
      rec.snapshot(stage, [f]);
    }
    rec.route({ inline: [f], fileLevel: [], orphaned: [], rescued: [] });
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
