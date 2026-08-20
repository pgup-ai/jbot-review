import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  adjudicateHistoricalCandidates,
  type AdjudicationLabel,
  type HistoricalFindingCandidate,
} from '../src/shared/benchmark-adjudication.ts';
import { benchmarkArgument } from './benchmark-args.ts';

function jsonLines<T>(path: string): T[] {
  return readFileSync(resolve(path), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

const candidatesPath = benchmarkArgument('candidates');
const labelsPath = benchmarkArgument('labels');
const output = benchmarkArgument('output');
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
const disagreements = results
  .filter((result) => result.status === 'disagreement')
  .map((result) => JSON.stringify(result));
writeFileSync(
  resolve(outputDir, 'disagreements.jsonl'),
  disagreements.length > 0 ? `${disagreements.join('\n')}\n` : '',
);
