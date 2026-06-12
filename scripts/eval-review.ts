/**
 * Scores review runs against the golden set. Each case directory under the
 * golden root contains:
 *
 *   expected-findings.json  — { exhaustive?, findings: ExpectedFinding[] }
 *   actual-findings.json    — ActualFinding[] from a dry-run / replay of the
 *                             reviewer on that PR (produce it per case, then
 *                             run this script to score the batch)
 *
 * Usage: npm run eval [-- fixtures/golden]
 * Exits non-zero when any mustFind finding was missed, so CI can gate prompt
 * and pipeline changes on golden-set recall.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  aggregateScores,
  scoreCase,
  type ActualFinding,
  type CaseScore,
  type GoldenCase,
} from '../src/shared/eval.ts';

const goldenRoot = process.argv[2] ?? 'fixtures/golden';

async function readJsonFile<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code: unknown }).code === 'ENOENT'
    ) {
      return undefined;
    }
    throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function formatPercent(value: number | undefined): string {
  return value === undefined ? 'n/a' : `${(value * 100).toFixed(0)}%`;
}

const scores: CaseScore[] = [];
const skipped: string[] = [];

const entries = await readdir(goldenRoot, { withFileTypes: true }).catch(() => {
  console.error(`Golden root not found: ${goldenRoot}`);
  process.exit(2);
});

for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
  if (!entry.isDirectory()) continue;
  const caseDir = join(goldenRoot, entry.name);
  const golden = await readJsonFile<GoldenCase>(join(caseDir, 'expected-findings.json'));
  if (!golden) continue;
  const actuals = await readJsonFile<ActualFinding[]>(join(caseDir, 'actual-findings.json'));
  if (!actuals) {
    skipped.push(entry.name);
    continue;
  }
  scores.push(scoreCase(entry.name, golden, actuals));
}

if (scores.length === 0) {
  console.error(`No scorable cases under ${goldenRoot} (need expected + actual findings JSON).`);
  if (skipped.length > 0) {
    console.error(`Cases missing actual-findings.json: ${skipped.join(', ')}`);
  }
  process.exit(2);
}

let missedAny = false;
for (const score of scores) {
  const recallText =
    score.mustFindCount > 0 ? `${score.mustFindMatched}/${score.mustFindCount}` : 'clean PR';
  console.log(
    `\n${score.name}: recall ${recallText}, noise candidates ${score.noiseCandidates.length}`,
  );
  for (const missed of score.missed) {
    missedAny = true;
    console.log(
      `  MISSED [${missed.category ?? 'uncategorized'}] ${missed.path}: ${missed.description}`,
    );
  }
  for (const noise of score.noiseCandidates) {
    const marker = score.exhaustive ? 'NOISE' : 'unlabeled';
    console.log(`  ${marker} ${noise.path}:${noise.line} ${noise.severity} ${noise.title}`);
  }
}

const aggregate = aggregateScores(scores);
console.log('\n=== Aggregate ===');
console.log(`Recall (mustFind): ${formatPercent(aggregate.recall)}`);
console.log(`Precision (exhaustive cases): ${formatPercent(aggregate.precision)}`);
console.log(
  `Noise per exhaustive case: ${aggregate.noisePerCase === undefined ? 'n/a' : aggregate.noisePerCase.toFixed(1)}`,
);
for (const [category, counts] of Object.entries(aggregate.perCategory).sort()) {
  console.log(`  ${category}: ${counts.matched}/${counts.expected}`);
}
if (skipped.length > 0) {
  console.log(`\nSkipped (no actual-findings.json): ${skipped.join(', ')}`);
}

process.exit(missedAny ? 1 : 0);
