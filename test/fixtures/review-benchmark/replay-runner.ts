import { readFileSync, writeFileSync } from 'node:fs';

interface FixtureCase {
  id: string;
  findings: unknown[];
  telemetry: Record<string, unknown>[];
}

const fixturePath = process.env.JBOT_BENCHMARK_FIXTURE;
const outputPath = process.env.JBOT_BENCHMARK_OUTPUT;
const caseId = process.env.JBOT_BENCHMARK_CASE;
if (!fixturePath || !outputPath || !caseId || process.env.JBOT_BENCHMARK_DRY_RUN !== 'true') {
  throw new Error('Replay runner requires the benchmark dry-run environment.');
}
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as { cases: FixtureCase[] };
const benchmarkCase = fixture.cases.find((item) => item.id === caseId);
if (!benchmarkCase) throw new Error(`Fixture case not found: ${caseId}.`);
writeFileSync(
  outputPath,
  `${JSON.stringify({
    findings: benchmarkCase.findings,
    telemetry: benchmarkCase.telemetry.map((row) => JSON.stringify(row)).join('\n'),
  })}\n`,
);
