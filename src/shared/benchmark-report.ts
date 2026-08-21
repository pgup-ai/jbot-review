/**
 * TASK-008's merge gate. A phase may not change default behavior without a
 * benchmark report that says what was measured, on what, and how to undo it.
 * The check is mechanical so "we ran a benchmark" cannot stand in for a report
 * nobody can reproduce — the embedded-first prompt was defaulted on without
 * one, and its evidence was mixed by cohort.
 */

import { isFiniteNumber, isRecord } from './text.ts';

export interface BenchmarkMergeGate {
  satisfied: boolean;
  /** Human-readable reasons the report cannot license a default change. */
  missing: string[];
}

const isNonEmptyString = (value: unknown): boolean =>
  typeof value === 'string' && value.trim().length > 0;

/** A configuration tuple pins the run to one model on one engine, sampled one way. */
function describesConfiguration(arm: unknown): boolean {
  if (!isRecord(arm) || !isRecord(arm.configuration)) return false;
  const { model, modelRevision, engine, sampling, config } = arm.configuration;
  return (
    [model, modelRevision, engine].every(isNonEmptyString) && isRecord(sampling) && isRecord(config)
  );
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
  // `adjudication-required` is not a quality result; it is the absence of one.
  const gate = summary.qualityGate;
  if (
    !isRecord(gate) ||
    gate.status === 'adjudication-required' ||
    typeof gate.passed !== 'boolean'
  ) {
    missing.push('quality result');
  } else if (!gate.passed) {
    // A complete report that says no. It still cannot license the change.
    missing.push('a passing quality gate');
  }
  const paired = summary.pairedLatency;
  if (!isRecord(paired) || !isFiniteNumber(paired.medianRelativeDelta)) {
    missing.push('latency result');
  } else if (!isFiniteNumber(paired.minimumDetectableEffect)) {
    // A sample that resolves nothing cannot support a latency claim, so the
    // report has to say so rather than quoting a point estimate.
    missing.push('a sample that can resolve any latency effect');
  }

  return { satisfied: missing.length === 0, missing };
}
