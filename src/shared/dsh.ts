import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { appendGuidelineSweep, type GuidelineSweep } from './guideline-sweep.ts';
import { createCliProcessScope, runCliProcess } from './cli-process.ts';
import {
  formatTokenUsage,
  parseChangesSinceLastReviewSummary,
  parseFindingVerdicts,
  parseReview,
} from './opencode.ts';
import type { PromptTokenUsage, TokenUsageRecorder } from './opencode.ts';
import {
  DSH_REVIEW_SYSTEM_PROMPT,
  assembleAddressedPriorCommentsPrompt,
  assembleChangesSinceLastReviewPrompt,
  assembleFindingVerificationPrompt,
  assembleGuidelineCompliancePrompt,
  assembleGuidelineSweepPrompt,
  assembleReviewPrompt,
  buildJsonRepairPrompt,
  buildPiDiffRecoveryNote,
  CONTINUATION_NUDGE_PROMPT,
  isNoAttemptReply,
} from './prompt.ts';
import type { ReviewBackend } from './session-concurrency.ts';
import { classifyTelemetryStopReason } from './telemetry.ts';
import { isFiniteNumber, isRecord, truncateForLog } from './text.ts';
import {
  classifyReadonlyTool,
  serializedBytes,
  toolIdentity,
  type ToolTelemetryAccumulator,
} from './tool-telemetry.ts';
import { parseModelName } from '@symma/protocol';

/**
 * Experimental DeepSeek Harness engine (`JBOT_SDK_ENGINE=dsh`): each session is
 * one `dsh --profile headless --json` child per turn, resumed by session id for
 * repair and sweep turns. Opencode Zen/Go only. The CLI is not a dependency
 * (its install is ~0.5 GB); `JBOT_DSH_BIN` points at an installed `dsh`.
 */

export const DSH_TELEMETRY_CAPABILITY = 'observable' as const;
const DSH_PROMPT_TIMEOUT_MS = 15 * 60_000;
const DSH_MAX_OUTPUT_TOKENS = 32_768;

const DSH_BASE_URLS: Record<string, string> = {
  opencode: 'https://opencode.ai/zen/v1',
  'opencode-go': 'https://opencode.ai/zen/go/v1',
};

// Rows that would read repo/HOME customizations, reach the network beyond the
// model route, spawn subagents, or spend extra model calls on session titles.
const DSH_DISABLED_ROWS = [
  'tool-fs', // registers write/edit with read; bash under the read-only sandbox reads instead
  'tool-pwsh',
  'agent-instructions',
  'skill-filesystem',
  'tool-skill',
  'tool-web',
  'tool-subagent',
  'tool-subagent-fork',
  'tool-workflow',
  'session-title-llm',
  'session-log-deepseek',
  'session-telemetry-otel',
  'plugin-package-inventory-deepseek',
];
const DSH_TOOL_ROWS = ['tool-bash', 'tool-fs-search', 'tool-jobs'];

export function dshSupportsProvider(providerID: string): boolean {
  return Object.hasOwn(DSH_BASE_URLS, providerID);
}

/** DeepSeek's thinking modes are off/high/max; anything else maps to its nearest. */
export function dshReasoningEffort(
  modelID: string,
  modelOptions?: Record<string, unknown>,
): string | undefined {
  const effort = modelOptions?.reasoningEffort;
  if (!modelID.startsWith('deepseek') || typeof effort !== 'string') return undefined;
  if (effort === 'max' || effort === 'xhigh') return 'max';
  return effort === 'off' || effort === 'none' ? 'off' : 'high';
}

