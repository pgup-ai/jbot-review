import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

test('failed trials leave every scheduled row and stderr log while the experiment exits nonzero', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'jbot-experiment-failure-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const workspace = join(dir, 'fixture');
  mkdirSync(workspace);
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: workspace, encoding: 'utf8' }).trim();
  git('init', '-q');
  git(
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--allow-empty',
    '-qm',
    'fixture',
  );
  const head = git('rev-parse', 'HEAD');
  const findings = join(dir, 'findings.json');
  // Malformed input fails before the verifier starts a provider session.
  writeFileSync(findings, '{');
  const plan = join(dir, 'plan.json');
  writeFileSync(
    plan,
    JSON.stringify({
      seed: 'nonzero-child',
      model: 'opencode/unused',
      experiment: 'diff-batches',
      repetitions: 1,
      cases: [{ id: 'failure', workspace, base: head, head, findings }],
    }),
  );
  await assert.rejects(
    promisify(execFile)(
      process.execPath,
      [
        '--import',
        fileURLToPath(import.meta.resolve('tsx')),
        fileURLToPath(new URL('../scripts/jev-prefetch-experiment.ts', import.meta.url)),
        plan,
      ],
      { cwd: dir, timeout: 30_000, killSignal: 'SIGKILL' },
    ),
    { code: 1 },
  );
  const results = JSON.parse(readFileSync(join(dir, 'runs/results.json'), 'utf8'));
  const manifest = JSON.parse(readFileSync(join(dir, 'runs/manifest.json'), 'utf8'));
  assert.equal(results.length, 2);
  assert.deepEqual(
    results.map(({ id }: { id: string }) => id),
    manifest.schedule.map(({ id }: { id: string }) => id),
  );
  for (const result of results) {
    assert.equal(result.code, 1);
    assert.equal(result.terminalState, 'process-failed');
    assert.match(readFileSync(join(dir, 'runs', result.id, 'review.log'), 'utf8'), /SyntaxError/);
  }
});
