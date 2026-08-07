const LINGER_GRACE_MS = 10_000;

/**
 * Forces the process down if it is still alive `graceMs` after the run
 * finished, naming what held it open. A review drives third-party CLIs and
 * their servers, so it can end with a handle it does not own still open — an
 * orphaned grandchild on a stdio pipe — and Node then waits on that forever,
 * keeping a container alive long past a decided verdict. Unref'd, so a clean
 * run still exits the moment it is done.
 *
 * Single-run entries only: the webhook app is meant to outlive a run.
 */
export function exitOnLingeringHandles(
  log: (msg: string) => void,
  graceMs = LINGER_GRACE_MS,
): void {
  const timer = setTimeout(() => {
    log(
      `Run finished but the process is still alive ${graceMs / 1000}s later; forcing exit. Open handles: ${process.getActiveResourcesInfo().join(', ')}`,
    );
    process.exit(process.exitCode ?? 0);
  }, graceMs);
  timer.unref();
}
