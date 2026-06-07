import * as core from '@actions/core';
import * as github from '@actions/github';

import { PROVIDERS } from '../shared/config.ts';
import { runPrReview } from '../shared/runner.ts';
import type { Octokit } from '../shared/github.ts';

async function main(): Promise<void> {
  const token = core.getInput('github-token', { required: true });

  const provider = core.getInput('provider') || 'opencode';
  const cfg = PROVIDERS[provider];
  if (!cfg) {
    core.setFailed(
      `Unknown provider "${provider}". Supported: ${Object.keys(PROVIDERS).join(', ')}.`,
    );
    return;
  }

  const apiKey = core.getInput('api-key');
  if (!apiKey) {
    core.setFailed(`Missing API key for provider "${provider}". Pass it via the "api-key" input.`);
    return;
  }

  const model = core.getInput('model') || cfg.defaultModel;
  core.info(`Provider: ${provider}  Model: ${model}`);

  const pull = github.context.payload.pull_request;
  if (!pull) {
    core.setFailed('This action must run on a pull_request event.');
    return;
  }

  // @actions/github's getOctokit and our shared Octokit have the same plugin stack
  // (paginateRest + restEndpointMethods). TypeScript can't unify them across
  // packages, but they are structurally compatible — the methods used by
  // runPrReview are present on both.
  await runPrReview({
    octokit: github.getOctokit(token) as unknown as Octokit,
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    pullNumber: pull.number,
    pullTitle: pull.title,
    pullBody: pull.body ?? '',
    workspace: process.env.GITHUB_WORKSPACE ?? process.cwd(),
    model,
    keyEnv: cfg.keyEnv,
    apiKey,
    log: (msg) => core.info(msg),
  });
}

main().catch((error) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
