import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  accessSync,
  constants,
  cpSync,
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';

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
  DSH_PERSONA_SUFFIX,
  DSH_REVIEW_SYSTEM_PROMPT,
  DSH_TOOL_LESS_SYSTEM_PROMPT,
  assembleAddressedPriorCommentsPrompt,
  assembleChangesSinceLastReviewPrompt,
  assembleFindingVerificationPrompt,
  assembleGuidelineCompliancePrompt,
  assembleGuidelineSweepPrompt,
  assembleReviewPrompt,
  buildJsonRepairPrompt,
  buildDiffRecoveryNote,
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
 * DeepSeek Harness engine (`JBOT_SDK_ENGINE=dsh`, the default): one `dsh
 * --profile headless --json` child per turn, resumed by session id for repair
 * and sweep turns. Not an npm dependency: the image installs it, and it is
 * found via `JBOT_DSH_BIN` or PATH.
 */

const DSH_TELEMETRY_CAPABILITY = 'observable' as const;
const DSH_PROMPT_TIMEOUT_MS = 15 * 60_000;

/** What the patch tells dsh and what jbot budgets prompts against: one source for both. */
export const DSH_MODEL_LIMITS = { contextTokens: 1_000_000, outputTokens: 32_768 };

const DSH_BASE_URLS: Record<string, string> = {
  opencode: 'https://opencode.ai/zen/v1',
  'opencode-go': 'https://opencode.ai/zen/go/v1',
};

// Rows that would write, read repo/HOME customizations, reach the network beyond
// the model route, or spend extra model calls on session titles.
const DSH_DISABLED_ROWS = [
  'tool-fs', // registers write/edit with read; bash under the read-only sandbox reads instead
  'tool-pwsh',
  'agent-instructions',
  'skill-filesystem',
  'tool-skill',
  'tool-web',
  'tool-workflow',
  'otel', // its packages are pruned from the image; left on, it fails the boot check
  'session-title-llm',
  'session-log-deepseek',
  'session-telemetry-otel',
  'plugin-package-inventory-deepseek',
];
const DSH_TOOL_ROWS = ['tool-bash', 'tool-fs-search', 'tool-jobs'];
// In-process children share the sandbox, tools and scrubbed env; off unless JBOT_DSH_SUBAGENTS=1.
const DSH_SUBAGENT_ROWS = ['tool-subagent', 'tool-subagent-fork'];

