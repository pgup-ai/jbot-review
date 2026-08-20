import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const base = process.env.JBOT_LOCAL_BASE;
const output = process.env.JBOT_BENCHMARK_OUTPUT;
if (!base || !output) throw new Error('Git fixture runner requires benchmark paths.');
const diff = execFileSync('git', ['diff', `${base}...HEAD`], { encoding: 'utf8' });
if (!diff.includes('export const version = 3;'))
  throw new Error('Synthetic git diff was not materialized.');
const stats = execFileSync('git', ['diff', '--numstat', `${base}...HEAD`], {
  encoding: 'utf8',
})
  .trim()
  .split('\n')
  .map((line) => line.split('\t'));
const additions = stats.reduce((sum, [value]) => sum + Number(value), 0);
const deletions = stats.reduce((sum, [, value]) => sum + Number(value), 0);
if (
  stats.length !== 18 ||
  additions !== 800 ||
  deletions !== 200 ||
  Buffer.byteLength(diff) < 100_000
) {
  throw new Error('Synthetic git diff does not match its declared shape.');
}
writeFileSync(
  output,
  `${JSON.stringify({
    findings: [
      {
        path: 'generated/client.ts',
        line: 10,
        severity: 'P2',
        title: 'Generated client schema drift',
        expectedFindingId: 'generated-source-edit-finding',
        triggerComplete: true,
        evidenceSupported: true,
      },
    ],
  })}\n`,
);
