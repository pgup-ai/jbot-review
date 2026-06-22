import type { ClaimedJob, JobUpdate } from '../shared/worker-contract.ts';
import type { WorkerConfig } from './config.ts';

export interface WorkerClient {
  claim(): Promise<ClaimedJob | null>;
  update(jobId: string, patch: JobUpdate): Promise<void>;
}

/** Thin client for the control plane's shared-secret /internal/jobs/* API. */
export function makeClient(cfg: WorkerConfig, fetchImpl: typeof fetch = fetch): WorkerClient {
  const auth = { Authorization: `Bearer ${cfg.sharedSecret}` };
  return {
    async claim() {
      const res = await fetchImpl(`${cfg.controlPlaneUrl}/internal/jobs/claim`, {
        method: 'POST',
        headers: auth,
      });
      if (res.status === 204) return null;
      if (!res.ok) throw new Error(`claim -> ${res.status}`);
      return (await res.json()) as ClaimedJob;
    },
    async update(jobId, patch) {
      const res = await fetchImpl(`${cfg.controlPlaneUrl}/internal/jobs/${jobId}`, {
        method: 'PATCH',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(`update ${jobId} -> ${res.status}`);
    },
  };
}
