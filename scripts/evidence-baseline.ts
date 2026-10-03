import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyEvidenceTrace, type EvidenceTraceRow } from '../src/shared/evidence-baseline.ts';
import { benchmarkArgument, readJsonLines } from './benchmark-args.ts';

const trace = benchmarkArgument('trace');
if (!trace)
  throw new Error(
    'Usage: tsx scripts/evidence-baseline.ts --trace <JBOT_TRANSCRIPT_DIR> [--telemetry <telemetry.jsonl>]',
  );
const telemetry = benchmarkArgument('telemetry');
const findings = telemetry
  ? readJsonLines<{ kind: string; path: string; line: number }>(telemetry).filter(
      (row) => row.kind === 'finding',
    )
  : [];
const calls = classifyEvidenceTrace(
  readJsonLines<EvidenceTraceRow>(join(trace, 'evidence-trace.jsonl')),
  findings,
);
writeFileSync(
  join(trace, 'evidence-calls.jsonl'),
  calls.map((call) => JSON.stringify(call)).join('\n') + '\n',
);
const table = new Map<string, Record<string, number>>();
for (const call of calls) {
  const row = table.get(call.label) ?? {
    calls: 0,
    supplied: 0,
    repeat: 0,
    new: 0,
    'new cited': 0,
    unlocated: 0,
  };
  table.set(call.label, row);
  row.calls++;
  row[call.class]++;
  if (call.class === 'new' && call.cited) row['new cited']++;
}
console.table(Object.fromEntries([...table].sort(([a], [b]) => a.localeCompare(b))));
console.log(`Classified calls written to ${join(trace, 'evidence-calls.jsonl')}`);
