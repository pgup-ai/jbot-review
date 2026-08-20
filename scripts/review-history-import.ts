import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  blindAdjudicationCase,
  importHistoricalFinding,
  type HistoricalFindingSignal,
} from '../src/shared/benchmark-adjudication.ts';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) return process.argv[index + 1];
  return process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
}

const input = argument('input');
const output = argument('output');
if (!input || !output) {
  throw new Error('usage: review-history-import.ts --input <signals.jsonl> --output <directory>');
}

const candidates = readFileSync(resolve(input), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => importHistoricalFinding(JSON.parse(line) as HistoricalFindingSignal));
const outputDir = resolve(output);
mkdirSync(outputDir, { recursive: true });
writeFileSync(
  resolve(outputDir, 'candidates.jsonl'),
  candidates.map((candidate) => JSON.stringify(candidate)).join('\n') + '\n',
);
writeFileSync(
  resolve(outputDir, 'blind.jsonl'),
  candidates.map((candidate) => JSON.stringify(blindAdjudicationCase(candidate))).join('\n') + '\n',
);
writeFileSync(
  resolve(outputDir, 'summary.json'),
  `${JSON.stringify(
    {
      imported: candidates.length,
      outcomes: Object.fromEntries(
        [...new Set(candidates.map((candidate) => candidate.outcomeCandidate))].map((outcome) => [
          outcome,
          candidates.filter((candidate) => candidate.outcomeCandidate === outcome).length,
        ]),
      ),
    },
    null,
    2,
  )}\n`,
);
