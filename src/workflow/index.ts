import * as core from '@actions/core';
import * as github from '@actions/github';

import { PROVIDERS } from '../shared/config.ts';
import { parseModelName } from '../shared/model.ts';
import { runPrReview } from '../shared/runner.ts';
import type { Octokit } from '../shared/github.ts';
import type { Severity } from '../shared/types.ts';

const VALID_SEVERITIES: ReadonlySet<Severity> = new Set(['P0', 'P1', 'P2', 'P3', 'nit']);

async function main(): Promise<void> {
  const failOnError = parseBooleanInput('fail-on-error', true);
  const token = core.getInput('github-token', { required: true });
  const provider = getInputOrEnv('provider', 'JBOT_REVIEW_PROVIDER', 'PROVIDER') || 'opencode';
  const cfg = PROVIDERS[provider];
  if (!cfg) {
    throw new Error(
      `Unknown provider "${provider}". Supported: ${Object.keys(PROVIDERS).join(', ')}.`,
    );
  }

  const apiKey = getInputOrEnv(cfg.keyInput, cfg.keyEnv);
  if (!apiKey) {
    throw new Error(
      `Missing API key for provider "${provider}". Pass it via the "${cfg.keyInput}" input or ${cfg.keyEnv} env var.`,
    );
  }

  const model = getInputOrEnv('model', 'JBOT_REVIEW_MODEL', 'MODEL') || cfg.defaultModel;
  const parsedModel = parseModelName(model);
  if (parsedModel.providerID !== provider) {
    throw new Error(
      `Provider "${provider}" does not match model "${model}". Set provider="${parsedModel.providerID}" or choose a ${provider}/... model.`,
    );
  }
  const options = {
    enhancedContext: true,
    dryRun: parseBooleanInput('dry-run', false),
    maxFindings: parseNumberInput('max-findings', 0),
    minSeverity: parseSeverityInput('min-severity', 'nit'),
    includePriorComments: parseBooleanInput('include-prior-comments', true),
  };
  const pullTarget = getPullRequestTarget();
  core.info(`Provider: ${provider}  Model: ${model}`);
  core.info(
    `Options: dryRun=${options.dryRun} maxFindings=${options.maxFindings} minSeverity=${options.minSeverity} includePriorComments=${options.includePriorComments}`,
  );

  const octokit = github.getOctokit(token) as unknown as Octokit;
  const owner = github.context.repo.owner;
  const repo = github.context.repo.repo;

  try {
    const pull = await resolvePullRequest(octokit, owner, repo, pullTarget);
    core.info(
      `Event: ${github.context.eventName}  PR: #${pull.number}  Action: ${github.context.payload.action ?? 'manual'}`,
    );

    await runPrReview({
      octokit,
      owner,
      repo,
      pullNumber: pull.number,
      pullTitle: pull.title,
      pullBody: pull.body ?? '',
      workspace: process.env.GITHUB_WORKSPACE ?? process.cwd(),
      model,
      apiKey,
      headSha: pull.head.sha,
      options,
      log: (msg) => core.info(msg),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (failOnError) core.setFailed(message);
    else core.warning(`Review failed but fail-on-error=false: ${message}`);
  }
}

function getInputOrEnv(inputName: string, ...envNames: string[]): string {
  const input = core.getInput(inputName).trim();
  if (input) return input;

  for (const envName of envNames) {
    const value = process.env[envName]?.trim();
    if (value) return value;
  }

  return '';
}

function getPullRequestTarget(): NonNullable<typeof github.context.payload.pull_request> | number {
  const pull = github.context.payload.pull_request;
  if (pull) return pull;

  const pullNumber = parseNumberInput('pr-number', 0);
  if (pullNumber <= 0) {
    throw new Error(
      'This action must run on a pull_request event or receive a positive "pr-number" input.',
    );
  }

  return pullNumber;
}

async function resolvePullRequest(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullTarget: NonNullable<typeof github.context.payload.pull_request> | number,
) {
  if (typeof pullTarget !== 'number') return pullTarget;

  const response = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: pullTarget,
  });
  return response.data;
}

function parseBooleanInput(name: string, defaultValue: boolean): boolean {
  const value = core.getInput(name).trim().toLowerCase();
  if (!value) return defaultValue;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`Invalid boolean input "${name}": expected true or false, got "${value}".`);
}

function parseNumberInput(name: string, defaultValue: number): number {
  const raw = core.getInput(name).trim();
  if (!raw) return defaultValue;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(
      `Invalid numeric input "${name}": expected a non-negative integer, got "${raw}".`,
    );
  }
  return value;
}

function parseSeverityInput(name: string, defaultValue: Severity): Severity {
  const value = core.getInput(name).trim();
  if (!value) return defaultValue;
  if (!VALID_SEVERITIES.has(value as Severity)) {
    throw new Error(`Invalid severity input "${name}": expected one of P0, P1, P2, P3, nit.`);
  }
  return value as Severity;
}

main().catch((error) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
