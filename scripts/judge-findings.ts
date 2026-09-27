// Quick-screen scorer: jbot benchmark outputs (JBOT_BENCHMARK_OUTPUT JSON) against reference
// comments, matched by the AACR-Bench judge instead of keywords.
//   npm run judge:findings -- --references refs.json --results results.json --judge-model M [--line-window 1|none] [--concurrency 4]
// refs.json: [{caseId, references: JudgeComment[]}]; results.json: {caseId: pathToJbotOutput}.
import { readFileSync } from 'node:fs';

import { toJudgeComments } from '../src/shared/aacr-bench.ts';
import { scoreCases, type JudgeComment } from '../src/shared/benchmark-judge.ts';
import { startOpencodeJudge } from '../src/shared/semantic-judge.ts';
import type { Finding } from '../src/shared/types.ts';
import { benchmarkArgument } from './benchmark-args.ts';

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;
const references = readJson<{ caseId: string; references: JudgeComment[] }[]>(
  benchmarkArgument('references') ?? '',
);
const results = readJson<Record<string, string>>(benchmarkArgument('results') ?? '');
const judgeModel = benchmarkArgument('judge-model');
if (!judgeModel) throw new Error('--judge-model is required.');
const lineWindow = benchmarkArgument('line-window') ?? '1';

const judge = await startOpencodeJudge(judgeModel, Number(benchmarkArgument('concurrency') ?? '4'));
try {
  const cases = references.map(({ caseId, references: refs }) => {
    // A missing run is an error, not a review that found nothing.
    if (!results[caseId]) throw new Error(`No result for case ${caseId}.`);
    const { findings } = readJson<{ findings: Finding[] }>(results[caseId]);
    return { caseId, references: refs, generated: toJudgeComments(findings) };
  });
  const scored = await scoreCases(
    cases,
    judge.sameConcern,
    lineWindow === 'none' ? Infinity : Number(lineWindow),
  );
  for (const item of scored.cases) {
    const input = cases.find((c) => c.caseId === item.caseId)!;
    console.log(
      `${item.caseId}: ${item.counts.semanticMatched}/${item.counts.expected} matched, ${item.counts.generated} generated`,
    );
    for (const { reference, generated } of item.matches)
      console.log(
        `   ✓ ${input.references[reference]!.note.slice(0, 80)}  ⇐  ${input.generated[generated]!.note.split('\n')[0]!.slice(0, 80)}`,
      );
  }
  console.log(
    JSON.stringify(
      {
        judgeModel,
        lineWindow,
        counts: scored.counts,
        metrics: scored.metrics,
        judge: judge.stats,
      },
      null,
      2,
    ),
  );
} finally {
  judge.stop();
}
