import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Readable, Writable } from 'node:stream';

import { terminateProcessTree } from './cli-process.ts';
import { codexAuthPath, codexEnvForHome } from './codex.ts';
import { CURSOR_CLI_BIN, cursorEnvForKey } from './cursor.ts';
import {
  buildDevinReadOnlyConfig,
  DEVIN_CLI_BIN,
  devinCredentialsPath,
  tomlString,
} from './devin.ts';
import { parseModelName } from './model.ts';
import {
  parseChangesSinceLastReviewSummary,
  parseFindingVerdicts,
  parseReview,
} from './opencode.ts';
import {
  assembleAddressedPriorCommentsPrompt,
  assembleChangesSinceLastReviewPrompt,
  assembleFindingVerificationPrompt,
  assembleGuidelineCompliancePrompt,
  assembleReviewPrompt,
  buildJsonRepairFollowupPrompt,
} from './prompt.ts';
import type { ReviewBackend } from './session-concurrency.ts';
import { truncateForLog } from './text.ts';
import type { AddressedPriorComment, Finding, FindingVerdict, ReviewResult } from './types.ts';

const ACP_PROMPT_TIMEOUT_MS = 20 * 60_000;
const ACP_REPAIR_PROMPT_BUDGET_BYTES = 80_000;
const ACP_REPAIR_RESPONSE_BUDGET_BYTES = 20_000;
const ACP_KILL_GRACE_MS = 2_000;
const ACP_PROTOCOL_VERSION = 1;
// One JSON-RPC frame far above any real message; growth past it means a
// runaway child, and the connection fails loud instead of buffering to OOM.
const ACP_MAX_FRAME_BYTES = 32 * 1024 * 1024;
const ACP_STDERR_TAIL_BYTES = 64 * 1024;

export const CODEX_ACP_BIN = 'codex-acp';

/**
 * ACP frames are newline-delimited JSON (no Content-Length headers). Tolerates
 * frames split across chunks and skips non-JSON lines — some CLIs print
 * banners on stdout before the protocol stream starts.
 */
export function createNdjsonReader(
  onMessage: (message: Record<string, unknown>) => void,
  maxFrameBytes = ACP_MAX_FRAME_BYTES,
): (chunk: string) => boolean {
  let buffer = '';
  let overflowed = false;
  return (chunk) => {
    if (overflowed) return false;
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      if (!line) continue;
      // A newline arriving in the same chunk as an oversized frame would
      // otherwise reach JSON.parse before the post-loop budget check.
      if (line.length > maxFrameBytes) {
        overflowed = true;
        buffer = '';
        return false;
      }
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message && typeof message === 'object') onMessage(message as Record<string, unknown>);
    }
    if (buffer.length > maxFrameBytes) {
      overflowed = true;
      buffer = '';
      return false;
    }
    return true;
  };
}

interface PermissionRequestParams {
  toolCall?: { kind?: string; title?: string };
  options?: { optionId?: string; kind?: string }[];
}

type PermissionResponse = {
  outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' };
};

// ACP ToolKind maps file mutations to edit/delete/move; `write` is not a spec
// kind but is denied too in case an agent labels nonstandardly. `switch_mode`
// is denied because jbot sets the session mode itself — approving one would
// let a prompt-injected request escape the plan-mode read-only layer.
const DENIED_TOOL_KINDS = new Set(['edit', 'delete', 'move', 'write', 'switch_mode']);

/**
 * Client-side read-only layer of invariant #8: mutating tool kinds are
 * rejected, everything else (read/search/execute/fetch — bash stays allowed
 * for git diff/log/grep) is approved. This layer is deliberately kind-based
 * and allow-by-default for unknown kinds: read tools commonly ship kind
 * `other` or none, so denying unknowns would stall reviews (a recall hole),
 * while command-level policing (e.g. bash filtering) lives in the agent-side
 * layers — codex's OS sandbox and the plan modes — which invariant #8 pairs
 * with this one. Prefers the `*_once` option so no standing grant outlives a
 * single call. Kind strings normalize `-` to `_` (cursor emits hyphens). No
 * usable option ⇒ cancelled outcome.
 */
