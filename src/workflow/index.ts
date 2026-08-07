import { join } from 'node:path';

import * as core from '@actions/core';
import * as github from '@actions/github';

import { defaultModelOptions, resolvePoolCredentials } from '../shared/config.ts';
import { parseModelName } from '@symma/protocol';

import { swallowedProviderWarnings } from '../shared/backend-selection.ts';
import { parseContext7Mode } from '../shared/context7.ts';
import { exitOnLingeringHandles } from '../shared/exit.ts';
import {
  pickAuxModel,
  pickPooledModel,
  resolveAuxModel,
  resolveModelSelection,
} from '../shared/model.ts';
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
  const modelPool = resolveModelSelection(
    getInputOrEnv('model', 'JBOT_REVIEW_MODEL'),
    providerInput,
  );
  const auxModelInput = getInputOrEnv('aux-model', 'JBOT_REVIEW_AUX_MODEL');
  const auxPinned = getInputOrEnv('aux-provider', 'JBOT_AUX_PROVIDER') || providerInput;
  // Probe only to learn which providers need a key. A qualified or pinned aux
  // ref names its own provider regardless of the pick; a bare one lands on the
  // picked model's provider, which the main pool already covers either way.
  const auxProbe = resolveAuxModel(
    auxModelInput,
    parseModelName(modelPool[0]).providerID,
    auxPinned,
  );
  const credentials = resolvePoolCredentials([...modelPool, ...auxProbe], ({ input, env }) =>
    getInputOrEnv(input, env),
  );
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
    reviewPasses: parseNumberInput('review-passes', 1),
    verifyFindings: parseBooleanInput('verify-findings', true),
    timeBudgetMinutes: parseNumberInput('time-budget-minutes', 30),
    reviewShards: parseNumberInput('review-shards', 1),
    dynamicFanout: parseBooleanInput('dynamic-fanout', true),
    promptCache: parseBooleanInput('prompt-cache', true),
    skipDocOnly: parseBooleanInput('skip-doc-only', true),
    maxConcurrentSessions: parseNumberInput('max-concurrent-sessions', 3),
    reviewTelemetry: parseBooleanInput('review-telemetry', true),
    evidenceQuotes: parseBooleanInput('evidence-quotes', true),
    // Env-only, no action input. Defaults into RUNNER_TEMP: outside the
    // checkout (workspace-internal dirs are rejected as forgeable) and where
    // the workflow's actions/cache pair persists it. Empty value disables.
    shardCachePath:
      process.env.JBOT_SHARD_CACHE_DIR?.trim() ??
      (process.env.RUNNER_TEMP ? join(process.env.RUNNER_TEMP, 'jbot-shard-cache') : ''),
    // Env-only while it is an A/B arm; no action input until the data lands.
    contextTrim: process.env.JBOT_CONTEXT_TRIM?.trim() === 'true',
  };
  const pullTarget = getPullRequestTarget();
  for (const warning of swallowedProviderWarnings([...modelPool, ...auxProbe])) {
    core.warning(warning);
  }
  core.info(`Model: ${modelPool.join(', ')}`);
  core.info(
    `Options: sdkEngine=${options.sdkEngine} dryRun=${options.dryRun} autoApprove=${options.autoApprove} maxFindings=${options.maxFindings} minSeverity=${options.minSeverity} includePriorComments=${options.includePriorComments} context7=${options.context7Mode} reviewPasses=${options.reviewPasses} verifyFindings=${options.verifyFindings} auxModel=${auxModelInput || '(main model)'} timeBudget=${options.timeBudgetMinutes}m shards=${options.reviewShards || 'auto'} promptCache=${options.promptCache} skipDocOnly=${options.skipDocOnly} dynamicFanout=${options.dynamicFanout}`,
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
    // The pick decides the provider, so both its credential and the provider a
    // bare aux ref belongs to are only known here.
    const { providerID } = parseModelName(model);
    const { apiKey, baseURL } = credentials.get(providerID)!;
    const auxPool = resolveAuxModel(auxModelInput, providerID, auxPinned);
    const auxModel = pickAuxModel(auxPool, pull.head.sha);
    if (auxPool.length > 1) core.info(`Aux model pool of ${auxPool.length}: picked ${auxModel}`);
    const modelOptions = parseJsonObjectInput('model-options', defaultModelOptions(providerID));
    core.info(`Model options: ${JSON.stringify(modelOptions)}`);
    const auxProviderID = auxModel ? parseModelName(auxModel).providerID : providerID;
    const auxCredential = auxProviderID === providerID ? undefined : credentials.get(auxProviderID);

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
        auxModel,
        auxApiKey: auxCredential?.apiKey ?? '',
        auxBaseURL: auxCredential?.baseURL,
        modelOptions,
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

main()
  .catch((error) => {
    core.setFailed(error instanceof Error ? error.message : String(error));
  })
  .finally(() => exitOnLingeringHandles((msg) => core.warning(msg)));