/** The `--patch` overlay for one session; JSON is valid YAML, so no tags are needed. */
export function buildDshPatch(input: {
  providerID: string;
  modelID: string;
  workspace: string;
  systemPrompt: string;
  routingSession: string;
  reasoningEffort?: string;
  toolLess: boolean;
}): string {
  const deepseek = input.modelID.startsWith('deepseek');
  const rows: unknown[] = [
    {
      id: 'agent-default-model',
      config: {
        provider: 'jbot',
        model: input.modelID,
        ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
      },
    },
    {
      id: 'llm-pi-ai',
      config: {
        providers: {
          jbot: {
            apiKeyEnv: 'JBOT_DSH_API_KEY',
            api: 'openai-completions',
            baseURL: DSH_BASE_URLS[input.providerID],
            // Opencode Go rejects requests it cannot route to a session.
            headers: { 'x-opencode-session': input.routingSession, 'x-opencode-client': 'jbot' },
            compat: { supportsDeveloperRole: false, maxTokensField: 'max_tokens' },
            models: [
              {
                id: input.modelID,
                contextWindow: deepseek ? 1_000_000 : 262_144,
                maxTokens: DSH_MAX_OUTPUT_TOKENS,
                ...(deepseek
                  ? {
                      compat: { thinkingFormat: 'deepseek' },
                      reasoningEfforts: { off: null, high: 'high', max: 'max' },
                    }
                  : {}),
              },
            ],
          },
        },
      },
    },
    {
      id: 'system-prompt',
      config: {
        personaPrefix: input.systemPrompt,
        personaSuffix: 'Your working directory is {{cwd}}.',
      },
    },
    { id: 'sandbox-policy', config: { mode: 'read-only', workspaceRoot: input.workspace } },
    { id: 'approval', config: { policy: 'never' } },
    {
      id: 'permission',
      config: {
        presets: { 'read-only': { sandbox: 'read-only', approval: 'never' } },
        defaultPreset: 'read-only',
      },
    },
    ...[...DSH_DISABLED_ROWS, ...(input.toolLess ? DSH_TOOL_ROWS : [])].map((id) => ({
      id,
      disabled: true,
    })),
  ];
  return JSON.stringify(rows, null, 2);
}

export interface DshTurn {
  text: string;
  sessionId?: string;
  error?: string;
  usage?: PromptTokenUsage;
  steps: number;
  tools: Array<{ name: string; input: unknown; result?: unknown; ok?: boolean }>;
}

/** Folds the `--json` event stream; malformed lines are skipped, not fatal. */
export function parseDshEvents(stdout: string): DshTurn {
  const turn: DshTurn = { text: '', steps: 0, tools: [] };
  const usage: PromptTokenUsage = {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };
  const byCall = new Map<string, DshTurn['tools'][number]>();
  for (const line of stdout.split('\n')) {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(event)) continue;
    if (event.type === 'session' && typeof event.sessionId === 'string') {
      turn.sessionId = event.sessionId;
    } else if (event.type === 'tool_call') {
      const tool = { name: String(event.tool), input: event.input };
      byCall.set(String(event.callId), tool);
      turn.tools.push(tool);
    } else if (event.type === 'tool_result') {
      const tool = byCall.get(String(event.callId));
      if (tool) Object.assign(tool, { result: event.result, ok: event.status === 'completed' });
    } else if (event.type === 'status' && event.phase === 'step_end') {
      turn.steps++;
      const step = isRecord(event.usage) ? event.usage : {};
      const n = (key: string) => (isFiniteNumber(step[key]) ? step[key] : 0);
      usage.input += n('inputTokens');
      usage.output += n('outputTokens');
      usage.cacheRead += n('cacheReadTokens');
      usage.cacheWrite += n('cacheWriteTokens');
    } else if (event.type === 'status' && event.phase === 'turn_end' && isRecord(event.reason)) {
      if (event.reason.kind !== 'completed') {
        const error = isRecord(event.reason.error) ? event.reason.error.message : undefined;
        turn.error = typeof error === 'string' ? error : `turn ended: ${String(event.reason.kind)}`;
      }
    } else if (event.type === 'error' && typeof event.message === 'string') {
      turn.error ??= event.message;
    } else if (event.type === 'final' && typeof event.text === 'string') {
      turn.text = event.text;
    }
  }
  if (turn.steps > 0) turn.usage = usage;
  return turn;
}

interface DshRuntime {
  bin: string;
  root: string;
  /** A booted DSH_HOME copied per session, so no two children share state. */
  template: string;
  workspace: string;
  providerID: string;
  apiKey: string;
  mainModel: string;
  modelOptions?: Record<string, unknown>;
  auxModelOptions?: Record<string, unknown>;
  systemPrompt: string;
  scope: ReturnType<typeof createCliProcessScope>;
  toolTelemetry?: ToolTelemetryAccumulator;
}

interface DshSession {
  home: string;
  patch: string;
  model: string;
  label: string;
  sessionId?: string;
}

function childEnv(apiKey: string, home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: home,
    DSH_HOME: join(home, 'dsh'),
    DSH_TELEMETRY_DISABLED: '1',
    JBOT_DSH_API_KEY: apiKey,
  };
}

