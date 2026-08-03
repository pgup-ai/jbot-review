import { createServer } from 'node:http';
import { Webhooks, createNodeMiddleware } from '@octokit/webhooks';

import {
  providerConfig,
  providerCredentialSources,
  resolveProviderBaseURL,
  resolveProviderCredential,
} from '../shared/config.ts';
import { resolveAuxModel, resolveModelSelection } from '../shared/model.ts';
import { handlePrEvent } from './app.ts';
import type { AppConfig } from './app.ts';

function mustEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

const { providerID: provider, pool: modelPool } = resolveModelSelection(
  process.env.MODEL,
  process.env.PROVIDER,
);
const cfg = providerConfig(provider);

const { model: auxModel, providerID: auxProviderID } = resolveAuxModel(
  process.env.JBOT_REVIEW_AUX_MODEL,
  provider,
  process.env.JBOT_AUX_PROVIDER,
);
const auxCfg = auxProviderID !== provider ? providerConfig(auxProviderID) : undefined;
const apiKey = resolveProviderCredential(cfg, ({ env }) => process.env[env]);
if (!apiKey) {
  throw new Error(
    `Missing provider credential: ${providerCredentialSources(cfg)
      .map(({ env }) => env)
      .join(' or ')}`,
  );
}
const baseURL = resolveProviderBaseURL(provider, cfg, ({ env }) => process.env[env]);
const auxApiKey = auxCfg
  ? resolveProviderCredential(auxCfg, ({ env }) => process.env[env])
  : undefined;
const auxBaseURL = auxCfg
  ? resolveProviderBaseURL(auxProviderID, auxCfg, ({ env }) => process.env[env])
  : undefined;

const appCfg: AppConfig = {
  appId: mustEnv('GITHUB_APP_ID'),
  privateKey: mustEnv('GITHUB_APP_PRIVATE_KEY').replace(/\\n/g, '\n'),
  apiKey,
  modelPool,
  ...(baseURL ? { baseURL } : {}),
  auxModel,
  ...(auxApiKey ? { auxApiKey } : {}),
  ...(auxBaseURL ? { auxBaseURL } : {}),
};

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
  console.log(`[jbot-review] App server listening on :${port} (provider: ${provider})`);
});
