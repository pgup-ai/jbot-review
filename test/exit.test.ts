import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

// An ESM specifier is a URL, so a raw path breaks on anything a URL reads
// differently — a drive letter, a space in the checkout path.
const MODULE = pathToFileURL(join(process.cwd(), 'src/shared/exit.ts')).href;

function runDriver(
  source: string,
  { readStdout = true } = {},
): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-'], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    let out = '';
    child.stdout.setEncoding('utf8');
    if (readStdout)
      child.stdout.on('data', (chunk: string) => {
        out += chunk;
      });
    // Regressing this guard means a child that never exits; failing on one is
    // the point, hanging on it is not. The kill leaves `code === null`, so
    // every assertion below doubles as "exited within 10s".
    const kill = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.on('close', (code) => {
      clearTimeout(kill);
      resolve({ code, out });
    });
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
    assert.match(leaked.out, /forcing exit\. Open handles: \w/, 'names what held the process');

    // A leak on a run that SUCCEEDED is forced down just the same, and stays a
    // success — the exit must not invent a failure the review never reported.
    const leakedClean = await runDriver(`
      import { exitOnLingeringHandles } from '${MODULE}';
      setInterval(() => {}, 1_000);
      exitOnLingeringHandles(() => {}, 300);
    `);
    assert.equal(leakedClean.code, 0);

    // Piped to a parent that never reads: once the buffer fills, the drain the
    // exit waits on can never complete, and the guard must go down anyway.
    const wedged = await runDriver(
      `
      import { exitOnLingeringHandles } from '${MODULE}';
      process.stdout.write('x'.repeat(1 << 20));
      exitOnLingeringHandles(() => {}, 300);
    `,
      { readStdout: false },
    );
    assert.equal(wedged.code, 0);

    // Same guard, nothing leaking: the timer is unref'd, so this must not wait
    // out a grace three times the driver's kill — that would add it to every run.
    const clean = await runDriver(`
      import { exitOnLingeringHandles } from '${MODULE}';
      exitOnLingeringHandles((msg) => console.log(msg), 30_000);
    `);
    assert.equal(clean.code, 0);
    assert.equal(clean.out, '');
  });
});
