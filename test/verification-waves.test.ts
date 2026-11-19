import assert from 'node:assert/strict';
import { it } from 'node:test';
import { finishVerificationWaves } from '../src/shared/verification-waves.ts';
import type { Finding, FindingVerdict } from '../src/shared/types.ts';

const first: Finding = {
  path: 'a.ts',
  line: 1,
  title: 'First',
  body: 'first claim',
  severity: 'P2',
  kind: 'bug',
};
const replaced: Finding = { ...first, title: 'Old claim' };
const late: Finding = { ...replaced, title: 'Different claim' };

for (const failed of [false, true]) {
  it(`starts distinct late claims before the first verifier settles (failure=${failed})`, async () => {
    const calls: Finding[][] = [];
    let release!: (v: { targets: Finding[]; verdicts: FindingVerdict[] } | 'skipped') => void;
    const firstWave = new Promise<Parameters<typeof release>[0]>((r) => {
      release = r;
    });
    const result = finishVerificationWaves({
      findings: [first, late],
      pendingTargets: [first, replaced],
      firstWave,
      verify: async (fs) => {
        calls.push(fs);
        return fs;
      },
      logOutcomes: () => {},
    });
    assert.deepEqual(calls, [[late]]);
    release(
      failed
        ? 'skipped'
        : {
            targets: [first, replaced],
            verdicts: [
              { index: 0, verdict: 'refuted' },
              { index: 1, verdict: 'refuted' },
            ],
          },
    );
    assert.deepEqual(await result, failed ? [first, late] : [late]);
    assert.deepEqual(calls, failed ? [[late], [first]] : [[late]]);
  });
}
it('preserves sequential verification with the opt-in disabled', async () => {
  const calls: Finding[][] = [];
  let release!: () => void;
  const hold = new Promise<void>((r) => {
    release = r;
  });
  const result = finishVerificationWaves({
    findings: [first, late],
    pendingTargets: [],
    firstWave: hold.then(() => ({
      targets: [first],
      verdicts: [{ index: 0, verdict: 'refuted' as const }],
    })),
    logOutcomes: () => {},
    verify: async (fs) => {
      calls.push(fs);
      return fs;
    },
  });
  assert.deepEqual(calls, []);
  release();
  assert.deepEqual(await result, [late]);
  assert.deepEqual(calls, [[late]]);
});