export function respondToPermissionRequest(params: PermissionRequestParams): PermissionResponse {
  const direction = DENIED_TOOL_KINDS.has(normalizeKind(params.toolCall?.kind))
    ? 'reject'
    : 'allow';
  const options = params.options ?? [];
  const pick =
    options.find((option) => normalizeKind(option.kind) === `${direction}_once`) ??
    options.find((option) => normalizeKind(option.kind).startsWith(direction));
  return pick?.optionId
    ? { outcome: { outcome: 'selected', optionId: pick.optionId } }
    : { outcome: { outcome: 'cancelled' } };
}

function normalizeKind(kind: string | undefined): string {
  return (kind ?? '').replaceAll('-', '_');
}

interface JsonRpcMessage extends Record<string, unknown> {
  id?: unknown;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface AcpSessionIo {
  input: Writable;
  output: Readable;
}

/** Minimal JSON-RPC 2.0 peer over stdio streams: client requests/notifies,
 * plus dispatch for agent-initiated requests and notifications. */
class AcpConnection {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  constructor(
    private readonly io: AcpSessionIo,
    private readonly onNotification: (method: string, params: Record<string, unknown>) => void,
    private readonly onRequest: (method: string, params: Record<string, unknown>) => unknown,
  ) {
    const read = createNdjsonReader((message) => this.dispatch(message));
    io.output.setEncoding('utf8');
    io.output.on('data', (chunk: string | Buffer) => {
      if (!read(String(chunk))) {
        this.failAllPending(
          new Error('agent stdout exceeded the 32MB frame budget without a newline'),
        );
      }
    });
  }

  private failAllPending(error: Error): void {
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
  }

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.write({ jsonrpc: '2.0', id, method, params });
    return promise;
  }

  private write(message: Record<string, unknown>): void {
    if (!this.io.input.writable) return;
    this.io.input.write(`${JSON.stringify(message)}\n`);
  }

  private dispatch(message: JsonRpcMessage): void {
    if (message.id !== undefined && ('result' in message || 'error' in message)) {
      const entry = this.pending.get(message.id as number);
      if (!entry) return;
      this.pending.delete(message.id as number);
      if (message.error) {
        // Agents put the actionable cause in error.data (e.g. cline's
        // "requires re-authentication"), not in the generic message.
        const data =
          message.error.data === undefined ? '' : ` ${JSON.stringify(message.error.data)}`;
        entry.reject(
          new Error(
            `agent error ${message.error.code ?? ''}: ${message.error.message ?? ''}${data}`,
          ),
        );
      } else {
        entry.resolve(message.result);
      }
      return;
    }
    if (typeof message.method !== 'string') return;
    const params = (message.params ?? {}) as Record<string, unknown>;
    if (message.id !== undefined) {
      try {
        this.write({
          jsonrpc: '2.0',
          id: message.id,
          result: this.onRequest(message.method, params),
        });
      } catch {
        this.write({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: `Unsupported method: ${message.method}` },
        });
      }
      return;
    }
    this.onNotification(message.method, params);
  }
}

interface AcpSessionOptions {
  cwd: string;
  prompt: string;
  agent: string;
  label: string;
  log: (msg: string) => void;
  /** Select this model via the agent's ACP model config option (agents whose
   * spec sets modelConfigOption — CLI flags/env don't reach their sessions). */
  configOptionModelId?: string;
  /** Fail closed when plan mode is missing or cannot be set (agents with no
   * agent-side sandbox — plan mode is their behavioral read-only layer). */
  requirePlanMode?: boolean;
}

interface ModelOptionCandidate {
  value?: string;
  name?: string;
}

/** Resolves a jbot model id against a model config option's choices: exact
 * value, then display name (case-insensitive), then dotted→hyphenated value
 * (`glm-5.2` ⇒ devin's `glm-5-2`). */
