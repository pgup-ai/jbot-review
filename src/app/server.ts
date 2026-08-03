import { createServer } from 'node:http';
import { Webhooks, createNodeMiddleware } from '@octokit/webhooks';

import { swallowedProviderWarnings } from '../shared/backend-selection.ts';
import { resolvePoolCredentials } from '../shared/config.ts';
import { parseModelName } from '@symma/protocol';
import { resolveAuxModel, resolveModelSelection } from '../shared/model.ts';
import { handlePrEvent } from './app.ts';
import type { AppConfig } from './app.ts';

function mustEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

const modelPool = resolveModelSelection(process.env.MODEL, process.env.PROVIDER);
const auxModelInput = process.env.JBOT_REVIEW_AUX_MODEL ?? '';
const auxPinned = process.env.JBOT_AUX_PROVIDER || process.env.PROVIDER;
// Probe only to learn which providers need a key: a bare aux ref belongs to
// whichever model a PR picks, and those providers come from the main pool.
const auxProbe = resolveAuxModel(auxModelInput, parseModelName(modelPool[0]).providerID, auxPinned);
// Resolved at boot: the deployment picks per PR, so a missing key must fail
// here rather than on whichever PR happens to draw that provider.
const credentials = resolvePoolCredentials(
  [...modelPool, ...auxProbe],
  ({ env }: { env: string }) => process.env[env],
);

const appCfg: AppConfig = {
  appId: mustEnv('GITHUB_APP_ID'),
  privateKey: mustEnv('GITHUB_APP_PRIVATE_KEY').replace(/\\n/g, '\n'),
  credentials,
  modelPool,
  auxModelInput,
  ...(auxPinned ? { auxPinned } : {}),
};

for (const warning of swallowedProviderWarnings([...modelPool, ...auxProbe])) {
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
