import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OpenCodeClient } from '@opencode/client';
import { parseModelName } from '@symma/protocol';
import {
  MAIN_AGENT,
  PLAIN_AGENT,
  REVIEWER_AGENT,
  WRAPUP_AGENT,
  permissionRules,
  sessionEnvironment,
  sessionModelOptions,
  type OptionTier,
} from './opencode-config.ts';
import type { OpencodeRuntime } from './opencode-server.ts';
import { WRAP_UP_PROMPT } from './prompt.ts';
import { WRAP_UP_MARGIN_MS, wrapUpReserveMs } from './time-budget.ts';
import {
  extractPromptTokenUsage,
  formatTokenUsage,
  type PromptTokenUsage,
  type TokenUsageRecorder,
} from './token-usage.ts';
import {
  classifyReadonlyTool,
  serializedBytes,
  toolIdentity,
  type ToolTelemetryAccumulator,
} from './tool-telemetry.ts';

const PROMPT_TIMEOUT_MS = 15 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
/** Below undici's 300 s headersTimeout: `session.wait` answers only when the turn is idle. */
const WAIT_SLICE_MS = 240_000;
/** `session.wait` returned with the turn complete in every probe; this bounds the documented-but-unseen "admitted, not started" gap. */
const SETTLE_POLL_MS = 1_000;
const SETTLE_POLL_LIMIT = 10;
const TRANSCRIPT_CAP_BYTES = 2 * 1024 * 1024;
export const OPENCODE_TELEMETRY_CAPABILITY = 'observable' as const;
/** V2 tool ids → the names the shared telemetry classifier knows. */
const TOOL_CLASS_ALIASES: Record<string, string> = { shell: 'bash', execute: 'bash' };

/**
 * Bounds in-flight model sessions. Free / throttled provider tiers serialize
 * concurrent requests on one API key upstream anyway — observed as a
 * flash-tier session taking 7+ minutes while queued behind parallel shards.
 * Capping concurrency on OUR side keeps each session's deadline measuring
 * model time, not queue time. High-priority waiters wake first; each priority
 * remains FIFO. 0 = unlimited.
 */
export type SemaphorePriority = 'high' | 'normal';

export class Semaphore {
  private highPriorityQueue: Array<() => void> = [];
  private normalPriorityQueue: Array<() => void> = [];
  private active = 0;

  constructor(private readonly limit: number) {}

  async acquire(priority: SemaphorePriority = 'normal', signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    if (this.limit === 0) return () => undefined;
    if (this.active < this.limit) {
      this.active += 1;
    } else {
      const queue = priority === 'high' ? this.highPriorityQueue : this.normalPriorityQueue;
      await new Promise<void>((resolve, reject) => {
        const grant = () => {
          signal?.removeEventListener('abort', abort);
          resolve();
        };
        const abort = () => {
          queue.splice(queue.indexOf(grant), 1);
          reject(signal?.reason);
        };
        queue.push(grant);
        signal?.addEventListener('abort', abort, { once: true });
      });
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.highPriorityQueue.shift() ?? this.normalPriorityQueue.shift();
      if (next) {
        next();
      } else {
        this.active -= 1;
      }
    };
  }

  isBusy(): boolean {
    return (
      this.active > 0 || this.highPriorityQueue.length > 0 || this.normalPriorityQueue.length > 0
    );
  }
}

let sessionSlots: Semaphore | undefined;
let sessionSlotLimit = 0;

export function configureSessionConcurrency(limit: number): void {
  const normalized = Math.max(0, Math.floor(limit));
  if (normalized === sessionSlotLimit) return;
  if (sessionSlots?.isBusy()) return;
  sessionSlotLimit = normalized;
  sessionSlots = normalized > 0 ? new Semaphore(normalized) : undefined;
}

const toolTelemetry = new WeakMap<object, ToolTelemetryAccumulator>();
export function configureOpencodeTelemetry(
  client: OpenCodeClient,
  telemetry: ToolTelemetryAccumulator,
): void {
  toolTelemetry.set(client, telemetry);
}