export async function startDsh(
  workspace: string,
  providerID: string,
  modelID: string,
  apiKey: string,
  log: (msg: string) => void,
  options: {
    modelOptions?: Record<string, unknown>;
    auxModelOptions?: Record<string, unknown>;
    reviewDiff?: string;
    toolTelemetry?: ToolTelemetryAccumulator;
  } = {},
): Promise<{ runtime: DshRuntime; stop: () => void }> {
  if (!dshSupportsProvider(providerID)) {
    throw new Error(`The dsh engine serves only opencode and opencode-go, not "${providerID}".`);
  }
  const bin = process.env.JBOT_DSH_BIN?.trim() || 'dsh';
  const root = mkdtempSync(join(tmpdir(), 'jbot-dsh-'));
  const remove = () => rmSync(root, { recursive: true, force: true });
  const template = join(root, 'template');
  const diffPath = join(root, 'review.diff');
  try {
    if (options.reviewDiff) writeFileSync(diffPath, options.reviewDiff, { mode: 0o600 });
    // Boots the profile once; sessions copy it instead of racing first-boot setup.
    const patch = join(root, 'boot.yml');
    writeFileSync(
      patch,
      buildDshPatch({
        providerID,
        modelID,
        workspace,
        systemPrompt: DSH_REVIEW_SYSTEM_PROMPT,
        routingSession: 'boot',
        toolLess: true,
      }),
    );
    const boot = await runCliProcess(
      bin,
      ['--profile', 'headless', '--patch', patch, '--dump-config'],
      {
        cwd: root,
        env: childEnv(apiKey, template),
        timeoutMs: 60_000,
        timeoutMessage: 'dsh profile boot timed out',
      },
    );
    if (boot.exitCode !== 0) {
      throw new Error(`dsh profile boot failed: ${truncateForLog(boot.stderr.trim(), 1000)}`);
    }
  } catch (error) {
    remove();
    throw error;
  }
  log(`dsh engine ready (subprocess ${bin}, provider=${providerID} model=${modelID})`);
  const scope = createCliProcessScope();
  const runtime: DshRuntime = {
    bin,
    root,
    template,
    workspace,
    providerID,
    apiKey,
    mainModel: `${providerID}/${modelID}`,
    modelOptions: options.modelOptions,
    auxModelOptions: options.auxModelOptions,
    systemPrompt:
      DSH_REVIEW_SYSTEM_PROMPT + (options.reviewDiff ? buildPiDiffRecoveryNote(diffPath) : ''),
    scope,
    ...(options.toolTelemetry ? { toolTelemetry: options.toolTelemetry } : {}),
  };
  return {
    runtime,
    // Children are signalled synchronously; the temp dirs go once they have exited.
    stop: () => void scope.stop().finally(remove),
  };
}

function createDshSession(
  runtime: DshRuntime,
  model: string,
  label: string,
  toolLess: boolean,
  modelOptions?: Record<string, unknown>,
): DshSession {
  const { providerID, modelID } = parseModelName(model);
  if (providerID !== runtime.providerID) {
    throw new Error(`dsh engine serves ${runtime.providerID}, not ${model}`);
  }
  const home = mkdtempSync(join(runtime.root, 'session-'));
  cpSync(join(runtime.template, 'dsh'), join(home, 'dsh'), { recursive: true });
  const patch = join(home, 'patch.yml');
  writeFileSync(
    patch,
    buildDshPatch({
      providerID,
      modelID,
      workspace: runtime.workspace,
      systemPrompt: runtime.systemPrompt,
      routingSession: `jbot-${randomUUID()}`,
      reasoningEffort: dshReasoningEffort(
        modelID,
        modelOptions ??
          (model === runtime.mainModel ? runtime.modelOptions : runtime.auxModelOptions),
      ),
      toolLess,
    }),
  );
  return { home, patch, model, label };
}

function disposeDshSession(session: DshSession): void {
  rmSync(session.home, { recursive: true, force: true });
}

