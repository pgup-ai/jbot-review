import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

test('failed trials and log failures preserve their results and exit nonzero', async (t) => {
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
  writeFileSync(findings, '{');
  for (const failure of ['none', 'write', 'flush']) {
    const trial = join(dir, failure);
    mkdirSync(trial);
    const preload = join(trial, 'fail-log.mjs');
    writeFileSync(
      preload,
      `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { Writable } from 'node:stream';
      const failure = ${JSON.stringify(failure)};
      const createWriteStream = fs.createWriteStream;
      fs.createWriteStream = (path, ...args) => {
        if (failure === 'none' || !String(path).endsWith('review.log'))
          return createWriteStream(path, ...args);
        return new Writable({
          write(_chunk, _encoding, done) {
            done(failure === 'write' ? new Error('injected log-write failure') : undefined);
          },
          final(done) { done(new Error('injected log-flush failure')); },
        });
      };
      syncBuiltinESMExports();
    `,
    );
    const plan = join(trial, 'plan.json');
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
          '--import',
          preload,
          fileURLToPath(new URL('../scripts/jev-prefetch-experiment.ts', import.meta.url)),
          plan,
        ],
        { cwd: trial, timeout: 30_000, killSignal: 'SIGKILL' },
      ),
      (error: { code?: number; stderr?: string }) => {
        assert.equal(error.code, 1);
        if (failure !== 'none')
          assert.match(error.stderr ?? '', new RegExp(`injected log-${failure} failure`));
        return true;
      },
    );
    const results = JSON.parse(readFileSync(join(trial, 'runs/results.json'), 'utf8'));
    const manifest = JSON.parse(readFileSync(join(trial, 'runs/manifest.json'), 'utf8'));
    assert.equal(results.length, failure === 'none' ? 2 : 1);
    assert.deepEqual(
      results.map(({ id }: { id: string }) => id),
      (failure === 'none' ? manifest.schedule : manifest.schedule.slice(0, 1)).map(
        ({ id }: { id: string }) => id,
      ),
    );
    for (const result of results) {
      assert.equal(result.code, failure === 'write' ? null : 1);
      assert.equal(result.terminalState, 'process-failed');
      if (failure === 'none')
        assert.match(
          readFileSync(join(trial, 'runs', result.id, 'review.log'), 'utf8'),
          /SyntaxError/,
        );
    }
  }
});
