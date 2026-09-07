import { createHash } from 'node:crypto';
import { parseModelName } from '@symma/protocol';
import { backendCanReadWorkspace, cliBackendForProvider } from './backend-selection.ts';
import { modelSupportsAgenticTools } from './config.ts';
import type { ReviewBackend } from './session-concurrency.ts';
import { commandCodeSessionEffort } from './commandcode.ts';
import { piThinkingLevel } from './pi.ts';
import { poolsideReasoningEffort } from './poolside.ts';
import type { ReviewRunOptions } from './runner.ts';

declare const __JBOT_REVIEWER_REVISION__: string;

const POLICY_KEYS = [
  'enhancedContext',
  'scrubSessionEnv',
  'dryRun',
  'autoApprove',
  'maxFindings',
  'minSeverity',
  'includePriorComments',
  'context7Mode',
  'guidelinePass',
  'contextTrim',
  'embeddedFirstPrompt',
  'guidelineWiden',
  'verifierSlimContext',
  'commandCodeTools',
  'verifyOverlapGrace',
  'reviewPasses',
  'verifyFindings',
  'timeBudgetMinutes',
  'reviewShards',
  'modelOptionsExplicit',
  'promptCache',
  'skipDocOnly',
  'skipUnchanged',
  'dynamicFanout',
  'maxConcurrentSessions',
  'evidenceQuotes',
] as const satisfies readonly (keyof ReviewRunOptions)[];

export function runConfiguration(options: ReviewRunOptions, model: string) {
  const configuration = {
    ...Object.fromEntries(POLICY_KEYS.map((key) => [key, options[key]])),
    sdkEngine: ['auto', 'opencode'].includes(options.sdkEngine ?? '')
      ? options.sdkEngine
      : 'unrecognized',
    shardCacheEnabled: Boolean(options.shardCachePath),
    modelPool: options.modelPool?.length ? options.modelPool : [model],
    requestedReasoningEffort: knownEffort(options.modelOptions?.reasoningEffort),
  };
  return {
    configuration,
    configurationHash: createHash('sha256').update(JSON.stringify(configuration)).digest('hex'),
  };
}

export function runIdentity(env: NodeJS.ProcessEnv) {
  return {
    reviewerRevision:
      typeof __JBOT_REVIEWER_REVISION__ === 'string' ? __JBOT_REVIEWER_REVISION__ : 'unbundled',
    ...(/^[1-9]\d*$/.test(env.GITHUB_RUN_ID ?? '') ? { workflowRunId: env.GITHUB_RUN_ID } : {}),
    ...(/^[1-9]\d*$/.test(env.GITHUB_RUN_ATTEMPT ?? '')
      ? { workflowRunAttempt: Number(env.GITHUB_RUN_ATTEMPT) }
      : {}),
    ...(/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(env.GITHUB_JOB ?? '')
      ? { workflowJob: env.GITHUB_JOB }
      : {}),
    ...(env.JBOT_IMAGE_VARIANT === 'full' || env.JBOT_IMAGE_VARIANT === 'slim'
      ? { imageVariant: env.JBOT_IMAGE_VARIANT }
      : {}),
  };
}

function knownEffort(value: unknown): string | undefined {
  return typeof value === 'string' &&
    /^(none|off|minimal|low|medium|high|xhigh|max|ultra|default)$/.test(value)
    ? value
    : undefined;
}

export function effectiveReasoningEffort(
  backend: string,
  model: string,
  modelOptions: Record<string, unknown> | undefined,
  commandCodeContext: Parameters<typeof commandCodeSessionEffort>[2],
  override?: Record<string, unknown>,
): string | undefined {
  if (backend === 'commandcode')
    return commandCodeSessionEffort(model, override, commandCodeContext);
  if (backend === 'pi') return piThinkingLevel(modelOptions);
  if (backend !== 'opencode' && backend !== 'poolside') return undefined;
  const effort = knownEffort(
    backend === 'poolside' ? poolsideReasoningEffort(modelOptions) : modelOptions?.reasoningEffort,
  );
  return effort === 'default' ? undefined : effort;
}

export function roleTelemetry(
  backend: Pick<ReviewBackend, 'name' | 'observability' | 'canReadWorkspace'> | undefined,
  model: string,
  reasoningEffort?: string,
) {
  const { providerID, modelID } = parseModelName(model);
  const canReadWorkspace =
    backend &&
    (backend.canReadWorkspace ??
      backendCanReadWorkspace(providerID, cliBackendForProvider(providerID))) &&
    (backend.name !== 'opencode' || modelSupportsAgenticTools(providerID, modelID));
  return {
    model,
    backend: backend?.name ?? 'unavailable',
    capability: backend?.observability ?? 'opaque',
    workspaceAccess: !backend
      ? ('unavailable' as const)
      : canReadWorkspace
        ? ('read-only' as const)
        : ('embedded-only' as const),
    reasoningEffort: backend ? reasoningEffort : undefined,
  };
}
