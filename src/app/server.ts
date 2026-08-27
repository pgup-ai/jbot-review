import { createServer } from 'node:http';
import { Webhooks, createNodeMiddleware } from '@octokit/webhooks';

import { swallowedProviderWarnings } from '../shared/backend-selection.ts';
import { resolvePoolCredentials } from '../shared/config.ts';
import { removedAuxInputWarnings, resolveModelSelection } from '../shared/model.ts';
import { handlePrEvent } from './app.ts';
import type { AppConfig } from './app.ts';

function mustEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

const modelPool = resolveModelSelection(process.env.MODEL, process.env.PROVIDER);
// Resolved at boot: the deployment picks per PR, so a missing key must fail
// here rather than on whichever PR happens to draw that provider.
const credentials = resolvePoolCredentials(
  modelPool,
  ({ env }: { env: string }) => process.env[env],
);

const appCfg: AppConfig = {
  appId: mustEnv('GITHUB_APP_ID'),
  privateKey: mustEnv('GITHUB_APP_PRIVATE_KEY').replace(/\\n/g, '\n'),
  credentials,
  modelPool,
};

for (const warning of [
  ...swallowedProviderWarnings(modelPool),
  ...removedAuxInputWarnings((_, env) => process.env[env] ?? ''),
]) {
  console.warn(`[jbot-review] ${warning}`);
}

const webhooks = new Webhooks({ secret: mustEnv('GITHUB_WEBHOOK_SECRET') });

webhooks.on('pull_request.opened', (event) => handlePrEvent(event, appCfg));
webhooks.on('pull_request.reopened', (event) => handlePrEvent(event, appCfg));
webhooks.on('pull_request.ready_for_review', (event) => handlePrEvent(event, appCfg));
webhooks.on('pull_request.synchronize', (event) => handlePrEvent(event, appCfg));

webhooks.onError((error) => {
  console.error(`[jbot-review] webhook error: ${error.message}`);
});

const port = Number(process.env.PORT) || 3000;

createServer(createNodeMiddleware(webhooks, { path: '/webhooks' })).listen(port, () => {
  console.log(`[jbot-review] App server listening on :${port} (models: ${modelPool.join(', ')})`);
});
