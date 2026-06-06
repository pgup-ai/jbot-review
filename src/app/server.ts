import { createServer } from "node:http";
import { Webhooks, createNodeMiddleware } from "@octokit/webhooks";

import { PROVIDERS } from "../shared/config.ts";
import { handlePrEvent } from "./app.ts";
import type { AppConfig } from "./app.ts";

function mustEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

const provider = process.env.PROVIDER || "opencode";
const cfg = PROVIDERS[provider];
if (!cfg) {
  throw new Error(`Unknown provider "${provider}". Supported: ${Object.keys(PROVIDERS).join(", ")}.`);
}

const appCfg: AppConfig = {
  appId: mustEnv("GITHUB_APP_ID"),
  privateKey: mustEnv("GITHUB_APP_PRIVATE_KEY").replace(/\\n/g, "\n"),
  keyEnv: cfg.keyEnv,
  apiKey: mustEnv(cfg.keyEnv),
  model: process.env.MODEL || cfg.defaultModel,
};

const webhooks = new Webhooks({ secret: mustEnv("GITHUB_WEBHOOK_SECRET") });

webhooks.on("pull_request.opened", (event) => handlePrEvent(event, appCfg));
webhooks.on("pull_request.synchronize", (event) => handlePrEvent(event, appCfg));

webhooks.onError((error) => {
  console.error(`[jbot-review] webhook error: ${error.message}`);
});

const port = Number(process.env.PORT) || 3000;

createServer(createNodeMiddleware(webhooks, { path: "/webhooks" }))
  .listen(port, () => {
    console.log(`[jbot-review] App server listening on :${port} (provider: ${provider})`);
  });
