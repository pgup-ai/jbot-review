import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

it('settles and releases the pipes once the CLI exits even when an escaped descendant keeps them open', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'jbot-cli-escape-'));
  const scope = createCliProcessScope();
  const escape = (pidFile: string) =>
    `const child = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'inherit' });
     require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
     child.unref();`;
  const options = { cwd: workspace, timeoutMs: 1500, timeoutMessage: 'deadline', killGraceMs: 50 };
  try {
    // A driver process shows the settled runner no longer holds the event loop open.
    const exitPid = join(workspace, 'exit-pid');
    const driver = join(workspace, 'driver.mjs');
    writeFileSync(
      driver,
      `
import { createCliProcessScope, runCliProcess } from ${JSON.stringify(new URL('../src/shared/cli-process.ts', import.meta.url).href)};
const result = await createCliProcessScope().run('exit', () =>
  runCliProcess(process.execPath, ['-e', ${JSON.stringify(`${escape(exitPid)} console.log('done');`)}], ${JSON.stringify(options)}),
);
console.log(JSON.stringify(result));
`,
    );
    const started = Date.now();
    const driven = await promisify(execFile)(process.execPath, ['--import', 'tsx', driver], {
      timeout: 10000,
      killSignal: 'SIGKILL',
    });
    const result = JSON.parse(driven.stdout);
    assert.equal(result.stdout.trim(), 'done');
    assert.equal(result.exitCode, 0);
    assert.ok(Date.now() - started < 8000);

    // A finished run's deadline must not fire during its post-exit grace.
    const latePid = join(workspace, 'late-pid');
    const late = await scope.run('late', () =>
      runCliProcess(process.execPath, ['-e', `${escape(latePid)} console.log('late');`], {
        ...options,
        timeoutMs: 600,
        killGraceMs: 1200,
      }),
    );
    assert.equal(late.stdout.trim(), 'late');

    const hangPid = join(workspace, 'hang-pid');
    const hung = Date.now();
    await assert.rejects(
      scope.run('hang', () =>
        runCliProcess(process.execPath, ['-e', `${escape(hangPid)} setInterval(() => {}, 1000);`], {
          ...options,
          timeoutMs: 200,
        }),
      ),
      /deadline/,
    );
    assert.ok(Date.now() - hung < 1500);
  } finally {
    // Escaped children outlive their parents; reap every one that got as far as a pid file.
    for (const name of readdirSync(workspace).filter((name) => name.endsWith('-pid'))) {
      try {
        process.kill(Number(readFileSync(join(workspace, name), 'utf8')), 'SIGKILL');
      } catch {}
    }
    await scope.stop();
    rmSync(workspace, { recursive: true, force: true });
  }
});

it('reaps in-group descendants on abort during the pipe grace without changing the outcome', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'jbot-cli-linger-'));
  const scope = createCliProcessScope();
  const pidFile = join(workspace, 'pid');
  const lingerer = `process.on('SIGTERM', () => {}); require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
  // The parent exits at once; its in-group child keeps the inherited pipes open.
  const parent = `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(lingerer)}], { stdio: 'inherit' }).unref(); console.log('done');`;
  try {
    const pending = scope.run('linger', () =>
      runCliProcess(process.execPath, ['-e', parent], {
        cwd: workspace,
        timeoutMs: 5000,
        timeoutMessage: 'deadline',
        killGraceMs: 1500,
      }),
    );
    const limit = Date.now() + 3000;
    while (!existsSync(pidFile) && Date.now() < limit) await delay(10);
    await delay(100);
    assert.equal(scope.abort('linger'), 1);
    const result = await pending;
    assert.equal(result.stdout.trim(), 'done');
    assert.equal(result.exitCode, 0);
    // The orphan is reaped by init after the pipes close; allow it that moment.
    const pid = Number(readFileSync(pidFile, 'utf8'));
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const reaped = Date.now() + 2000;
    while (alive() && Date.now() < reaped) await delay(10);
    assert.equal(alive(), false);
  } finally {
    try {
      process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL');
    } catch {}
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
  for (const mode of ['timeout', 'repeat', 'host', 'protocol-first', 'protocol-last']) {
    const script = `
      import assert from 'node:assert/strict';
      import { onFatalSignal } from ${JSON.stringify(import.meta.resolve('@symma/protocol'))};
      import { onCliFatalSignal } from ${JSON.stringify(moduleUrl)};
      const mode = ${JSON.stringify(mode)};
      let cleanups = 0;
      let signals = 0;
      const host = () => { signals++; };
      if (mode === 'host') process.on('SIGTERM', host);
      const registerProtocol = () => onFatalSignal(() => console.log('protocol cleaned'));
      if (mode === 'protocol-first') registerProtocol();
      onCliFatalSignal(async () => {
        cleanups++;
        if (mode.startsWith('protocol')) {
          await new Promise(resolve => setTimeout(resolve, 20));
          console.log('cli cleaned');
        } else if (mode !== 'host') await new Promise(() => {});
      });
      if (mode === 'protocol-last') registerProtocol();
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
      await assert.rejects(
        result,
        (error: NodeJS.ErrnoException & { signal?: string; stdout?: string }) => {
          assert.equal(error.signal, 'SIGTERM');
          if (mode.startsWith('protocol')) {
            assert.equal(error.stdout, 'protocol cleaned\ncli cleaned\n');
          }
          return true;
        },
      );
  }
});
