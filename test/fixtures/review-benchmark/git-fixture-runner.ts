import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const base = process.env.JBOT_LOCAL_BASE;
const output = process.env.JBOT_BENCHMARK_OUTPUT;
if (!base || !output) throw new Error('Git fixture runner requires benchmark paths.');
const diff = execFileSync('git', ['diff', `${base}...HEAD`], { encoding: 'utf8' });
if (!diff.includes("normalized === 'bash'"))
  throw new Error('Synthetic git diff was not materialized.');
writeFileSync(
  output,
  `${JSON.stringify({
    findings: [
      {
        path: 'src/shared/tool-telemetry.ts',
        line: 10,
        severity: 'P3',
        title: 'Dim exec diff classification',
        expectedFindingId: 'dim-exec-diff-classification-finding',
      },
    ],
  })}\n`,
);