export function matchModelOptionValue(
  options: ModelOptionCandidate[],
  modelID: string,
): string | undefined {
  const lower = modelID.toLowerCase();
  const match =
    options.find((option) => option.value === modelID) ??
    options.find((option) => option.name?.toLowerCase() === lower) ??
    options.find((option) => option.value === modelID.replaceAll('.', '-'));
  return match?.value;
}

interface AcpSessionResult {
  text: string;
  stopReason: string;
}

/**
 * Drives one review prompt over an ACP stdio pair: initialize → session/new →
 * plan mode when offered → session/prompt, answering permission requests with
 * the read-only policy. The returned text is the LAST assistant-message
 * segment — a new messageId (or, for agents that omit ids, a tool_call after
 * text) starts a new segment — mirroring the "final message" semantics every
 * other backend's parser expects.
 */
export async function driveAcpSession(
  io: AcpSessionIo,
  options: AcpSessionOptions,
): Promise<AcpSessionResult> {
  const { agent, label, log } = options;
  const segments: string[] = [];
  let current = '';
  let lastMessageId: unknown;
  let usesMessageIds = false;
  const flush = () => {
    if (current.trim()) segments.push(current);
    current = '';
  };

  const conn = new AcpConnection(
    io,
    (method, params) => {
      if (method !== 'session/update') return;
      const update = (params.update ?? {}) as Record<string, unknown>;
      const kind = update.sessionUpdate;
      if (kind === 'agent_message_chunk') {
        const messageId = update.messageId;
        if (messageId !== undefined) {
          usesMessageIds = true;
          if (lastMessageId !== undefined && messageId !== lastMessageId) flush();
          lastMessageId = messageId;
        }
        const content = update.content as { type?: string; text?: string } | undefined;
        if (content?.type === 'text' && typeof content.text === 'string') current += content.text;
      } else if ((kind === 'tool_call' || kind === 'tool_call_update') && !usesMessageIds) {
        flush();
      }
    },
    (method, params) => {
      if (method === 'session/request_permission') {
        const response = respondToPermissionRequest(params as PermissionRequestParams);
        if (response.outcome.outcome !== 'selected') {
          log(`acp:${agent} ${label}: permission request had no usable option; cancelled`);
        }
        return response;
      }
      throw new Error(`unsupported agent request: ${method}`);
    },
  );

  await conn.request('initialize', {
    protocolVersion: ACP_PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: 'jbot-review', version: '0' },
  });
  const session = (await conn.request('session/new', {
    cwd: options.cwd,
    mcpServers: [],
  })) as Record<string, unknown>;
  const sessionId = session.sessionId;
  if (typeof sessionId !== 'string' || !sessionId) {
    throw new Error(`acp:${agent} ${label}: session/new returned no sessionId`);
  }
  if (options.configOptionModelId) {
    await selectModelConfigOption(conn, sessionId, session, options);
  }
  const modes = session.modes as
    | { currentModeId?: string; availableModes?: { id?: string }[] }
    | undefined;
  const planOffered = modes?.availableModes?.some((mode) => mode.id === 'plan') ?? false;
  if (planOffered && modes?.currentModeId !== 'plan') {
    try {
      await conn.request('session/set_mode', { sessionId, modeId: 'plan' });
    } catch (error) {
      const detail = `plan mode unavailable (${
        error instanceof Error ? error.message : String(error)
      })`;
      // Agents with no agent-side sandbox (spec.requirePlanMode) fail CLOSED
      // here — plan mode is their behavioral read-only layer, not a nicety.
      if (options.requirePlanMode) {
        throw new Error(`acp:${agent} ${label}: ${detail}; refusing to run without it`);
      }
      log(`acp:${agent} ${label}: ${detail}; relying on permission policy`);
    }
  } else if (!planOffered && options.requirePlanMode) {
    throw new Error(
      `acp:${agent} ${label}: agent offered no plan mode; refusing to run without it`,
    );
  }
  const result = (await conn.request('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: options.prompt }],
  })) as Record<string, unknown>;
  flush();
  return {
    text: (segments[segments.length - 1] ?? '').trim(),
    stopReason: String(result?.stopReason ?? 'unknown'),
  };
}

