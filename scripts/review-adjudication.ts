import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  adjudicateHistoricalCandidates,
  type AdjudicationLabel,
  type HistoricalFindingCandidate,
} from '../src/shared/benchmark-adjudication.ts';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) return process.argv[index + 1];
  return process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function jsonLines<T>(path: string): T[] {
  return readFileSync(resolve(path), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

const candidatesPath = argument('candidates');
const labelsPath = argument('labels');
const output = argument('output');
if (!candidatesPath || !labelsPath || !output) {
  throw new Error(
    'usage: review-adjudication.ts --candidates <candidates.jsonl> --labels <labels.jsonl> --output <directory>',
  );
}

const results = adjudicateHistoricalCandidates(
  jsonLines<HistoricalFindingCandidate>(candidatesPath),
  jsonLines<AdjudicationLabel>(labelsPath),
);
const outputDir = resolve(output);
mkdirSync(outputDir, { recursive: true });
writeFileSync(resolve(outputDir, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
writeFileSync(
  resolve(outputDir, 'disagreements.jsonl'),
  results
    .filter((result) => result.status === 'disagreement')
    .map((result) => JSON.stringify(result))
    .join('\n') + (results.some((result) => result.status === 'disagreement') ? '\n' : ''),
);
