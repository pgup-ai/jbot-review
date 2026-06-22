function must(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export interface WorkerConfig {
  /** Control-plane base URL, no trailing slash; we append /internal/jobs/*. */
  controlPlaneUrl: string;
  sharedSecret: string;
  pollMs: number;
}

export function loadWorkerConfig(): WorkerConfig {
  const controlPlaneUrl = must('CONTROL_PLANE_URL').replace(/\/$/, '');
  // The claim response carries a DECRYPTED provider key — never send it over
  // plaintext HTTP. Allow http only for localhost dev tunnels.
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(controlPlaneUrl);
  if (!controlPlaneUrl.startsWith('https://') && !isLocal) {
    throw new Error(`CONTROL_PLANE_URL must be https:// (got "${controlPlaneUrl}")`);
  }
  return {
    controlPlaneUrl,
    sharedSecret: must('WORKER_SHARED_SECRET'),
    pollMs: Number(process.env.WORKER_POLL_MS) || 5000,
  };
}
