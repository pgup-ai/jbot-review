import { join } from 'node:path';

import * as core from '@actions/core';
import * as github from '@actions/github';

import {
  defaultModelOptions,
  parseEnvBoolean,
  parseEnvGuidelineWiden,
  resolvePoolCredentials,
} from '../shared/config.ts';
import { parseModelName } from '@symma/protocol';

import { swallowedProviderWarnings } from '../shared/backend-selection.ts';
import { parseContext7Mode } from '../shared/context7.ts';
import { exitOnLingeringHandles } from '../shared/exit.ts';
import { takeOpencodeProxyEnv } from '../shared/opencode.ts';
import {
  pickReviewModels,
  removedAuxInputWarnings,
  resolveModelSelection,
} from '../shared/model.ts';
import { runPrReview } from '../shared/runner.ts';
import type { Octokit } from '../shared/github.ts';
import { VALID_SEVERITIES, type Severity } from '../shared/types.ts';
import { sdkEngineForProxy, verifyOpencodeProxy } from './proxy.ts';

async function main(): Promise<void> {
  const requestedOpencodeProxyEnv = takeOpencodeProxyEnv(process.env);
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
  for (const warning of removedAuxInputWarnings(getInputOrEnv)) core.warning(warning);
  const credentials = resolvePoolCredentials(modelPool, ({ input, env }) =>
    getInputOrEnv(input, env),
  );
  const options = {
    enhancedContext: true,
    opencodeProxyEnv: {},
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
    // Env rather than action inputs: neither belongs in the published contract.
    contextTrim: parseEnvBoolean('JBOT_CONTEXT_TRIM', false),
    embeddedFirstPrompt: parseEnvBoolean('JBOT_EMBEDDED_FIRST_PROMPT', true),
    guidelineWiden: parseEnvGuidelineWiden('JBOT_GUIDELINE_WIDEN'),
    verifierSlimContext: parseEnvBoolean('JBOT_VERIFIER_SLIM_CONTEXT', false),
    verifyOverlapGrace: parseEnvBoolean('JBOT_VERIFY_OVERLAP_GRACE', false),
  };
  const pullTarget = getPullRequestTarget();
  for (const warning of swallowedProviderWarnings(modelPool)) {
    core.warning(warning);
  }
  core.info(`Model: ${modelPool.join(', ')}`);

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
    options.opencodeProxyEnv = await verifyOpencodeProxy(
      requestedOpencodeProxyEnv,
      pull.head.repo?.full_name === `${owner}/${repo}`,
      core,
    );
    options.sdkEngine = sdkEngineForProxy(options.sdkEngine, options.opencodeProxyEnv);
    core.info(
      `Options: sdkEngine=${options.sdkEngine} dryRun=${options.dryRun} autoApprove=${options.autoApprove} maxFindings=${options.maxFindings} minSeverity=${options.minSeverity} includePriorComments=${options.includePriorComments} context7=${options.context7Mode} reviewPasses=${options.reviewPasses} verifyFindings=${options.verifyFindings} timeBudget=${options.timeBudgetMinutes}m shards=${options.reviewShards || 'auto'} promptCache=${options.promptCache} skipDocOnly=${options.skipDocOnly} dynamicFanout=${options.dynamicFanout} contextTrim=${options.contextTrim} embeddedFirstPrompt=${options.embeddedFirstPrompt}`,
    );

    const { model, auxModel } = pickReviewModels(
      modelPool,
      pull.head.sha,
      github.context.runAttempt,
    );
    if (modelPool.length > 1) {
      core.info(
        `Model pool of ${modelPool.length}: picked ${model} (aux ${auxModel}) for workflow attempt ${github.context.runAttempt}`,
      );
    }
    // The picks decide the providers, so their credentials are only known here.
    const { providerID } = parseModelName(model);
    const { apiKey, baseURL } = credentials.get(providerID)!;
    const modelOptions = parseJsonObjectInput('model-options', defaultModelOptions(providerID));
    core.info(`Model options: ${JSON.stringify(modelOptions)}`);
    const auxProviderID = parseModelName(auxModel).providerID;
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
        modelOptionsExplicit: core.getInput('model-options').trim() !== '',
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
