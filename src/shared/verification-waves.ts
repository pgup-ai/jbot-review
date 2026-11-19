import {
  mergeVerdictsByLocation,
  verificationIdentity,
  type VerdictApplication,
} from './filter.ts';
import type { Finding, FindingVerdict } from './types.ts';

export async function finishVerificationWaves({
  findings,
  firstWave,
  pendingTargets,
  verify,
  logOutcomes,
}: {
  findings: Finding[];
  firstWave?: Promise<{ targets: Finding[]; verdicts: FindingVerdict[] } | 'skipped'>;
  pendingTargets: Finding[];
  verify: (findings: Finding[], late: boolean) => Promise<Finding[]>;
  logOutcomes: (application: VerdictApplication) => void;
}): Promise<Finding[]> {
  const firstKeys = new Set(pendingTargets.map(verificationIdentity));
  const late = firstKeys.size
    ? findings.filter((f) => !firstKeys.has(verificationIdentity(f)))
    : [];
  const lateSet = new Set(late);
  const finish = async () => {
    const remaining = late.length ? findings.filter((f) => !lateSet.has(f)) : findings;
    const result = await firstWave;
    if (!result || result === 'skipped') return verify(remaining, false);
    const merge = mergeVerdictsByLocation(remaining, result.targets, result.verdicts);
    logOutcomes(merge);
    if (late.length) return merge.findings;
    const unverified = new Set(merge.lateUnverified);
    const checked = await verify(merge.lateUnverified, true);
    return [...merge.findings.filter((f) => !unverified.has(f)), ...checked];
  };
  if (!late.length) return finish();
  const [first, second] = await Promise.all([finish(), verify(late, true)]);
  return [...first, ...second];
}
