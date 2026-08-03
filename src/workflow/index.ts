import * as core from '@actions/core';
import * as github from '@actions/github';

import {
  defaultModelOptions,
  providerConfig,
  providerCredentialSources,
  resolveProviderBaseURL,
  resolveProviderCredential,
} from '../shared/config.ts';
import { parseContext7Mode } from '../shared/context7.ts';
import { pickPooledModel, resolveAuxModel, resolveModelSelection } from '../shared/model.ts';
import { runPrReview } from '../shared/runner.ts';
import type { Octokit } from '../shared/github.ts';
import { VALID_SEVERITIES, type Severity } from '../shared/types.ts';

async function main(): Promise<void> {
  // Pessimistic default so even a validation throw (outside the try below)
  // leaves a readable terminal-state; overwritten on success.
  core.setOutput('terminal-state', 'failed');
  const failOnError = parseBooleanInput('fail-on-error', true);
  const token = core.getInput('github-token', { required: true });
  const threadResolutionToken = core.getInput('thread-resolution-token').trim();
  const providerInput = getInputOrEnv('provider', 'JBOT_REVIEW_PROVIDER');
  // Resolved before the PR lookup so a bad pool fails without spending an API
  // call; the pick needs the head sha, so it waits until that is known.
  const { providerID: provider, pool: modelPool } = resolveModelSelection(
    getInputOrEnv('model', 'JBOT_REVIEW_MODEL'),
    providerInput,
  );
  const cfg = providerConfig(provider);

  const apiKey = resolveProviderCredential(cfg, ({ input, env }) => getInputOrEnv(input, env));
  if (!apiKey) {
    const sources = providerCredentialSources(cfg);
    throw new Error(
      `Missing key for provider "${provider}". Pass ${sources.map(({ input, env }) => `"${input}" or ${env}`).join(', then fallback to ')}.`,
    );
  }

  const baseURL = resolveProviderBaseURL(provider, cfg, ({ input, env }) =>
    getInputOrEnv(input, env),
  );
  const { model: auxModel, providerID: auxProviderID } = resolveAuxModel(
    getInputOrEnv('aux-model', 'JBOT_REVIEW_AUX_MODEL'),
    provider,
    getInputOrEnv('aux-provider', 'JBOT_AUX_PROVIDER') || providerInput,
  );
  const auxCfg = auxProviderID !== provider ? providerConfig(auxProviderID) : undefined;
  const auxApiKey = auxCfg
    ? resolveProviderCredential(auxCfg, ({ input, env }) => getInputOrEnv(input, env))
    : '';
  const auxBaseURL = auxCfg
    ? resolveProviderBaseURL(auxProviderID, auxCfg, ({ input, env }) => getInputOrEnv(input, env))
    : undefined;
  const options = {
    enhancedContext: true,
    sdkEngine: getInputOrEnv('sdk-engine', 'JBOT_SDK_ENGINE') || 'auto',
    dryRun: parseBooleanInput('dry-run', false),
    autoApprove: parseBooleanInput('auto-approve', false),
    maxFindings: parseNumberInput('max-findings', 0),
    minSeverity: parseSeverityInput('min-severity', 'nit'),
    includePriorComments: parseBooleanInput('include-prior-comments', true),
    context7Mode: parseContext7Mode(core.getInput('enable-context7')),
    context7ApiKey: getInputOrEnv('context7-api-key', 'CONTEXT7_API_KEY'),
    guidelinePass: parseBooleanInput('enable-guideline-pass', true),
    auxModel,
    auxApiKey,
    auxBaseURL,
    reviewPasses: parseNumberInput('review-passes', 1),
    verifyFindings: parseBooleanInput('verify-findings', true),
    timeBudgetMinutes: parseNumberInput('time-budget-minutes', 30),
    reviewShards: parseNumberInput('review-shards', 1),
    dynamicFanout: parseBooleanInput('dynamic-fanout', true),
    modelOptions: parseJsonObjectInput('model-options', defaultModelOptions(provider)),
    promptCache: parseBooleanInput('prompt-cache', true),
    skipDocOnly: parseBooleanInput('skip-doc-only', true),
    maxConcurrentSessions: parseNumberInput('max-concurrent-sessions', 3),
    reviewTelemetry: parseBooleanInput('review-telemetry', true),
    evidenceQuotes: parseBooleanInput('evidence-quotes', true),
    // Env-only, no action input: a shard cache is only sound on persistent,
    // operator-controlled runners, and the path must live outside the checkout.
    shardCachePath: process.env.JBOT_SHARD_CACHE_DIR?.trim() ?? '',
  };
  const pullTarget = getPullRequestTarget();
  core.info(`Provider: ${provider}  Model: ${modelPool.join(', ')}`);
  core.info(
    `Options: sdkEngine=${options.sdkEngine} dryRun=${options.dryRun} autoApprove=${options.autoApprove} maxFindings=${options.maxFindings} minSeverity=${options.minSeverity} includePriorComments=${options.includePriorComments} context7=${options.context7Mode} reviewPasses=${options.reviewPasses} verifyFindings=${options.verifyFindings} auxModel=${auxModel || '(main model)'} timeBudget=${options.timeBudgetMinutes}m shards=${options.reviewShards || 'auto'} modelOptions=${JSON.stringify(options.modelOptions)} promptCache=${options.promptCache} skipDocOnly=${options.skipDocOnly} dynamicFanout=${options.dynamicFanout}`,
  );

  const octokit = github.getOctokit(token) as unknown as Octokit;
  const threadResolutionOctokit = threadResolutionToken
    ? (github.getOctokit(threadResolutionToken) as unknown as Octokit)
    : undefined;
  const owner = github.context.repo.owner;
  const repo = github.context.repo.repo;

  try {
    const pull = await resolvePullRequest(octokit, owner, repo, pullTarget);
    core.info(
      `Event: ${github.context.eventName}  PR: #${pull.number}  Action: ${github.context.payload.action ?? 'manual'}`,
    );

    const model = pickPooledModel(modelPool, pull.head.sha);
    if (modelPool.length > 1) core.info(`Model pool of ${modelPool.length}: picked ${model}`);

    let findingCount: number | undefined;
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
      baseURL,
      headSha: pull.head.sha,
      baseRef: pull.base.ref,
      baseSha: pull.base.sha,
      threadResolutionOctokit,
      options: {
        ...options,
        onReviewResult: (result) => {
          findingCount = result.findings.length;
        },
      },
      log: (msg) => core.info(msg),
    });
    // Set only after the whole run — posting included — succeeded, so the
    // output never claims findings were posted by a run that then failed.
    if (findingCount !== undefined) core.setOutput('findings-posted', String(findingCount));
    core.setOutput('terminal-state', 'completed');
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

function parseJsonObjectInput(
  name: string,
  defaultValue: Record<string, unknown>,
): Record<string, unknown> {
  const raw = core.getInput(name).trim();
  if (!raw) return defaultValue;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid JSON input "${name}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid JSON input "${name}": expected a JSON object.`);
  }
  return parsed as Record<string, unknown>;
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
