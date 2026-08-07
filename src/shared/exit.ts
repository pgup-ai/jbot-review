const LINGER_GRACE_MS = 10_000;
const DRAIN_MS = 1_000;

/**
 * Forces the process down if it is still alive `graceMs` after the run
 * finished, naming what held it open. A review drives third-party CLIs and
 * their servers, so it can end with a handle it does not own still open — an
 * orphaned grandchild on a stdio pipe — and Node then waits on that forever,
 * keeping a container alive long past a decided verdict. Unref'd, so a run
 * that can exit still exits the moment it is done. Success is not exempt — an
 * unfinishable container is as dead as a failed one — and `process.exitCode`
 * carries the verdict through the exit.
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
    const exit = () => process.exit(process.exitCode ?? 0);
    // A container's stdout is a pipe, where writes are async: exiting before it
    // drains would drop the line above — the only evidence of what leaked. But
    // a pipe nobody reads never drains, so the exit cannot wait on it alone.
    process.stdout.write('', exit);
    setTimeout(exit, DRAIN_MS).unref();
  }, graceMs);
  timer.unref();
}