interface ConfigOptionState {
  id?: string;
  category?: string;
  currentValue?: unknown;
  options?: ModelOptionCandidate[];
}

/** Every failure here throws: silently reviewing on a model the user did not
 * pick would misrepresent the review, so no fail-open. */
async function selectModelConfigOption(
  conn: AcpConnection,
  sessionId: string,
  session: Record<string, unknown>,
  options: AcpSessionOptions,
): Promise<void> {
  const { agent, label, configOptionModelId } = options;
  const modelId = configOptionModelId as string;
  const configOptions = (session.configOptions ?? []) as ConfigOptionState[];
  const modelOption = configOptions.find(
    (option) => option.id === 'model' || option.category === 'model',
  );
  if (!modelOption?.id) {
    throw new Error(
      `acp:${agent} ${label}: agent exposes no model config option; cannot select "${modelId}"`,
    );
  }
  const value = matchModelOptionValue(modelOption.options ?? [], modelId);
  if (!value) {
    const available = (modelOption.options ?? [])
      .map((option) => option.value)
      .filter(Boolean)
      .slice(0, 12)
      .join(', ');
    throw new Error(
      `acp:${agent} ${label}: model "${modelId}" is not offered by the agent; first offers: ${available}`,
    );
  }
  if (modelOption.currentValue === value) return;
  const updated = (await conn.request('session/set_config_option', {
    sessionId,
    configId: modelOption.id,
    value,
  })) as Record<string, unknown> | undefined;
  const after = ((updated?.configOptions ?? []) as ConfigOptionState[]).find(
    (option) => option.id === modelOption.id,
  );
  if (after?.currentValue !== value) {
    throw new Error(
      `acp:${agent} ${label}: model selection did not stick (wanted "${value}", agent reports ${JSON.stringify(after?.currentValue)})`,
    );
  }
}

interface AcpAgentSpec {
  /** jbot backend id this spec serves; the engine name becomes `acp:<id>`. */
  id: string;
  bin: string;
  args(model: string): string[];
  /** Per-spawn env + optional cleanup (temp auth copies, config files). */
  env(model: string): { env: NodeJS.ProcessEnv; cleanup?: () => void };
  /** Model rides the agent's ACP model config option — for agents (devin)
   * whose CLI flags/env/config never reach the ACP session. */
  modelConfigOption?: boolean;
  /** See AcpSessionOptions.requirePlanMode. */
  requirePlanMode?: boolean;
}

async function runAcpPrompt(
  spec: AcpAgentSpec,
  workspace: string,
  model: string,
  prompt: string,
  label: string,
  log: (msg: string) => void,
  timeoutMs = ACP_PROMPT_TIMEOUT_MS,
): Promise<string> {
  const { env, cleanup } = spec.env(model);
  const { modelID } = parseModelName(model);
  const configOptionModelId = spec.modelConfigOption && modelID !== 'default' ? modelID : undefined;
  log(`Calling ${label} prompt (agent=acp:${spec.id}, model=${model})`);
  const child = spawn(spec.bin, spec.args(model), {
    cwd: workspace,
    // Same process-group contract as cli-process.ts: a wedged agent (and any
    // child it spawned) can never outlive the review.
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  });
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-ACP_STDERR_TAIL_BYTES);
  });
  child.stdin?.on('error', (error: Error) => {
    stderr += `\n[stdin error: ${error.message}]`;
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      driveAcpSession(
        { input: child.stdin as Writable, output: child.stdout as Readable },
        {
          cwd: workspace,
          prompt,
          agent: spec.id,
          label,
          log,
          configOptionModelId,
          requirePlanMode: spec.requirePlanMode,
        },
      ),
      new Promise<never>((_, reject) => {
        child.on('error', reject);
        child.on('close', (code) =>
          reject(
            new Error(
              `acp:${spec.id} ${label} exited ${code} before responding: ${truncateForLog(stderr, 1000)}`,
            ),
          ),
        );
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `acp:${spec.id} ${label} prompt timed out after ${Math.round(timeoutMs / 1000)}s (model=${model})`,
              ),
            ),
          timeoutMs,
        );
        timer.unref();
      }),
    ]);
    log(
      `${label} prompt complete via acp:${spec.id}: stopReason=${result.stopReason} last-message=${result.text.length} chars`,
    );
    if (!result.text) {
      throw new Error(
        `acp:${spec.id} ${label} produced no assistant message (stopReason=${result.stopReason}); stderr: ${truncateForLog(stderr, 1000)}`,
      );
    }
    return result.text;
  } finally {
    if (timer) clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) {
      terminateProcessTree(child, ACP_KILL_GRACE_MS);
    }
    cleanup?.();
  }
}

