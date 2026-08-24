import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  classifyReviewOutput,
  parseCompareArgs,
  renderComparison,
  type CompareResult,
} from '../src/shared/review-compare.ts';

function main(): void {
  const args = parseCompareArgs(process.argv.slice(2));
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const outputDir = mkdtempSync(join(tmpdir(), 'jbot-compare-'));
  const results: CompareResult[] = [];

  try {
    for (const model of args.models) {
      // Model ids carry slashes; artifact filenames cannot.
      const output = join(outputDir, `${model.replace(/[^a-zA-Z0-9._-]+/g, '-')}.json`);
      console.log(`\n=== ${model} ===`);
      const started = Date.now();
      const run = spawnSync(
        process.execPath,
        [
          '--import',
          'tsx',
          join(projectRoot, 'src/local/index.ts'),
          ...(args.workspace ? ['--workspace', args.workspace] : []),
          ...(args.base ? ['--base', args.base] : []),
        ],
        {
          cwd: projectRoot,
          stdio: ['ignore', 'inherit', 'inherit'],
          env: {
            ...process.env,
            MODEL: model,
            // A stale PROVIDER pin would swallow the qualified model id.
            PROVIDER: '',
            JBOT_BENCHMARK_DRY_RUN: 'true',
            JBOT_BENCHMARK_OUTPUT: output,
          },
        },
      );
      const seconds = Math.round((Date.now() - started) / 1000);
      // One model failing must not lose the models that already ran.
      results.push({
        model,
        seconds,
        ...(run.status === 0
          ? classifyReviewOutput(existsSync(output) ? readFileSync(output, 'utf8') : undefined)
          : { findings: [], error: run.error?.message ?? `exit ${run.status ?? run.signal}` }),
      });
    }

    console.log(`\n${renderComparison(results)}`);
  } finally {
    try {
      rmSync(outputDir, { recursive: true, force: true });
    } catch (error) {
      // Never let teardown replace the result being reported.
      console.error(`compare: temp cleanup failed: ${String(error)}`);
    }
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
