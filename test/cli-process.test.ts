import assert from 'node:assert/strict';
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