/** One generic ReviewBackend over ACP: five session methods share one prompt
 * runner, so per-agent variation lives entirely in the spec table. */
export function createAcpBackend(spec: AcpAgentSpec, workspace: string): ReviewBackend {
  const run = (
    model: string,
    prompt: string,
    label: string,
    log: (msg: string) => void,
    timeoutMs?: number,
  ) => runAcpPrompt(spec, workspace, model, prompt, label, log, timeoutMs);
  return {
    name: `acp:${spec.id}`,
    async runReview(model, prContext, guidelines, log, options = {}): Promise<ReviewResult> {
      // ACP carries usage in usage_update, but mirror the other CLI backends and skip it.
      void options.onTokenUsage;
      const label = options.label ?? 'review';
      const prompt = assembleReviewPrompt(
        prContext,
        guidelines,
        options.lensAddendum ?? '',
        options.evidenceQuotes ?? false,
      );
      log(
        `Prompt assembled (${label}, acp:${spec.id}): ${prompt.length} chars, guidelines=${!!guidelines}`,
      );
      const raw = await run(model, prompt, label, log, options.timeoutMs);
      try {
        return parseReview(raw, label, log, { strict: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(
          `${label} response unparseable; sending one JSON repair prompt via acp:${spec.id}: ${message}`,
        );
        const repaired = await run(
          model,
          buildJsonRepairFollowupPrompt({
            originalPrompt: prompt,
            invalidResponse: raw,
            parseError: message,
            promptBudgetBytes: ACP_REPAIR_PROMPT_BUDGET_BYTES,
            responseBudgetBytes: ACP_REPAIR_RESPONSE_BUDGET_BYTES,
          }),
          `${label}-repair`,
          log,
          options.timeoutMs,
        );
        return parseReview(repaired, `${label}-repair`, log, { strict: true });
      }
    },
    async runAddressedPriorCommentsCheck(
      model,
      prContext,
      log,
      timeoutMs,
      onTokenUsage,
    ): Promise<AddressedPriorComment[]> {
      void onTokenUsage;
      const raw = await run(
        model,
        assembleAddressedPriorCommentsPrompt(prContext),
        'addressed-prior-comments',
        log,
        timeoutMs,
      );
      return parseReview(raw, 'addressed-prior-comments', log).addressedPriorComments;
    },
    async runGuidelineComplianceCheck(
      model,
      prContext,
      guidelines,
      log,
      timeoutMs,
      onTokenUsage,
    ): Promise<Finding[]> {
      void onTokenUsage;
      const raw = await run(
        model,
        assembleGuidelineCompliancePrompt(prContext, guidelines),
        'guideline-compliance',
        log,
        timeoutMs,
      );
      return parseReview(raw, 'guideline-compliance', log).findings;
    },
    async runFindingVerification(
      model,
      prContext,
      findings,
      log,
      timeoutMs,
      onTokenUsage,
    ): Promise<FindingVerdict[] | undefined> {
      void onTokenUsage;
      const raw = await run(
        model,
        assembleFindingVerificationPrompt(prContext, findings),
        'finding-verification',
        log,
        timeoutMs,
      );
      return parseFindingVerdicts(raw, findings.length, log);
    },
    async runChangesSinceLastReview(
      model,
      prContext,
      deltaContext,
      log,
      timeoutMs,
      onTokenUsage,
    ): Promise<string> {
      void onTokenUsage;
      const raw = await run(
        model,
        assembleChangesSinceLastReviewPrompt(prContext, deltaContext),
        'changes-since-last-review',
        log,
        timeoutMs,
      );
      return parseChangesSinceLastReviewSummary(raw, 'changes-since-last-review', log);
    },
  };
}

// No cline spec: its ACP prompt loop returns end_turn with no output
// (cline/cline#11015, reproduced on 3.0.34 and 3.0.46) — revive from git
// history once upstream fixes it.

export function cursorAcpSpec(apiKey: string): AcpAgentSpec {
  return {
    id: 'cursor',
    // Global flags precede the subcommand (docs pattern: `agent --api-key … acp`).
    bin: CURSOR_CLI_BIN,
    args: (model) => {
      const { modelID } = parseModelName(model);
      return modelID === 'default' ? ['acp'] : ['--model', modelID, 'acp'];
    },
    env: () => ({ env: cursorEnvForKey(apiKey) }),
    requirePlanMode: true,
  };
}

export function devinAcpSpec(credentialsHome = process.env.HOME || homedir()): AcpAgentSpec {
  return {
    id: 'devin',
    bin: DEVIN_CLI_BIN,
    args: () => ['acp'],
    // Per-spawn temp HOME: credentials copy plus the same read-only
    // permissions config the argv driver enforces — devin has no OS sandbox
    // in ACP mode, so this config + required plan mode are its agent-side
    // layers. --model argv, DEVIN_MODEL, and config-file agent.model never
    // reach the ACP session (verified via the session's own config-option
    // readout), so the model rides session/set_config_option instead.
    env: () => {
      const dir = mkdtempSync(join(tmpdir(), 'jbot-devin-acp-'));
      const credentials = devinCredentialsPath(dir);
      mkdirSync(dirname(credentials), { recursive: true, mode: 0o700 });
      copyFileSync(devinCredentialsPath(credentialsHome), credentials);
      const config = join(dir, '.config', 'devin', 'config.json');
      mkdirSync(dirname(config), { recursive: true, mode: 0o700 });
      writeFileSync(config, JSON.stringify(buildDevinReadOnlyConfig()), { mode: 0o600 });
      const env: NodeJS.ProcessEnv = { ...process.env, HOME: dir };
      // XDG overrides would bypass the temp HOME's config/credentials.
      delete env.XDG_CONFIG_HOME;
      delete env.XDG_DATA_HOME;
      return { env, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
    },
    modelConfigOption: true,
    requirePlanMode: true,
  };
}

export function codexAcpSpec(codexHome: string): AcpAgentSpec {
  return {
    id: 'codex',
    bin: CODEX_ACP_BIN,
    args: () => [],
    env: (model) => {
      // Same per-spawn CODEX_HOME copy as the CLI driver. Read-only and model
      // ride config.toml because the adapter takes no argv for them.
      const dir = mkdtempSync(join(tmpdir(), 'jbot-codex-acp-'));
      copyFileSync(codexAuthPath(codexHome), codexAuthPath(dir));
      const { modelID } = parseModelName(model);
      const lines = ['sandbox_mode = "read-only"'];
      if (modelID !== 'default') lines.push(`model = ${tomlString(modelID)}`);
      writeFileSync(join(dir, 'config.toml'), `${lines.join('\n')}\n`, { mode: 0o600 });
      return {
        env: codexEnvForHome(dir),
        cleanup: () => rmSync(dir, { recursive: true, force: true }),
      };
    },
  };
}