async function promptDshSession(
  runtime: DshRuntime,
  session: DshSession,
  prompt: string,
  label: string,
  log: (msg: string) => void,
  timeoutMs = DSH_PROMPT_TIMEOUT_MS,
  onTokenUsage?: TokenUsageRecorder,
): Promise<string> {
  const { providerID, modelID } = parseModelName(session.model);
  log(`Calling ${label} prompt (engine=dsh, provider=${providerID} model=${modelID})`);
  const promptBytes = Buffer.byteLength(prompt, 'utf8');
  const args = ['--profile', 'headless', '--patch', session.patch, '--json'];
  if (session.sessionId) args.push('--session-id', session.sessionId);
  args.push('-');
  const telemetry = (
    stopReason: Parameters<typeof classifyTelemetryStopReason>[0] | 'completed',
    steps: number,
  ) =>
    runtime.toolTelemetry?.finishSession({
      session: label,
      backend: 'dsh',
      capability: DSH_TELEMETRY_CAPABILITY,
      budgetTier: 'observe-only',
      stopReason:
        stopReason === 'completed' ? 'completed' : classifyTelemetryStopReason(stopReason),
      turnCount: steps,
    });
  let stdout: string;
  try {
    // Labelled by the session, so the runner's grace abort reaches repair turns too.
    ({ stdout } = await runtime.scope.run(session.label, () =>
      runCliProcess(runtime.bin, args, {
        cwd: runtime.workspace,
        env: childEnv(runtime.apiKey, session.home),
        input: prompt,
        timeoutMs,
        timeoutMessage: `dsh ${label} prompt did not finish within ${Math.round(timeoutMs / 1000)}s`,
      }),
    ));
  } catch (error) {
    telemetry(error, 0);
    onTokenUsage?.({ promptBytes }, session.model, label);
    throw error;
  }
  const turn = parseDshEvents(stdout);
  session.sessionId ??= turn.sessionId;
  for (const tool of turn.tools) {
    const toolClass = classifyReadonlyTool(tool.name, tool.input);
    runtime.toolTelemetry?.startTool({
      session: label,
      backend: 'dsh',
      capability: DSH_TELEMETRY_CAPABILITY,
      toolClass,
      inputBytes: serializedBytes(tool.input),
      ...toolIdentity(toolClass, tool.input),
    })({
      success: tool.ok === true,
      outputBytesBeforeCap: serializedBytes(tool.result),
      outputBytesAfterCap: serializedBytes(tool.result),
    });
  }
  if (turn.usage) {
    log(
      `${label} ${formatTokenUsage({
        tokens: {
          input: turn.usage.input,
          output: turn.usage.output,
          cache: { read: turn.usage.cacheRead, write: turn.usage.cacheWrite },
        },
      })} (${turn.steps} model calls, ${turn.tools.length} tool calls)`,
    );
  }
  onTokenUsage?.({ ...turn.usage, promptBytes } as PromptTokenUsage, session.model, label);
  if (turn.error) {
    const error = new Error(
      `dsh ${label} prompt failed (${session.model}): ${truncateForLog(turn.error, 1000)}`,
    );
    telemetry(error, turn.steps);
    throw error;
  }
  telemetry('completed', turn.steps);
  if (!turn.text) log(`${label} response contained no text output`);
  return turn.text;
}

async function repromptDshForJson(
  runtime: DshRuntime,
  session: DshSession,
  raw: string,
  parseError: unknown,
  label: string,
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
): Promise<string> {
  if (isNoAttemptReply(raw)) {
    log(`${label} ended its turn without attempting the task; sending one continuation prompt`);
    return promptDshSession(
      runtime,
      session,
      CONTINUATION_NUDGE_PROMPT,
      `${label}-continue`,
      log,
      timeoutMs,
      onTokenUsage,
    );
  }
  const message = parseError instanceof Error ? parseError.message : String(parseError);
  log(`${label} response unparseable; sending one JSON repair prompt: ${message}`);
  return promptDshSession(
    runtime,
    session,
    buildJsonRepairPrompt(message),
    `${label}-repair`,
    log,
    timeoutMs,
    onTokenUsage,
  );
}

async function withDshSession<T>(
  runtime: DshRuntime,
  model: string,
  label: string,
  toolLess: boolean,
  modelOptions: Record<string, unknown> | undefined,
  run: (session: DshSession) => Promise<T>,
): Promise<T> {
  const session = createDshSession(runtime, model, label, toolLess, modelOptions);
  try {
    return await run(session);
  } finally {
    disposeDshSession(session);
  }
}

async function runDshAux<K extends 'findings' | 'addressedPriorComments'>(
  runtime: DshRuntime,
  model: string,
  label: string,
  prompt: string,
  field: K,
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
  modelOptions?: Record<string, unknown>,
) {
  return withDshSession(runtime, model, label, false, modelOptions, async (session) => {
    const raw = await promptDshSession(
      runtime,
      session,
      prompt,
      label,
      log,
      timeoutMs,
      onTokenUsage,
    );
    try {
      return parseReview(raw, label, log, { strict: true, field })[field];
    } catch (error) {
      const repaired = await repromptDshForJson(
        runtime,
        session,
        raw,
        error,
        label,
        log,
        timeoutMs,
        onTokenUsage,
      );
      return parseReview(repaired, `${label}-repair`, log, { strict: true, field })[field];
    }
  });
}