/** sessionID → label, for the progress logger; sessions are never removed (ids are unique per run). */
const labelsByClient = new WeakMap<object, Map<string, string>>();
function rememberLabel(client: OpenCodeClient, sessionID: string, label: string): void {
  const labels = labelsByClient.get(client) ?? new Map<string, string>();
  labelsByClient.set(client, labels);
  labels.set(sessionID, label);
}

/** The fields jbot reads from a V2 assistant message (structural; no generated-type import). */
export interface AssistantMessage {
  id: string;
  type: string;
  time: { created: number; completed?: number };
  content?: Array<
    | { type: 'text'; text: string }
    | { type: 'reasoning'; text: string }
    | {
        type: 'tool';
        id: string;
        name: string;
        state: {
          status: string;
          input?: Record<string, unknown>;
          content?: unknown;
          error?: unknown;
        };
        time: { created: number; ran?: number; completed?: number };
      }
  >;
  finish?: string;
  cost?: number;
  tokens?: {
    input: number;
    output: number;
    reasoning: number;
    cache: { read: number; write: number };
  };
  error?: unknown;
}

export interface PromptOutcome {
  wrappedUp: boolean;
}

export interface PromptSpec {
  model: string;
  text: string;
  label: string;
  timeoutMs?: number;
  log: (msg: string) => void;
  onTokenUsage?: TokenUsageRecorder;
  /** Grace-abort registry key; repair/continue prompts keep the BASE label. */
  abortLabel?: string;
  /** Present only for callers that record a partial outcome (they may take the wrap-up reserve). */
  outcome?: PromptOutcome;
  /** Test hook: reserve to keep for the wrap-up instead of wrapUpReserveMs(timeoutMs). */
  wrapUpReserveMs?: number;
  /** Test hook: wait slice length instead of WAIT_SLICE_MS. */
  waitSliceMs?: number;
}

export interface PromptResult {
  text: string;
  message: AssistantMessage;
}

export interface CreateSessionSpec {
  label: string;
  model: string;
  /** Which configured options the session gets; verification runs one tier below the finder. */
  tier?: OptionTier;
  /** Defaults to the plan agent; single-shot models get jbot-plain. */
  agent?: string;
  /** Fork this session's history instead of starting empty. */
  forkFrom?: string;
}

function location(runtime: OpencodeRuntime) {
  return { directory: runtime.workspace };
}

function modelRef(model: string) {
  const { providerID, modelID } = parseModelName(model);
  return { providerID, id: modelID };
}

/** A session at the workspace with the ruleset, the agent, the model, and an allowlisted shell env. */
export async function createReviewSession(
  runtime: OpencodeRuntime,
  spec: CreateSessionSpec,
): Promise<string> {
  const { client } = runtime;
  const agent = spec.agent ?? MAIN_AGENT;
  const model = modelRef(spec.model);
  let sessionID: string;
  if (spec.forkFrom) {
    sessionID = (await client.session.fork({ sessionID: spec.forkFrom })).id;
    await client.session.switchAgent({ sessionID, agent });
    await client.session.switchModel({ sessionID, model });
  } else {
    sessionID = (
      await client.session.create({
        location: location(runtime),
        agent,
        model,
        title: `jbot-review ${spec.label}`,
        permissions: permissionRules(),
      })
    ).id;
  }
  await client.session.environment({ sessionID, variables: sessionEnvironment() });
  rememberLabel(client, sessionID, spec.label);
  registerSessionOptions(runtime, sessionID, spec.model, spec.tier ?? 'main');
  return sessionID;
}

const sessionOptionsByRuntime = new WeakMap<
  OpencodeRuntime,
  Record<string, Record<string, unknown>>
>();

/**
 * Publishes the session's provider options for the plugin's `context` hook,
 * which re-reads the file per request. The whole map is swapped in atomically.
 */