function resolveDshBin(env: NodeJS.ProcessEnv): string | undefined {
  const configured = env.JBOT_DSH_BIN?.trim();
  // Absolute, because the probe and sessions spawn it from their own dirs.
  const candidates = configured
    ? [resolve(configured)]
    : (env.PATH ?? '')
        .split(delimiter)
        .filter((dir) => isAbsolute(dir))
        .map((dir) => join(dir, 'dsh'));
  return candidates.find((path) => {
    try {
      accessSync(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Linux confinement is bwrap or Landlock; with neither, dsh fails every shell
 * call closed, so the review would run blind. Docker Desktop's kernel lacks
 * Landlock and Docker's default seccomp stops bwrap; Ubuntu runner kernels
 * enforce Landlock. Seatbelt is always present on macOS; Windows' ACL runner
 * leaves reads unconfined and is not a route jbot takes.
 */
function dshSandboxUsable(bin: string): boolean {
  if (process.platform !== 'linux') return process.platform === 'darwin';
  const succeeds = (command: string, args: string[]) =>
    spawnSync(command, args, { stdio: 'ignore', timeout: 5_000 }).status === 0;
  if (succeeds('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', 'true'])) {
    return true;
  }
  const runner = join('node_modules', '@deepseek-ai', `node-addon-system-linux-${process.arch}`);
  // Nested under dsh or hoisted beside it, depending on how npm laid it out.
  for (let dir = dirname(realpathSync(bin)); dir !== dirname(dir); dir = dirname(dir)) {
    const landlockRun = join(dir, runner, 'bin', 'landlock-run');
    if (existsSync(landlockRun)) return succeeds(landlockRun, ['--probe']);
  }
  return false;
}

/**
 * Composes jbot's patch, then starts the headless profile under it with no
 * key. Composing reports a row id dsh does not have (so a misspelled disabled
 * row would stay on); starting reports a plugin that cannot load (say, a
 * pruned package); the missing credential ends the turn before any network.
 */
function dshBoots(bin: string): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'jbot-dsh-probe-'));
  try {
    const patch = join(dir, 'patch.yml');
    writeFileSync(
      patch,
      buildDshPatch({
        providerID: 'opencode-go',
        modelID: 'deepseek-probe',
        workspace: dir,
        systemPrompt: '',
        routingSession: 'probe',
        toolLess: false,
      }),
    );
    const launch = (args: string[]) =>
      spawnSync(bin, ['--profile', 'headless', '--patch', patch, ...args], {
        cwd: dir,
        input: 'ping',
        encoding: 'utf8',
        timeout: 60_000,
        env: {
          PATH: process.env.PATH,
          HOME: dir,
          DSH_HOME: join(dir, 'dsh'),
          DSH_TELEMETRY_DISABLED: '1',
        },
      });
    const config = launch(['--dump-config']);
    const run = launch(['--json', '-']);
    return !config.error && !run.error && dshBootSucceeded(config, run);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The patch composed cleanly (as startDsh requires) with every row it names
 * present, and a session started with every entry activated.
 */
export function dshBootSucceeded(
  config: { status: number | null; stderr: string },
  run: { stdout: string; stderr: string },
): boolean {
  return (
    config.status === 0 &&
    !/patch: entry "[^"]*" not found/.test(config.stderr) &&
    run.stdout.includes('"type":"session"') &&
    !run.stderr.includes('did not activate')
  );
}

const unusableByBin = new Map<string, string | undefined>();

function dshUnusableReason(bin: string): string | undefined {
  if (!unusableByBin.has(bin)) {
    unusableByBin.set(
      bin,
      !dshSandboxUsable(bin)
        ? 'no usable dsh sandbox (needs Landlock or bwrap on Linux, Seatbelt on macOS)'
        : !dshBoots(bin)
          ? 'dsh failed its headless boot check'
          : undefined,
    );
  }
  return unusableByBin.get(bin);
}

/**
 * JBOT_SDK_ENGINE: `dsh` (default; `auto`, once pi, now means the same)
 * serves DeepSeek opencode/opencode-go models on DeepSeek Harness, `opencode`
 * pins the opencode server. A missing or broken dsh, an unusable sandbox, a
 * credentialed proxy or an unknown value falls back to opencode, so the engine
 * choice can never fail a run.
 */
export function resolveSdkEngine(
  env: NodeJS.ProcessEnv,
  dshBin = resolveDshBin(process.env),
  unusableReason = dshUnusableReason,
  networkEnv: NodeJS.ProcessEnv = process.env,
): { dshBin?: string; reason: string } {
  const engine = env.JBOT_SDK_ENGINE?.trim() || 'dsh';
  if (engine === 'opencode') return { reason: '' };
  if (engine !== 'dsh' && engine !== 'auto') {
    return { reason: `unknown JBOT_SDK_ENGINE value "${engine}"; using the opencode engine` };
  }
  if (!dshBin) {
    return {
      reason: 'no dsh binary (set JBOT_DSH_BIN or put dsh on PATH); using the opencode engine',
    };
  }
  // dsh hands its launch env to the shell tool, where a model could read the userinfo.
  const credentialed = DSH_NETWORK_ENV.find((name) =>
    /^[a-z][a-z0-9+.-]*:\/\/[^/@]*@/i.test(networkEnv[name] ?? ''),
  );
  if (credentialed) {
    return { reason: `${credentialed} carries credentials; using the opencode engine` };
  }
  const unusable = unusableReason(dshBin);
  return unusable ? { reason: `${unusable}; using the opencode engine` } : { dshBin, reason: '' };
}

/**
 * DeepSeek on the opencode gateways: the measured route, served on chat
 * completions. Zen serves Claude/GPT/Grok (and some Qwen/MiniMax) on other
 * APIs, and its `-free` models answer only the opencode client.
 */
export function dshServesModel(providerID: string, modelID: string): boolean {
  return (
    Object.hasOwn(DSH_BASE_URLS, providerID) &&
    modelID.startsWith('deepseek') &&
    !modelID.endsWith('-free')
  );
}

/** DeepSeek's thinking modes are off/high/max; anything else maps to its nearest. */
export function dshReasoningEffort(modelOptions?: Record<string, unknown>): string | undefined {
  const effort = modelOptions?.reasoningEffort;
  // `default` leaves the provider's own setting, as on the opencode engine.
  if (typeof effort !== 'string' || effort === 'default') return undefined;
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
  subagents?: boolean;
}): string {
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
                contextWindow: DSH_MODEL_LIMITS.contextTokens,
                maxTokens: DSH_MODEL_LIMITS.outputTokens,
                compat: { thinkingFormat: 'deepseek' },
                reasoningEfforts: { off: null, high: 'high', max: 'max' },
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
        personaSuffix: DSH_PERSONA_SUFFIX,
      },
    },
    { id: 'sandbox-policy', config: { mode: 'read-only', workspaceRoot: input.workspace } },
    // Sessions work in the checkout while dsh itself launches from a jbot-owned
    // dir: it applies the launch dir's `.env` and refuses to start on bootstrap names.
    { id: 'fs-sandbox', config: { cwd: input.workspace } },
    { id: 'approval', config: { policy: 'never' } },
    {
      id: 'permission',
      config: {
        presets: { 'read-only': { sandbox: 'read-only', approval: 'never' } },
        defaultPreset: 'read-only',
      },
    },
    ...[
      ...DSH_DISABLED_ROWS,
      ...(input.toolLess ? DSH_TOOL_ROWS : []),
      ...(input.toolLess || !input.subagents ? DSH_SUBAGENT_ROWS : []),
    ].map((id) => ({
      id,
      disabled: true,
    })),
  ];
  return JSON.stringify(rows, null, 2);
}

