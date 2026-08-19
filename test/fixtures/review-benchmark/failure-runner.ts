import { writeFileSync } from 'node:fs';

const output = process.env.JBOT_BENCHMARK_OUTPUT;
const mode = process.env.JBOT_TEST_RUNNER_MODE;
if (!output || !mode || process.env.JBOT_BENCHMARK_DRY_RUN !== 'true') {
  throw new Error('Failure runner requires the benchmark dry-run environment.');
}

if (mode === 'timeout') {
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  writeFileSync(output, '{"findings":[]}\n');
} else if (mode === 'runner-exit') {
  process.exitCode = 7;
} else if (mode === 'invalid-output') {
  writeFileSync(output, '{');
} else if (mode !== 'missing-output') {
  writeFileSync(output, '{"findings":[]}\n');
}
