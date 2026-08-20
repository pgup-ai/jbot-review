import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  adjudicateHistoricalCandidates,
  type AdjudicationLabel,
  type HistoricalFindingCandidate,
} from '../src/shared/benchmark-adjudication.ts';
import { benchmarkArgument, readJsonLines } from './benchmark-args.ts';

const candidatesPath = benchmarkArgument('candidates');
const labelsPath = benchmarkArgument('labels');
const output = benchmarkArgument('output');
if (!candidatesPath || !labelsPath || !output) {
  throw new Error(
    'usage: review-adjudication.ts --candidates <candidates.jsonl> --labels <labels.jsonl> --output <directory>',
  );
}

const results = adjudicateHistoricalCandidates(
  readJsonLines<HistoricalFindingCandidate>(candidatesPath),
  readJsonLines<AdjudicationLabel>(labelsPath),
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
