import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  deriveBenchmarkLedgerRow,
  type BenchmarkLedgerRow,
} from '../src/shared/benchmark-ledger.ts';
import { benchmarkArgument, readJsonLines } from './benchmark-args.ts';

function main(): void {
  const resultsArg = benchmarkArgument('results');
  if (!resultsArg) {
    console.error(
      'usage: benchmark-ledger.ts --results <dir> [--ledger <path>] [--audit-doc <path>]',
    );
    process.exit(2);
  }
  const summaryPath = join(resultsArg, 'summary.json');
  if (!existsSync(summaryPath)) {
    console.error(
      `No summary.json in ${resultsArg}; point --results at a review-benchmark output directory.`,
    );
    process.exit(1);
  }
  const summary: unknown = JSON.parse(readFileSync(summaryPath, 'utf8'));
  const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  const row = deriveBenchmarkLedgerRow(summary, {
    jbotSha: git('rev-parse', 'HEAD'),
    branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
    auditDoc: benchmarkArgument('audit-doc'),
  });
  const ledgerPath = benchmarkArgument('ledger') ?? 'docs/audits/benchmark-ledger.jsonl';
  const existing = existsSync(ledgerPath) ? readJsonLines<BenchmarkLedgerRow>(ledgerPath) : [];
  const duplicate = existing.find((entry) => entry.resultsHash === row.resultsHash);
  if (duplicate) {
    console.error(
      `Ledger already has this run: ${duplicate.date} at ${duplicate.jbotSha.slice(0, 12)} (${duplicate.resultsHash}).`,
    );
    process.exit(1);
  }
  const separator =
    existing.length > 0 && !readFileSync(ledgerPath, 'utf8').endsWith('\n') ? '\n' : '';
  appendFileSync(ledgerPath, `${separator}${JSON.stringify(row)}\n`);
  console.log(
    `Appended ${row.subset} run at ${row.jbotSha.slice(0, 12)} to ${ledgerPath} (gate: ${row.gate}).`,
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
