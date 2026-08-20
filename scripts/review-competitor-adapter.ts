import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  assessCompetitorComparability,
  normalizeCompetitorFindings,
  type CompetitorAdapter,
  type CompetitorModelConfiguration,
} from '../src/shared/benchmark-adapter.ts';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) return process.argv[index + 1];
  return process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
}

const adapter = argument('adapter') as CompetitorAdapter | undefined;
const input = argument('input');
const controlConfig = argument('control-config');
const competitorConfig = argument('competitor-config');
const output = argument('output');
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
