import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyEvidenceTrace, type EvidenceTraceRow } from '../src/shared/evidence-baseline.ts';

test('classifies each call against the supplied evidence and the session’s earlier reads', () => {
  const read = (file: string, offset: number, limit: number, status = 'completed') => ({
    name: 'read',
    toolClass: 'file-read',
    input: { filePath: `/ws/${file}`, offset, limit },
    status,
  });
  const turn = (calls: EvidenceTraceRow['calls']): EvidenceTraceRow => ({
    label: 'review-shard-1',
    sessionID: 's',
    workspace: '/ws',
    prompt: '',
    supplied: {
      ranges: [['a.ts', [[1, 20]]]],
      lines: [['a.ts', 100]],
      symbols: [],
      directories: [],
    },
    calls,
  });
  const calls = classifyEvidenceTrace(
    [
      turn([read('a.ts', 1, 20), read('b.ts', 1, 50), read('c.ts', 1, 10, 'error')]),
      turn([
        read('b.ts', 10, 20),
        { name: 'grep', toolClass: 'search', input: { pattern: 'foo' }, status: 'completed' },
        read('c.ts', 1, 10),
      ]),
    ],
    [{ path: 'b.ts', line: 10 }],
  );
  assert.deepEqual(
    calls.map((call) => [call.class, call.cited]),
    [
      ['supplied', false],
      ['new', true],
      ['new', false],
      ['repeat', true],
      ['unlocated', false],
      // The failed read did not show c.ts, so this one is still new.
      ['new', false],
    ],
  );
});
