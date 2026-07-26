/**
 * Teardown that has to survive a signal. A `finally` covers return and throw but
 * not SIGINT/SIGTERM/SIGHUP, and Ctrl-C is how a long review usually ends — the
 * temp checkout and the CLI homes holding materialized credentials would
 * otherwise be left on disk. One shared registry rather than a listener per
 * call site: the first handler to re-raise would cancel every other one.
 */
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

const cleanups = new Set<() => void>();

function onSignal(signal: NodeJS.Signals): void {
  for (const cleanup of cleanups) cleanup();
  // Drop back to the default disposition so the exit code still reports the
  // signal (128+signum) instead of a clean exit.
  for (const other of SIGNALS) process.removeListener(other, onSignal);
  process.kill(process.pid, signal);
}

/**
 * Runs `cleanup` if the process is signalled, then re-raises. `cleanup` must be
 * synchronous — a signal handler cannot await — and must not throw, or the
 * re-raise is skipped and the process stays alive.
 */
export function onFatalSignal(cleanup: () => void): () => void {
  if (cleanups.size === 0) for (const signal of SIGNALS) process.on(signal, onSignal);
  cleanups.add(cleanup);
  return () => {
    cleanups.delete(cleanup);
    if (cleanups.size === 0) for (const signal of SIGNALS) process.removeListener(signal, onSignal);
  };
}
