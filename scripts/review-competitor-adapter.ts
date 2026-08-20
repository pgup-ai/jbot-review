import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  assessCompetitorComparability,
  normalizeCompetitorFindings,
  type CompetitorAdapter,
  type CompetitorModelConfiguration,
} from '../src/shared/benchmark-adapter.ts';
import { benchmarkArgument } from './benchmark-args.ts';

const adapter = benchmarkArgument('adapter') as CompetitorAdapter | undefined;
const input = benchmarkArgument('input');
const controlConfig = benchmarkArgument('control-config');
const competitorConfig = benchmarkArgument('competitor-config');
const output = benchmarkArgument('output');
if (!adapter || !input || !controlConfig || !competitorConfig || !output) {
  throw new Error(
    'usage: review-competitor-adapter.ts --adapter <benchmark-json|github-review|sarif> --input <json> --control-config <json> --competitor-config <json> --output <json>',
  );
}

const parse = <T>(path: string): T => JSON.parse(readFileSync(resolve(path), 'utf8')) as T;
const comparability = assessCompetitorComparability(
  parse<CompetitorModelConfiguration>(controlConfig),
  parse<CompetitorModelConfiguration>(competitorConfig),
);
writeFileSync(
  resolve(output),
  `${JSON.stringify(
    {
      adapter,
      findings: normalizeCompetitorFindings(adapter, parse(input)),
      rankingEligible: comparability.sameModelComparable,
      comparability,
    },
    null,
    2,
  )}\n`,
);