export function createDshBackend(runtime: DshRuntime): ReviewBackend {
  return {
    name: 'dsh',
    supportsGuidelineSweep: true,
    observability: DSH_TELEMETRY_CAPABILITY,
    abortSessionsByLabel: (label, log) => {
      const count = runtime.scope.abort(label);
      if (count) log(`Aborted ${count} dsh ${label} session(s).`);
      return count;
    },
    runReview: (model, prContext, guidelines, log, options = {}) => {
      const label = options.label ?? 'review';
      const deadlineAt = options.timeoutMs ? Date.now() + options.timeoutMs : undefined;
      const prompt = assembleReviewPrompt(
        prContext,
        guidelines,
        options.lensAddendum ?? '',
        options.evidenceQuotes ?? false,
        options.embeddedFirstPrompt ?? false,
        { contextFirst: options.contextFirst, contextPack: options.contextPack },
      );
      log(`Prompt assembled (${label}): ${prompt.length} chars, guidelines=${!!guidelines}`);
      return withDshSession(runtime, model, label, false, undefined, async (session) => {
        const { timeoutMs, onTokenUsage } = options;
        const raw = await promptDshSession(
          runtime,
          session,
          prompt,
          label,
          log,
          timeoutMs,
          onTokenUsage,
        );
        let result;
        try {
          result = parseReview(raw, label, log, { strict: true });
        } catch (error) {
          const repaired = await repromptDshForJson(
            runtime,
            session,
            raw,
            error,
            label,
            log,
            timeoutMs,
            onTokenUsage,
          );
          result = parseReview(repaired, `${label}-repair`, log, { strict: true });
        }
        const sweep: GuidelineSweep | undefined = options.guidelineSweep;
        if (!sweep) return result;
        const sweepLabel = `guideline-sweep-${label}`;
        return appendGuidelineSweep(
          result,
          sweep,
          sweepLabel,
          deadlineAt,
          async (sweepTimeoutMs) => {
            const raw = await promptDshSession(
              runtime,
              session,
              assembleGuidelineSweepPrompt(sweep.guidelines),
              sweepLabel,
              log,
              sweepTimeoutMs,
              onTokenUsage,
            );
            return parseReview(raw, sweepLabel, log, { strict: true }).findings;
          },
          log,
        );
      });
    },
    runAddressedPriorCommentsCheck: (model, prContext, log, timeoutMs, onTokenUsage) =>
      runDshAux(
        runtime,
        model,
        'addressed-prior-comments',
        assembleAddressedPriorCommentsPrompt(prContext),
        'addressedPriorComments',
        log,
        timeoutMs,
        onTokenUsage,
      ),
    runGuidelineComplianceCheck: (
      model,
      prContext,
      guidelines,
      log,
      timeoutMs,
      onTokenUsage,
      modelOptions,
    ) =>
      runDshAux(
        runtime,
        model,
        'guideline-compliance',
        assembleGuidelineCompliancePrompt(prContext, guidelines),
        'findings',
        log,
        timeoutMs,
        onTokenUsage,
        modelOptions,
      ),
    runFindingVerification: (
      model,
      prContext,
      findings,
      log,
      timeoutMs,
      onTokenUsage,
      modelOptions,
    ) => {
      const label = 'finding-verification';
      // Unprojected findings: a field subset would drop `evidence` (see the opencode engine).
      const prompt = assembleFindingVerificationPrompt(prContext, findings, false);
      return withDshSession(runtime, model, label, false, modelOptions, async (session) =>
        parseFindingVerdicts(
          await promptDshSession(runtime, session, prompt, label, log, timeoutMs, onTokenUsage),
          findings.length,
          log,
        ),
      );
    },
    runChangesSinceLastReview: (model, deltaContext, log, timeoutMs, onTokenUsage) => {
      const label = 'changes-since-last-review';
      return withDshSession(runtime, model, label, true, undefined, async (session) =>
        parseChangesSinceLastReviewSummary(
          await promptDshSession(
            runtime,
            session,
            assembleChangesSinceLastReviewPrompt(deltaContext, true),
            label,
            log,
            timeoutMs,
            onTokenUsage,
          ),
          label,
          log,
        ),
      );
    },
  };
}
