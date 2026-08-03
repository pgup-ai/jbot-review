/**
 * Synthesizes guideline-learning candidates from review telemetry — the
 * offline half of the guideline-improver loop. Reads telemetry.jsonl files
 * (the `jbot-review-telemetry` CI artifact, JBOT_TELEMETRY_DIR copies from app
 * mode, or a local .jbot-review/telemetry.jsonl), rolls up the human-outcome
 * rows per area, and prints where reviews draw pushback, endorsement, or
 * silence — for a HUMAN to fold into the reviewed repo's guideline files
 * (AGENTS.md / REVIEW.md, the files guideline discovery already injects under
 * its byte budgets).
 *
 * Deliberately no LLM and no auto-PR: guideline-synthesis automation waits for
 * an eval gate that can score a proposed edit. This tool makes the signal
 * readable; a human makes the edit.
 *
 * Usage: npm run guidelines:candidates -- <telemetry.jsonl...>
 * Pass files oldest-first: for threads seen in several runs, the LAST
 * observation wins.
 */
import { readFileSync } from 'node:fs';

import { aggregateOutcomeRows, type OutcomeTelemetryRow } from '../src/shared/telemetry.ts';

const MIN_SAMPLE = 30;

function main(): void {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error('usage: guideline-candidates.ts <telemetry.jsonl...>');
    process.exitCode = 1;
    return;
  }

  const rows: OutcomeTelemetryRow[] = [];
  let unreadable = 0;
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      unreadable += 1; // reported below, never silent
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as { kind?: string };
        if (parsed.kind === 'outcome') rows.push(parsed as OutcomeTelemetryRow);
      } catch {
        // Non-JSON lines (log noise in a concatenated capture) are not rows.
      }
    }
  }

  const areas = aggregateOutcomeRows(rows);
  const threads = areas.reduce((sum, area) => sum + area.threads, 0);
  console.log(
    `${files.length - unreadable} file(s), ${rows.length} outcome row(s), ${threads} distinct thread(s)\n`,
  );

  if (threads === 0) {
    console.log('No outcome rows found — run reviews with telemetry on, then re-run this.');
    return;
  }

  console.log(
    `  ${'area'.padEnd(24)} ${'threads'.padStart(7)} ${'pushback'.padStart(8)} ${'endorsed'.padStart(8)} ${'ignored'.padStart(7)} ${'addressed'.padStart(9)} ${'resolved'.padStart(8)}`,
  );
  for (const area of areas) {
    console.log(
      `  ${area.area.padEnd(24)} ${String(area.threads).padStart(7)} ${String(area.pushback).padStart(8)} ${String(area.endorsed).padStart(8)} ${String(area.ignored).padStart(7)} ${String(area.addressed).padStart(9)} ${String(area.resolved).padStart(8)}`,
    );
  }

  const caveats = [
    unreadable > 0 ? `${unreadable} file(s) unreadable — this sample is partial` : '',
    threads < MIN_SAMPLE ? `n=${threads} — too small to treat any cluster as a pattern` : '',
  ].filter(Boolean);
  if (caveats.length > 0) console.log(`\n${caveats.map((c) => `  ! ${c}`).join('\n')}`);

  console.log(
    '\nNext step: for each high-pushback area, read the underlying threads and draft ONE',
  );
  console.log(
    'guideline bullet in the reviewed repo (AGENTS.md / REVIEW.md) saying when NOT to flag;',
  );
  console.log('high-ignored areas suggest noise worth demoting the same way.');
}

main();
