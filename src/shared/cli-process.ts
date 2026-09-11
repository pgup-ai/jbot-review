import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile, spawn } from 'node:child_process';
import { spawnWithTimeout, type CliProcessOptions, type CliProcessResult } from '@symma/protocol';

const sessionSignal = new AsyncLocalStorage<AbortSignal>();

const fatalSignals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
const fatalCleanups = new Set<() => void | Promise<void>>();
let handlingSignal = false;

function finishFatalSignal(signal: NodeJS.Signals, force = false): void {
  for (const name of fatalSignals) process.removeListener(name, handleFatalSignal);
  if (force) process.removeAllListeners(signal);
  if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
}

async function handleFatalSignal(signal: NodeJS.Signals): Promise<void> {
  if (handlingSignal) {
    finishFatalSignal(signal, true);
    return;
  }
  handlingSignal = true;
  // Escaped descendants can retain pipes after process-group cancellation.
  const timer = setTimeout(() => finishFatalSignal(signal, true), 5000);
  await Promise.allSettled([...fatalCleanups].map((cleanup) => Promise.resolve().then(cleanup)));
  clearTimeout(timer);
  fatalCleanups.clear();
  handlingSignal = false;
  finishFatalSignal(signal);
}

// The protocol's synchronous signal hook cannot await child reaping before HOME cleanup.
export function onCliFatalSignal(cleanup: () => void | Promise<void>): () => void {
  if (fatalCleanups.size === 0 && !handlingSignal)
    for (const signal of fatalSignals) process.on(signal, handleFatalSignal);
  fatalCleanups.add(cleanup);
  return () => {
    fatalCleanups.delete(cleanup);
    if (fatalCleanups.size === 0 && !handlingSignal)
      for (const signal of fatalSignals) process.removeListener(signal, handleFatalSignal);
  };
}

export function createCliProcessScope() {
  const sessions = new Set<{
    label: string;
    controller: AbortController;
    done: Promise<unknown>;
  }>();
  let stopped = false;
  return {
    async run<T>(label: string, task: () => Promise<T>): Promise<T> {
      if (stopped) throw new Error('CLI runtime stopped');
      const controller = new AbortController();
      const done = Promise.resolve().then(() => sessionSignal.run(controller.signal, task));
      const session = { label, controller, done };
      sessions.add(session);
      try {
        return await done;
      } finally {
        sessions.delete(session);
      }
    },
    abort(label: string): number {
      let count = 0;
      for (const session of sessions) {
        if (session.label !== label) continue;
        session.controller.abort(new Error(`CLI ${label} aborted`));
        count++;
      }
      return count;
    },
    async stop(): Promise<void> {
      stopped = true;
      for (const session of sessions) session.controller.abort(new Error('CLI runtime stopped'));
      await Promise.allSettled([...sessions].map((session) => session.done));
    },
  };
}

export function runCliProcess(
  command: string,
  args: string[],
  options: CliProcessOptions & { onStdout?: (chunk: string) => void },
): Promise<CliProcessResult> {
  const signal = sessionSignal.getStore();
  if (!signal && !options.onStdout) return spawnWithTimeout(command, args, options);
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== 'win32',
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let failure: Error | undefined;
    let treeKill: Promise<void> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (value: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      if (process.platform === 'win32') {
        // Kill the tree together: killing its parent first can orphan pipe holders.
        treeKill ??= new Promise<void>((done) => {
          execFile(
            'taskkill',
            ['/PID', String(child.pid), '/T', '/F'],
            { windowsHide: true, timeout: 5000, killSignal: 'SIGKILL' },
            (error) => {
              if (error) stderr += `\n[taskkill failed: ${error.message}]`;
              done();
            },
          );
        });
        return;
      }
      try {
        process.kill(-child.pid, value);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failure ??= error as Error;
      }
    };
    const cancel = (error: Error) => {
      if (failure) return;
      failure = error;
      kill('SIGTERM');
      // A parent can exit while its descendants still own the pipes. Escalate
      // until close, rather than treating the parent's exit as tree cleanup.
      killTimer = setTimeout(() => kill('SIGKILL'), options.killGraceMs ?? 2000);
    };
    const abort = () => cancel(new Error(String(signal?.reason ?? 'CLI aborted')));
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => cancel(new Error(options.timeoutMessage)), options.timeoutMs);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
      options.onStdout?.(chunk);
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.stdin?.on('error', (error: Error) => {
      stderr += `\n[stdin error: ${error.message}]`;
    });
    if (options.input !== undefined) child.stdin?.end(options.input);
    child.on('error', (error) => {
      failure ??= error;
    });
    let exitTimer: ReturnType<typeof setTimeout> | undefined;
    const settle = async (exitCode: number | null) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(exitTimer);
      signal?.removeEventListener('abort', abort);
      await treeKill;
      if (failure) reject(failure);
      else resolve({ stdout, stderr, exitCode });
    };
    // A descendant that left the process group (setsid) survives the group kill
    // and holds the pipes open, so 'close' would never come; settle on exit then
    // and drop our pipe ends, which would otherwise keep the event loop alive.
    child.on('exit', (exitCode) => {
      exitTimer = setTimeout(() => {
        kill('SIGKILL');
        child.stdout?.destroy();
        child.stderr?.destroy();
        void settle(exitCode);
      }, options.killGraceMs ?? 2000);
    });
    child.once('close', settle);
  });
}
