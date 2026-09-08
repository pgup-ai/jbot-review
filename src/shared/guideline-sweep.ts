import type { Finding, ReviewResult } from './types.ts';
import type { SessionCoverageRecorder } from './telemetry.ts';

export interface GuidelineSweep {
  guidelines: string;
  onCoverage?: SessionCoverageRecorder;
}

export async function appendGuidelineSweep(
  result: ReviewResult,
  sweep: GuidelineSweep,
  label: string,
  deadlineAt: number | undefined,
  run: (timeoutMs: number) => Promise<Finding[]>,
  log: (message: string) => void,
): Promise<ReviewResult> {
  const startedAt = Date.now();
  const timeoutMs = Math.min(600_000, (deadlineAt ?? Infinity) - startedAt);
  try {
    if (timeoutMs <= 0) throw new Error('No time remaining for guideline sweep.');
    log(`Continuing main session for ${label}.`);
    const findings = await run(timeoutMs);
    sweep.onCoverage?.({ session: label, state: 'completed', durationMs: Date.now() - startedAt });
    log(`${label} complete: ${findings.length} additional finding(s).`);
    return { ...result, findings: [...result.findings, ...findings] };
  } catch (error) {
    sweep.onCoverage?.({
      session: label,
      state: 'failed',
      error,
      durationMs: Date.now() - startedAt,
    });
    log(`(${label} failed; keeping main findings: ${String(error)})`);
    return result;
  }
}
