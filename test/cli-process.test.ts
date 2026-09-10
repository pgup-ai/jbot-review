import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { it } from 'node:test';
import { createCliProcessScope, runCliProcess } from '../src/shared/cli-process.ts';

it('cancels one session and waits for descendant pipes to close without cancelling another', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'jbot-cli-cancel-'));
  const scope = createCliProcessScope();
  const ready = join(workspace, 'ready');
  const otherReady = join(workspace, 'other-ready');
  const release = join(workspace, 'release');
  const grandchild = `process.on('SIGTERM', () => {}); require('fs').writeFileSync(${JSON.stringify(ready)}, 'ready'); setInterval(() => {}, 1000);`;
  const parent = `console.log('progress before abort'); require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], {stdio:'inherit'}); setInterval(() => {}, 1000);`;
  let observed = '';
  const options = {
    onStdout: (chunk: string) => {
      observed += chunk;
    },
    cwd: workspace,
    timeoutMs: 5000,
    timeoutMessage: 'deadline',
    killGraceMs: 20,
  };
  try {
    const pending = scope.run('lens', () =>
      runCliProcess(process.execPath, ['-e', parent], options),
    );
    const rejected = assert.rejects(pending, /aborted/);
    const other = scope.run('other', () =>
      runCliProcess(
        process.execPath,
        [
          '-e',
          `
          const fs = require('fs');
          fs.writeFileSync(${JSON.stringify(otherReady)}, 'ready');
          const timer = setInterval(() => {
            if (fs.existsSync(${JSON.stringify(release)})) {
              clearInterval(timer);
              console.log('alive');
            }
          }, 10);
        `,
        ],
        options,
      ),
    );
    const limit = Date.now() + 3000;
    while ((!existsSync(ready) || !existsSync(otherReady)) && Date.now() < limit) await delay(10);
    assert.ok(existsSync(ready) && existsSync(otherReady));
    assert.match(observed, /progress before abort/);
    assert.equal(scope.abort('missing'), 0);
    assert.equal(scope.abort('lens'), 1);
    await rejected;
    assert.match(observed, /progress before abort/);
    writeFileSync(release, 'go');
    const result = await other;
    assert.equal(result.stdout.trim(), 'alive');
    assert.equal(scope.abort('lens'), 0);
  } finally {
    await scope.stop();
    rmSync(workspace, { recursive: true, force: true });
  }
});

it('stops queued work before spawn and reaps a timed-out child before rejecting', async () => {
  const scope = createCliProcessScope();
  const options = { cwd: tmpdir(), timeoutMs: 30, timeoutMessage: 'deadline', killGraceMs: 20 };
  await assert.rejects(
    scope.run('timeout', () =>
      runCliProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options),
    ),
    /deadline/,
  );
  const pending = scope.run('queued', () => runCliProcess('must-not-spawn', [], options));
  const rejected = assert.rejects(pending, /runtime stopped/);
  await scope.stop();
  await rejected;
  await assert.rejects(
    scope.run('later', async () => {}),
    /runtime stopped/,
  );
});

it('bounds fatal cleanup, forces repeated signals, and preserves a surviving host listener', async () => {
  const execute = promisify(execFile);
  const moduleUrl = new URL('../src/shared/cli-process.ts', import.meta.url).href;
  for (const mode of ['timeout', 'repeat', 'host']) {
    const script = `
      import assert from 'node:assert/strict';
      import { onCliFatalSignal } from ${JSON.stringify(moduleUrl)};
      const mode = ${JSON.stringify(mode)};
      let cleanups = 0;
      let signals = 0;
      const host = () => { signals++; };
      if (mode === 'host') process.on('SIGTERM', host);
      onCliFatalSignal(async () => {
        cleanups++;
        if (mode !== 'host') await new Promise(() => {});
      });
      process.emit('SIGTERM', 'SIGTERM');
      setImmediate(() => {
        assert.equal(cleanups, 1);
        if (mode === 'repeat') {
          setTimeout(() => process.exit(91), 1000);
          process.emit('SIGTERM', 'SIGTERM');
        }
        if (mode === 'host') {
          assert.equal(signals, 1);
          assert.deepEqual(process.listeners('SIGTERM'), [host]);
          process.removeListener('SIGTERM', host);
          console.log('host retained');
        }
      });
    `;
    const result = execute(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script],
      {
        timeout: 10000,
        killSignal: 'SIGKILL',
      },
    );
    if (mode === 'host') assert.equal((await result).stdout.trim(), 'host retained');
    else
      await assert.rejects(result, (error: NodeJS.ErrnoException & { signal?: string }) => {
        assert.equal(error.signal, 'SIGTERM');
        return true;
      });
  }
});