interface DshTurn {
  text: string;
  sessionId?: string;
  error?: string;
  usage?: PromptTokenUsage;
  steps: number;
  tools: Array<{ name: string; input: unknown; result?: unknown; ok?: boolean }>;
}

/** Folds one turn's `--json` events and exit; malformed lines are skipped, not fatal. */
export function parseDshTurn({
  stdout,
  stderr,
  exitCode,
}: {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}): DshTurn {
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
      usage.reasoning += n('reasoningTokens');
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
  // exit 1 = aborted or errored turn, which may surface without an error event.
  if (!turn.error && exitCode !== 0) {
    turn.error = `exit ${exitCode}: ${stderr.trim() || 'no stderr'}`;
  }
  return turn;
}

/** `: bash×12, grep×3` — which tools ran is not in exploration telemetry. */
function toolMix(tools: DshTurn['tools']): string {
  const counts = new Map<string, number>();
  for (const { name } of tools) counts.set(name, (counts.get(name) ?? 0) + 1);
  return counts.size ? `: ${[...counts].map(([name, n]) => `${name}×${n}`).join(', ')}` : '';
}

interface DshRuntime {
  bin: string;
  root: string;
  /** A booted DSH_HOME copied per session, so no two children share state. */
  template: string;
  workspace: string;
  mainKey: string;
  /** The aux role's own resolved key, even on the main role's provider. */
  auxKey?: string;
  mainModel: string;
  modelOptions?: Record<string, unknown>;
  auxModelOptions?: Record<string, unknown>;
  systemPrompt: string;
  scope: ReturnType<typeof createCliProcessScope>;
  toolTelemetry?: ToolTelemetryAccumulator;
}

interface DshSession {
  home: string;
  apiKey: string;
  patch: string;
  model: string;
  label: string;
  sessionId?: string;
}

// The host's route to the model endpoint, which dsh only takes from its launch env.
const DSH_NETWORK_ENV = [
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'ALL_PROXY',
  'all_proxy',
  'NO_PROXY',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
];