function registerSessionOptions(
  runtime: OpencodeRuntime,
  sessionID: string,
  model: string,
  tier: OptionTier,
): void {
  if (!runtime.sessionOptionsFile || !runtime.modelOptions) return;
  const options = sessionModelOptions(runtime.modelOptions, model, tier);
  if (!options) return;
  const map = sessionOptionsByRuntime.get(runtime) ?? {};
  map[sessionID] = options;
  sessionOptionsByRuntime.set(runtime, map);
  const tmp = `${runtime.sessionOptionsFile}.tmp`;
  writeFileSync(tmp, JSON.stringify(map));
  renameSync(tmp, runtime.sessionOptionsFile);
}

async function latestAssistant(
  client: OpenCodeClient,
  sessionID: string,
): Promise<AssistantMessage | undefined> {
  const page = await client.message.list(
    { sessionID, type: 'assistant', order: 'desc', limit: 1 },
    { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
  );
  return page.data?.[0] as unknown as AssistantMessage | undefined;
}

async function assistantsSince(
  client: OpenCodeClient,
  sessionID: string,
  previousID: string | undefined,
): Promise<AssistantMessage[]> {
  const page = await client.message.list(
    { sessionID, type: 'assistant', order: 'desc', limit: 50 },
    { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
  );
  const newer: AssistantMessage[] = [];
  for (const message of (page.data ?? []) as unknown as AssistantMessage[]) {
    if (message.id === previousID) break;
    newer.unshift(message);
  }
  return newer;
}

export function assistantText(message: AssistantMessage): string {
  return (message.content ?? [])
    .filter(
      (part): part is { type: 'text'; text: string } => part.type === 'text' && Boolean(part.text),
    )
    .map((part) => part.text)
    .join('\n\n')
    .trim();
}

/** V2 tool content → the shared tool telemetry (same rows the V1 parts produced). */
export function recordAssistantTools(
  telemetry: ToolTelemetryAccumulator,
  session: string,
  messages: AssistantMessage[],
): void {
  for (const message of messages) {
    for (const part of message.content ?? []) {
      if (
        part.type !== 'tool' ||
        (part.state.status !== 'completed' && part.state.status !== 'error')
      ) {
        continue;
      }
      const toolClass = classifyReadonlyTool(
        TOOL_CLASS_ALIASES[part.name] ?? part.name,
        part.state.input,
      );
      const identity = toolIdentity(toolClass, part.state.input);
      const finish = telemetry.startTool({
        session,
        backend: 'opencode',
        capability: OPENCODE_TELEMETRY_CAPABILITY,
        toolClass,
        inputBytes: serializedBytes(part.state.input),
        ...identity,
        ...(toolClass === 'diff-recovery'
          ? { diffScope: identity.identityKind === 'path' ? ('path' as const) : ('whole' as const) }
          : {}),
      });
      const output = part.state.status === 'completed' ? part.state.content : part.state.error;
      const outputBytes = serializedBytes(output);
      finish({
        success: part.state.status === 'completed',
        ...(part.state.status === 'error' ? { failureClass: 'execution' as const } : {}),
        outputBytesBeforeCap: outputBytes,
        outputBytesAfterCap: outputBytes,
        durationMs: Math.max((part.time.completed ?? part.time.created) - part.time.created, 0),
      });
    }
  }
  telemetry.finishSession({
    session,
    backend: 'opencode',
    capability: OPENCODE_TELEMETRY_CAPABILITY,
    budgetTier: 'observe-only',
    stopReason: 'completed',
    ...(messages.length > 0 ? { turnCount: messages.length } : {}),
  });
}

async function interruptBestEffort(
  client: OpenCodeClient,
  sessionID: string,
  label: string,
  log: (msg: string) => void,
): Promise<void> {
  try {
    await client.session.interrupt(
      { sessionID },
      { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
    );
    log(`Interrupted ${label} session ${sessionID}.`);
  } catch (error) {
    log(
      `(failed to interrupt ${label} session ${sessionID}: ${
        error instanceof Error ? error.message : String(error)
      })`,
    );
  }
}

/** The client wraps an aborted fetch as ClientError("Transport") with the DOMException in `cause`. */
function isAbort(error: unknown): boolean {
  const names = [
    (error as { name?: string })?.name,
    (error as { cause?: { name?: string } })?.cause?.name,
  ];
  return names.some((name) => name === 'TimeoutError' || name === 'AbortError');
}

/** Blocks in `session.wait` (in slices below the fetch header timeout) until the turn is idle or the deadline passes. */
async function waitForTurn(
  client: OpenCodeClient,
  sessionID: string,
  previousID: string | undefined,
  spec: PromptSpec,
  timeoutMs: number,
): Promise<AssistantMessage> {
  const deadline = Date.now() + timeoutMs;
  const slice = spec.waitSliceMs ?? WAIT_SLICE_MS;
  const timedOut = () =>
    new Error(
      `opencode ${spec.label} prompt did not finish within ${Math.round(timeoutMs / 1000)}s`,
    );
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw timedOut();
    try {
      await client.session.wait(
        { sessionID },
        { signal: AbortSignal.timeout(Math.min(slice, remaining)) },
      );
      break;
    } catch (error) {
      if (!isAbort(error)) throw error;
      if (remaining <= slice) throw timedOut();
      spec.log(
        `${spec.label} prompt still running (${Math.round((timeoutMs - remaining) / 1000)}s)`,
      );
    }
  }
  for (let attempt = 0; ; attempt++) {
    const message = await latestAssistant(client, sessionID);
    if (message && message.id !== previousID && message.time.completed) return message;
    if (attempt >= SETTLE_POLL_LIMIT) {
      throw new Error(
        `opencode ${spec.label} prompt settled without a completed assistant message`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
  }
}

async function exportTranscript(
  runtime: OpencodeRuntime,
  sessionID: string,
  label: string,
  log: (msg: string) => void,
): Promise<void> {
  if (!runtime.transcriptDir) return;
  try {
    const transcript = await runtime.client.session.export(
      { sessionID, sanitize: true },
      { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
    );
    let body = JSON.stringify(transcript, null, 2);
    if (body.length > TRANSCRIPT_CAP_BYTES) {
      body =
        body.slice(0, TRANSCRIPT_CAP_BYTES) + `\n/* truncated at ${TRANSCRIPT_CAP_BYTES} bytes */`;
    }
    mkdirSync(runtime.transcriptDir, { recursive: true });
    writeFileSync(join(runtime.transcriptDir, `${label}-${sessionID}.json`), body);
  } catch (error) {
    log(
      `(transcript export failed for ${label}: ${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

/** One prompt turn in an existing session: prompt → wait → newest assistant message; wrap-up on a cut-off. */
export async function promptInSession(
  runtime: OpencodeRuntime,
  sessionID: string,
  spec: PromptSpec,
): Promise<PromptResult> {
  const release = sessionSlots ? await sessionSlots.acquire() : undefined;
  try {
    return await promptHoldingSlot(runtime, sessionID, spec);
  } finally {
    release?.();
  }
}

async function promptHoldingSlot(
  runtime: OpencodeRuntime,
  sessionID: string,
  spec: PromptSpec,
): Promise<PromptResult> {
  const { client } = runtime;
  const { label, log } = spec;
  const abortLabel = spec.abortLabel ?? label;
  const timeoutMs = spec.timeoutMs ?? PROMPT_TIMEOUT_MS;
  registerOpencodeSessionForAbort(client, abortLabel, sessionID);
  let attempted = false;
  let usage: PromptTokenUsage | undefined;
  try {
    const previous = await latestAssistant(client, sessionID);
    log(`Calling ${label} prompt (${spec.model})`);
    attempted = true;
    // No caller-supplied message id: the earlier v2 attempt stalled with one (ROADMAP).
    await client.session.prompt(
      { sessionID, text: spec.text },
      { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
    );

    const reserve = spec.outcome ? (spec.wrapUpReserveMs ?? wrapUpReserveMs(timeoutMs)) : 0;
    let requestWrapUp: ((budgetMs: number) => void) | undefined;
    const wrapUpDue = new Promise<number>((resolve) => {
      requestWrapUp = resolve;
    });
    const unregister = spec.outcome
      ? registerFinalizeTrigger(client, abortLabel, requestWrapUp!)
      : () => undefined;
    const reserveTimer =
      reserve > 0 ? setTimeout(() => requestWrapUp!(reserve), timeoutMs - reserve) : undefined;
    let message: AssistantMessage;
    try {
      const settled = await Promise.race([
        waitForTurn(client, sessionID, previous?.id, spec, timeoutMs).then((m) => ({ message: m })),
        wrapUpDue.then((budgetMs) => ({ budgetMs })),
      ]);
      if ('budgetMs' in settled) {
        const wrapUpDeadline = Date.now() + settled.budgetMs - WRAP_UP_MARGIN_MS;
        log(
          `${label} prompt cut off; wrapping up in-session within ${Math.round(settled.budgetMs / 1000)}s`,
        );
        await interruptBestEffort(client, sessionID, label, log);
        const previousAgent = runtime.reviewerAgent ? REVIEWER_AGENT : MAIN_AGENT;
        await client.session.switchAgent({ sessionID, agent: WRAPUP_AGENT });
        try {
          const wrapped = await promptHoldingSlot(runtime, sessionID, {
            ...spec,
            text: WRAP_UP_PROMPT,
            label: `${label}-wrap-up`,
            timeoutMs: Math.max(0, wrapUpDeadline - Date.now()),
            abortLabel,
            outcome: undefined,
          });
          spec.outcome!.wrappedUp = true;
          return wrapped;
        } finally {
          await client.session
            .switchAgent({ sessionID, agent: previousAgent })
            .catch(() => undefined);
        }
      }
      message = settled.message;
    } catch (error) {
      // A timed-out or failed wait leaves the session generating; stop it now.
      await interruptBestEffort(client, sessionID, label, log);
      throw error;
    } finally {
      clearTimeout(reserveTimer);
      unregister();
    }

    if (message.error) {
      throw new Error(`opencode ${label} prompt failed: ${formatUnknown(message.error)}`);
    }
    const telemetry = toolTelemetry.get(client);
    if (telemetry) {
      recordAssistantTools(
        telemetry,
        label,
        await assistantsSince(client, sessionID, previous?.id),
      );
    }
    log(`${label} ${formatTokenUsage({ cost: message.cost, tokens: message.tokens })}`);
    usage = extractPromptTokenUsage({ cost: message.cost, tokens: message.tokens });
    const text = assistantText(message);
    if (!text) {
      log(
        `${label} response contained no text part (types: ${(message.content ?? []).map((p) => p.type).join(', ')})`,
      );
    }
    await exportTranscript(runtime, sessionID, label, log);
    return { text, message };
  } finally {
    unregisterOpencodeSessionForAbort(client, abortLabel, sessionID);
    if (attempted) {
      spec.onTokenUsage?.(
        { ...usage, promptBytes: Buffer.byteLength(spec.text, 'utf8') },
        spec.model,
        label,
      );
    }
  }
}

function formatUnknown(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  if (
    value &&
    typeof value === 'object' &&
    'message' in value &&
    typeof (value as { message: unknown }).message === 'string'
  ) {
    return (value as { message: string }).message;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Agent for a model: tool-less for single-shot models, the reviewer when opted in, plan otherwise. */
export function agentForModel(singleShot: boolean, reviewerAgent = false): string {
  if (singleShot) return PLAIN_AGENT;
  return reviewerAgent ? REVIEWER_AGENT : MAIN_AGENT;
}

/**
 * Grace-abandon abort registry (TASK-076): sessions register while a prompt
 * is in flight and leave on settle — aborting a finished session is a
 * server-side no-op, the set is cleared on the first abort, and the registry
 * dies with the client.
 */
const abortableSessionsByLabel = new WeakMap<object, Map<string, Set<string>>>();

export function registerOpencodeSessionForAbort(
  client: OpenCodeClient,
  label: string,
  sessionID: string,
): void {
  const byLabel = abortableSessionsByLabel.get(client) ?? new Map<string, Set<string>>();
  abortableSessionsByLabel.set(client, byLabel);
  const ids = byLabel.get(label) ?? new Set<string>();
  byLabel.set(label, ids);
  ids.add(sessionID);
}

const finalizeTriggersByLabel = new WeakMap<object, Map<string, Set<(budgetMs: number) => void>>>();

function registerFinalizeTrigger(
  client: OpenCodeClient,
  label: string,
  trigger: (budgetMs: number) => void,
): () => void {
  const byLabel = finalizeTriggersByLabel.get(client) ?? new Map<string, Set<typeof trigger>>();
  finalizeTriggersByLabel.set(client, byLabel);
  const triggers = byLabel.get(label) ?? new Set<typeof trigger>();
  byLabel.set(label, triggers);
  triggers.add(trigger);
  return () => triggers.delete(trigger);
}

/** Wraps up every in-flight prompt under label (the ReviewBackend.finalizeSessionsByLabel contract). */
export function finalizeOpencodeSessionsByLabel(
  client: OpenCodeClient,
  label: string,
  log: (msg: string) => void,
  budgetMs: number,
): number {
  const triggers = finalizeTriggersByLabel.get(client)?.get(label);
  if (!triggers || triggers.size === 0) return 0;
  const count = triggers.size;
  for (const trigger of triggers) trigger(budgetMs);
  triggers.clear();
  log(`Asked ${count} ${label} session(s) to wrap up within ${Math.round(budgetMs / 1000)}s.`);
  return count;
}

export function unregisterOpencodeSessionForAbort(
  client: OpenCodeClient,
  label: string,
  sessionID: string,
): void {
  abortableSessionsByLabel.get(client)?.get(label)?.delete(sessionID);
}

/**
 * Best-effort, fire-and-forget: used when the settle grace abandons a result.
 * Returns the signalled count (the ReviewBackend.abortSessionsByLabel contract).
 */
export function abortOpencodeSessionsByLabel(
  client: OpenCodeClient,
  label: string,
  log: (msg: string) => void,
): number {
  const ids = abortableSessionsByLabel.get(client)?.get(label);
  if (!ids || ids.size === 0) return 0;
  const count = ids.size;
  for (const sessionID of ids) void interruptBestEffort(client, sessionID, label, log);
  ids.clear();
  return count;
}

/**
 * Live progress from the global event stream: one line per tool call and per
 * failed execution, keyed by the session's label. Best effort — a broken
 * stream is logged once and never affects the review (invariant 3).
 */
/** V2's tool events carry the call input but no tool name; the first string argument identifies it. */
function describeToolCall(props: Record<string, unknown>): string {
  const input = props.input as Record<string, unknown> | undefined;
  const arg = input && Object.entries(input).find(([, value]) => typeof value === 'string');
  if (!arg) return '?';
  const value = String(arg[1]).replace(/\s+/g, ' ');
  return `${arg[0]}=${value.length > 120 ? `${value.slice(0, 120)}…` : value}`;
}

export function startProgressLogger(
  client: OpenCodeClient,
  log: (msg: string) => void,
): () => void {
  const controller = new AbortController();
  void (async () => {
    try {
      for await (const event of client.event.subscribe({ signal: controller.signal })) {
        // V2 events carry their payload under `data` (measured; V1 used `properties`).
        const raw = event as { type?: string; data?: Record<string, unknown>; sessionID?: string };
        const props = (raw.data ?? raw) as Record<string, unknown>;
        const sessionID = (props.sessionID ?? raw.sessionID) as string | undefined;
        const label = sessionID ? labelsByClient.get(client)?.get(sessionID) : undefined;
        if (!label) continue;
        if (raw.type === 'session.tool.called') {
          log(`${label} tool: ${describeToolCall(props)}`);
        } else if (raw.type === 'session.execution.failed') {
          log(
            `${label} execution failed: ${formatUnknown(props.error ?? props.message ?? 'unknown')}`,
          );
        } else if (raw.type === 'permission.asked') {
          log(
            `${label} permission asked (denied by the jbot plugin): ${formatUnknown(props.action ?? props)}`,
          );
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        log(`(progress stream ended: ${error instanceof Error ? error.message : String(error)})`);
      }
    }
  })();
  return () => controller.abort();
}
