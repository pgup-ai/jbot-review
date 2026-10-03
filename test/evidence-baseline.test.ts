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
  const turn = (calls: EvidenceTraceRow['calls'], sessionID = 's'): EvidenceTraceRow => ({
    label: 'review-shard-1',
    sessionID,
    workspace: '/ws',
    prompt: '',
    complete: true,
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
      // Another session under the same label has not read b.ts.
      turn([read('b.ts', 10, 20)], 'other'),
    ],
    [
      { path: 'b.ts', line: 10 },
      { path: 'c.ts', line: 5 },
    ],
  );
  assert.deepEqual(
    calls.map((call) => [call.class, call.cited]),
    [
      ['supplied', false],
      ['new', true],
      // A failed read showed nothing, so it is neither cited nor seen.
      ['new', false],
      ['repeat', true],
      ['unlocated', false],
      ['new', true],
      ['new', true],
    ],
  );
});
