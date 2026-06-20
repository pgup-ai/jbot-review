import { createServer } from 'node:http';
import { Webhooks, createNodeMiddleware } from '@octokit/webhooks';

import { PROVIDERS } from '../shared/config.ts';
import { formatModelName, resolveModelName } from '../shared/model.ts';
import { handlePrEvent } from './app.ts';
import type { AppConfig } from './app.ts';

function mustEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

const provider = process.env.PROVIDER || 'opencode';
const cfg = PROVIDERS[provider];
if (!cfg) {
  throw new Error(
    `Unknown provider "${provider}". Supported: ${Object.keys(PROVIDERS).join(', ')}.`,
  );
}

const auxModelInput = process.env.JBOT_REVIEW_AUX_MODEL?.trim();
const auxProvider = auxModelInput ? process.env.JBOT_AUX_PROVIDER?.trim() || provider : provider;
const auxCfg = auxModelInput ? PROVIDERS[auxProvider] : undefined;
if (auxModelInput && !auxCfg) {
  throw new Error(
    `Unknown aux provider "${auxProvider}". Supported: ${Object.keys(PROVIDERS).join(', ')}.`,
  );
}
const apiKey = mustEnv(cfg.keyEnv);
const auxApiKey =
  auxModelInput && auxProvider !== provider && auxCfg
    ? process.env[auxCfg.keyEnv]?.trim()
    : undefined;

const appCfg: AppConfig = {
  appId: mustEnv('GITHUB_APP_ID'),
  privateKey: mustEnv('GITHUB_APP_PRIVATE_KEY').replace(/\\n/g, '\n'),
  apiKey,
  model: formatModelName(resolveModelName(provider, process.env.MODEL || cfg.defaultModel)),
  auxProvider,
  ...(auxApiKey ? { auxApiKey } : {}),
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
