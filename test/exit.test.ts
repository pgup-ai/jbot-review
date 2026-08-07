import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const MODULE = join(process.cwd(), 'src/shared/exit.ts');

function runDriver(source: string): Promise<{ code: number | null; out: string; ms: number }> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-'], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      out += chunk;
    });
    child.on('close', (code) => resolve({ code, out, ms: Date.now() - startedAt }));
    child.stdin.end(source);
  });
}

describe('exitOnLingeringHandles', () => {
  it('forces exit on a leaked handle but never delays a clean one', async () => {
    const leaked = await runDriver(`
      import { exitOnLingeringHandles } from '${MODULE}';
      setInterval(() => {}, 1_000);
      process.exitCode = 1;
      exitOnLingeringHandles((msg) => console.log(msg), 300);
    `);
    assert.equal(leaked.code, 1, 'the run verdict survives the forced exit');
    assert.match(leaked.out, /Timeout/, 'names the handles that kept the process alive');

    // Same guard, nothing leaking: the timer is unref'd, so this must not wait
    // it out — that would add the grace to every run.
    const clean = await runDriver(`
      import { exitOnLingeringHandles } from '${MODULE}';
      exitOnLingeringHandles((msg) => console.log(msg), 30_000);
    `);
    assert.equal(clean.code, 0);
    assert.equal(clean.out, '');
    assert.ok(clean.ms < 10_000, `exited naturally in ${clean.ms}ms`);
  });
});
