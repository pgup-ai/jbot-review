// Mirror of jbot-review-app's apps/api/src/modules/worker/worker.types.ts.
// The two repos don't share a package — keep these two in sync by hand.
import type { Severity } from './types.ts';

export interface ClaimedJob {
  jobId: string;
  repoFullName: string; // "owner/repo"
  prNumber: number;
  model: string; // qualified ref, e.g. "opencode/deepseek-v4-flash-free"
  auxModel: string | null;
  apiKey: string; // DECRYPTED provider key for the model's provider
  auxApiKey: string | null; // aux model's provider key when it differs; else null
  installationToken: string; // short-lived (~1h) GitHub installation token
  claimToken: string; // per-claim fence (uuid); the worker echoes it on every PATCH
}

export interface JobUpdate {
  claimToken: string; // echoes the claim's fence token; required on every update
  status: 'running' | 'success' | 'failed' | 'blocked';
  durationMs?: number;
  costUsd?: number;
  tokensInput?: number;
  tokensOutput?: number;
  // Per-severity finding counts for the control plane's check-run gate.
  findingsBySeverity?: Partial<Record<Severity, number>>;
}
