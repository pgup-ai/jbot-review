// Mirror of jbot-review-app's apps/api/src/modules/worker/worker.types.ts.
// The two repos don't share a package — keep these two in sync by hand.
export interface ClaimedJob {
  jobId: string;
  repoFullName: string; // "owner/repo"
  prNumber: number;
  model: string; // qualified ref, e.g. "opencode/deepseek-v4-flash-free"
  auxModel: string | null;
  apiKey: string; // DECRYPTED provider key for the model's provider
  auxApiKey: string | null; // aux model's provider key when it differs; else null
  installationToken: string; // short-lived (~1h) GitHub installation token
}

export interface JobUpdate {
  status: 'running' | 'success' | 'failed' | 'blocked';
  durationMs?: number;
  costUsd?: number;
  tokensInput?: number;
  tokensOutput?: number;
}
