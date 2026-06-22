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
  // plaintext HTTP. Parse the URL and check the REAL hostname; a regex is fooled
  // by a userinfo authority (e.g. http://localhost@evil.com → host is evil.com).
  let host: string;
  try {
    host = new URL(controlPlaneUrl).hostname;
  } catch {
    throw new Error(`CONTROL_PLANE_URL is not a valid URL (got "${controlPlaneUrl}")`);
  }
  const isLocal = host === 'localhost' || host === '127.0.0.1';
  if (!controlPlaneUrl.startsWith('https://') && !isLocal) {
    throw new Error(`CONTROL_PLANE_URL must be https:// (got "${controlPlaneUrl}")`);
  }
  // Default to 5s unless WORKER_POLL_MS is an explicit positive number, so 0,
  // negatives, and garbage don't spin the loop or silently disable the delay.
  const pollMs = Number(process.env.WORKER_POLL_MS);
  return {
    controlPlaneUrl,
    sharedSecret: must('WORKER_SHARED_SECRET'),
    pollMs: Number.isFinite(pollMs) && pollMs > 0 ? pollMs : 5000,
  };
}