function childEnv(apiKey: string, home: string): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      DSH_NETWORK_ENV.flatMap((name) => {
        const value = process.env[name];
        return value ? [[name, value]] : [];
      }),
    ),
    PATH: process.env.PATH,
    HOME: home,
    DSH_HOME: join(home, 'dsh'),
    DSH_TELEMETRY_DISABLED: '1',
    GIT_OPTIONAL_LOCKS: '0',
    JBOT_DSH_API_KEY: apiKey,
  };
}

export async function startDsh(
  workspace: string,
  providerID: string,
  modelID: string,
  apiKey: string,
  log: (msg: string) => void,
  bin: string,
  options: {
    modelOptions?: Record<string, unknown>;
    auxModelOptions?: Record<string, unknown>;
    reviewDiff?: string;
    toolTelemetry?: ToolTelemetryAccumulator;
    auxKey?: string;
  } = {},
): Promise<{ runtime: DshRuntime; stop: () => Promise<void> }> {
  if (!dshServesModel(providerID, modelID)) {
    throw new Error(`The dsh engine does not serve ${providerID}/${modelID}.`);
  }
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
    mainKey: apiKey,
    ...(options.auxKey ? { auxKey: options.auxKey } : {}),
    mainModel: `${providerID}/${modelID}`,
    modelOptions: options.modelOptions,
    auxModelOptions: options.auxModelOptions,
    systemPrompt:
      DSH_REVIEW_SYSTEM_PROMPT + (options.reviewDiff ? buildDiffRecoveryNote(diffPath) : ''),
    scope,
    ...(options.toolTelemetry ? { toolTelemetry: options.toolTelemetry } : {}),
  };
  return {
    runtime,
    // The temp dirs go once every child has exited.
    stop: () => scope.stop().finally(remove),
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
  const apiKey =
    model === runtime.mainModel ? runtime.mainKey : (runtime.auxKey ?? runtime.mainKey);
  const home = mkdtempSync(join(runtime.root, 'session-'));
  cpSync(join(runtime.template, 'dsh'), join(home, 'dsh'), { recursive: true });
  const patch = join(home, 'patch.yml');
  writeFileSync(
    patch,
    buildDshPatch({
      providerID,
      modelID,
      workspace: runtime.workspace,
      systemPrompt: toolLess ? DSH_TOOL_LESS_SYSTEM_PROMPT : runtime.systemPrompt,
      routingSession: `jbot-${randomUUID()}`,
      reasoningEffort: dshReasoningEffort(
        modelOptions ??
          (model === runtime.mainModel ? runtime.modelOptions : runtime.auxModelOptions),
      ),
      toolLess,
      subagents: process.env.JBOT_DSH_SUBAGENTS === '1',
    }),
  );
  return { home, apiKey, patch, model, label };
}

// Never throws: a cleanup error must not replace the session's own failure.
function disposeDshSession(session: DshSession): void {
  try {
    rmSync(session.home, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* the runtime root is removed again at stop() */
  }
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
  let result: Awaited<ReturnType<typeof runCliProcess>>;
  try {
    // Labelled by the session, so the runner's grace abort reaches repair turns too.
    result = await runtime.scope.run(session.label, () =>
      runCliProcess(runtime.bin, args, {
        cwd: session.home,
        env: childEnv(session.apiKey, session.home),
        input: prompt,
        timeoutMs,
        timeoutMessage: `dsh ${label} prompt did not finish within ${Math.round(timeoutMs / 1000)}s`,
      }),
    );
  } catch (error) {
    telemetry(error, 0);
    onTokenUsage?.({ promptBytes }, session.model, label);
    throw error;
  }
  const turn = parseDshTurn(result);
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
      })} (${turn.steps} model calls, ${turn.tools.length} tool calls${toolMix(turn.tools)})`,
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
      const deadlineAt = Math.min(
        options.deadlineAt ?? Infinity,
        options.timeoutMs ? Date.now() + options.timeoutMs : Infinity,
      );
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
          return parseFindingVerdicts(raw, findings.length, log, { strict: true });
        } catch (error) {
          // One repair turn, as the opencode and Devin verifiers recover, so a
          // formatting slip does not withhold the whole batch.
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
          return parseFindingVerdicts(repaired, findings.length, log);
        }
      });
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
