/**
 * TASK-008's merge gate. A phase may not change default behavior without a
 * benchmark report that says what was measured, on what, and how to undo it.
 * The check is mechanical so "we ran a benchmark" cannot stand in for a report
 * nobody can reproduce — the embedded-first prompt was defaulted on without
 * one, and its evidence was mixed by cohort.
 */

import { REQUIRED_CONFIGURATION_FIELDS } from './benchmark-score.ts';
import { isFiniteNumber, isNonArrayRecord as isRecord, isNonEmptyString } from './text.ts';

export interface BenchmarkMergeGate {
  satisfied: boolean;
  /** Human-readable reasons the report cannot license a default change. */
  missing: string[];
}

/**
 * The same identity `assertBenchmarkComparable` demands, plus how the run was
 * sampled and configured. A tuple the comparability contract would reject is
 * not a reproducible run, so the gate must not accept one either.
 */
function describesConfiguration(arm: unknown): boolean {
  if (!isRecord(arm) || !isRecord(arm.configuration)) return false;
  const { configuration } = arm;
  return (
    REQUIRED_CONFIGURATION_FIELDS.every((field) => isNonEmptyString(configuration[field])) &&
    isRecord(configuration.sampling) &&
    isRecord(configuration.config)
  );
}

/**
 * The two verdicts the scorer emits. `adjudication-required`, an unknown
 * status, and a status contradicting `passed` are each the absence of a result
 * rather than one to weigh — a report edited to read `passed: true` under
 * `status: 'failed'` is the case worth catching.
 */
function qualityVerdict(gate: unknown): 'passed' | 'failed' | null {
  if (!isRecord(gate)) return null;
  if (gate.status === 'passed' && gate.passed === true) return 'passed';
  if (gate.status === 'failed' && gate.passed === false) return 'failed';
  return null;
}

/** Runs that completed, which is what a sample size means for a comparison. */
function countsSuccessfulRuns(arm: unknown): boolean {
  return isRecord(arm) && typeof arm.successfulRuns === 'number' && arm.successfulRuns > 0;
}

/**
 * Reads a `summary.json` from `review-benchmark`. Two fields come from the
 * manifest rather than the run — the commit under test and how to roll it
 * back — because neither is derivable from the results.
 */
export function checkBenchmarkMergeGate(summary: unknown): BenchmarkMergeGate {
  const missing: string[] = [];
  if (!isRecord(summary)) return { satisfied: false, missing: ['a benchmark summary'] };

  if (!isNonEmptyString(summary.treatmentCommit)) missing.push('treatment commit');
  if (!isNonEmptyString(summary.corpusHash)) missing.push('corpus hash');
  if (!isNonEmptyString(summary.rollback)) missing.push('rollback instruction');
  if (!describesConfiguration(summary.control) || !describesConfiguration(summary.treatment)) {
    missing.push('model/config tuple for both arms');
  }
  if (!countsSuccessfulRuns(summary.control) || !countsSuccessfulRuns(summary.treatment)) {
    missing.push('sample size for both arms');
  }
  const verdict = qualityVerdict(summary.qualityGate);
  if (verdict === null) {
    missing.push('quality result');
  } else if (verdict === 'failed') {
    // A complete report that says no. It still cannot license the change.
    missing.push('a passing quality gate');
  }
  const paired = summary.pairedLatency;
  if (!isRecord(paired) || !isFiniteNumber(paired.medianRelativeDelta)) {
    missing.push('latency result');
  } else if (
    !isFiniteNumber(paired.minimumDetectableEffect) ||
    paired.minimumDetectableEffect <= 0
  ) {
    // A sample that resolves nothing cannot support a latency claim, so the
    // report has to say so rather than quoting a point estimate. Zero reads as
    // the opposite — perfect sensitivity — and the ladder never yields it.
    missing.push('a sample that can resolve any latency effect');
  }

  return { satisfied: missing.length === 0, missing };
}
