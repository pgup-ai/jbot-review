import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { OpenCode, type OpenCodeClient } from '@opencode/client';
import {
  buildConfig,
  modelOptionsByModel,
  providerKeyVariables,
  type ModelEntry,
  type ModelOptionsByModel,
} from './opencode-config.ts';
import { hermeticOpencodeConfigHome } from './opencode-plugin.ts';
import { startProgressLogger } from './opencode-session.ts';
import { REVIEWER_SYSTEM_PROMPT } from './prompt.ts';

const READY_TIMEOUT_MS = 15_000;
/** Bounds how long a stopping server keeps its port for the optional stats line. */
const STATS_TIMEOUT_MS = 5_000;
const MODELS_TIMEOUT_MS = 15_000;
const KILL_GRACE_MS = 5_000;

/**
 * Withheld from the server and thus from every session's bash child. The
 * Action maps ALL inputs to INPUT_* (write-scoped GitHub token, every provider
 * key) and app/local modes hold credential-suffixed vars; sessions need none
 * (provider auth rides the config), so "prompt injection runs `env`" yields
 * nothing that acts outside the container.
 */
export function sessionEnvDenyKeys(keys: string[]): string[] {
  // Match the trailing WORD, not a fixed suffix list: `STRIPE_SECRET_KEY` ends
  // in KEY (not SECRET), and a bare `API_KEY`/`TOKEN` has no leading segment.
  // `(^|_)` also covers GITHUB_TOKEN/GH_TOKEN without naming them.
  const CREDENTIAL_NAME =
    /(^|_)(KEY|KEY_ID|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS|AUTH_BUNDLE|AUTH_CONTENT|AUTH_JSON|DSN)$/;
  return keys.filter((key) => {
    const upper = key.toUpperCase();
    return upper.startsWith('INPUT_') || CREDENTIAL_NAME.test(upper);
  });
}

export async function withCredentialEnvWithheld<T>(
  run: () => Promise<T>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<T> {
  const withheld = new Map<string, string>();
  for (const key of sessionEnvDenyKeys(Object.keys(env))) {
    const value = env[key];
    if (value !== undefined) withheld.set(key, value);
    delete env[key];
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of withheld) env[key] = value;
  }
}

export function takeOpencodeProxyEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const proxy = env.JBOT_OPENCODE_HTTPS_PROXY?.trim();
  const noProxy = env.JBOT_OPENCODE_NO_PROXY?.trim();
  delete env.JBOT_OPENCODE_HTTPS_PROXY;
  delete env.JBOT_OPENCODE_NO_PROXY;
  if (!proxy) return {};
  return {
    HTTPS_PROXY: proxy,
    NO_PROXY: noProxy || 'localhost,127.0.0.1',
  };
}

export function parsePortEnv(name: string, defaultValue: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return defaultValue;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 && value <= 65535 ? value : defaultValue;
}

/**
 * JBOT_OPENCODE_BIN, else the launcher of the @opencode/cli installed beside
 * this package (resolved by package, not cwd — a cwd lookup once picked a
 * global V1 binary), else `opencode` on PATH (the image).
 */
export function resolveOpencodeBin(
  env: NodeJS.ProcessEnv = process.env,
  resolvePackage: () => string = () =>
    createRequire(import.meta.url).resolve('@opencode/cli/package.json'),
): string {
  const override = env.JBOT_OPENCODE_BIN?.trim();
  if (override) return override;
  try {
    return join(dirname(resolvePackage()), 'bin', 'opencode.exe');
  } catch {
    return 'opencode';
  }
}

export interface ServerBanner {
  url: string;
  password: string;
}

/** The two lines `opencode serve` prints once it is up; the password is per process. */
export function parseServerBanner(output: string): ServerBanner | undefined {
  const url = /server listening on (https?:\/\/\S+)/.exec(output)?.[1];
  const password = /server password (\S+)/.exec(output)?.[1];
  return url && password ? { url, password } : undefined;
}

export function basicAuthHeader(password: string): string {
  return `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
}

export interface ChildEnvInput {
  base: NodeJS.ProcessEnv;
  scrub: boolean;
  keys: Record<string, string>;
  config: unknown;
  configHome: string;
  dataHome: string;
  /** JSON map sessionID → provider options, read by the jbot plugin per request. */
  sessionOptionsFile: string;
  proxyEnv?: NodeJS.ProcessEnv;
}

export function childEnv(input: ChildEnvInput): Record<string, string> {
  const denied = new Set(input.scrub ? sessionEnvDenyKeys(Object.keys(input.base)) : []);
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.base)) {
    if (value !== undefined && !denied.has(name)) env[name] = value;
  }
  for (const [name, value] of Object.entries(input.proxyEnv ?? {})) {
    if (value !== undefined) env[name] = value;
  }
  // An operator's own config pointers would re-enter the hermetic child.
  delete env.OPENCODE_CONFIG;
  delete env.OPENCODE_CONFIG_DIR;
  Object.assign(env, input.keys, {
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    XDG_CONFIG_HOME: input.configHome,
    XDG_DATA_HOME: input.dataHome,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(input.config),
    JBOT_OPENCODE_SESSION_OPTIONS: input.sessionOptionsFile,
  });
  return env;
}

interface SpawnedServer extends ServerBanner {
  /** SIGTERM, then SIGKILL after the grace; `onExit` runs once the process is gone. */
  close(onExit?: () => void): void;
}

function spawnServer(
  bin: string,
  port: number,
  env: Record<string, string>,
  log: (msg: string) => void,
): Promise<SpawnedServer> {
  const child = spawn(bin, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stopping = false;
  const close = (onExit?: () => void) => {
    stopping = true;
    if (onExit) child.once('exit', onExit);
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS).unref();
  };
  return new Promise<SpawnedServer>((resolve, reject) => {
    let output = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      close();
      reject(
        new Error(
          `Timeout waiting for opencode server to start after ${READY_TIMEOUT_MS}ms\n${output}`,
        ),
      );
    }, READY_TIMEOUT_MS);
    const onData = (chunk: Buffer) => {
      if (settled) return;
      output += chunk.toString();
      const banner = parseServerBanner(output);
      if (!banner) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...banner, close });
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      if (!stopping) log(`opencode server exited with code ${code}`);
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`opencode server exited with code ${code}\n${output}`));
    });
  });
}

/**
 * V2 skips a malformed provider entry with only a log line, so readiness
 * means "every model this run needs is listed", not "the port answers".
 */
export async function waitForModels(
  client: OpenCodeClient,
  workspace: string,
  models: string[],
  timeoutMs = MODELS_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let missing = models;
  let failure: unknown;
  while (Date.now() < deadline) {
    try {
      const page = await client.model.list(
        { location: { directory: workspace } },
        { signal: AbortSignal.timeout(Math.max(1_000, deadline - Date.now())) },
      );
      const listed = new Set((page.data ?? []).map((m) => `${m.providerID}/${m.id}`));
      missing = models.filter((model) => !listed.has(model));
      if (missing.length === 0) return;
    } catch (error) {
      failure = error; // a server still booting answers with errors first
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `opencode server never listed ${missing.join(', ')}; check the provider key env var and config entry.` +
      (failure
        ? ` Last error: ${failure instanceof Error ? failure.message : String(failure)}`
        : ''),
  );
}

/** The jbot plugin is the layer that keeps tool-less turns tool-less; a boot without it is not a review server. */
export async function waitForPlugin(
  client: OpenCodeClient,
  workspace: string,
  timeoutMs = MODELS_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  type Listed = { source?: { path?: string }; state?: { status?: string } };
  while (Date.now() < deadline) {
    const listed = (await client.plugin.list(
      { location: { directory: workspace } },
      { signal: AbortSignal.timeout(Math.max(1_000, deadline - Date.now())) },
    )) as unknown;
    const plugins = (
      Array.isArray(listed) ? listed : ((listed as { data?: Listed[] }).data ?? [])
    ) as Listed[];
    const jbot = plugins.find((entry) =>
      String(entry.source?.path ?? '').endsWith('opencode/plugins/jbot-review.js'),
    );
    if (jbot?.state?.status === 'active') return;
    if (jbot?.state?.status === 'failed') break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('opencode server did not load the jbot plugin from its hermetic config home.');
}

export interface OpencodeRuntime {
  client: OpenCodeClient;
  workspace: string;
  modelOptions: ModelOptionsByModel;
  sessionOptionsFile: string;
  transcriptDir?: string;
  /** JBOT_VERIFY_FORK: verification forks the single main review session. */
  verifyFork?: boolean;
  reviewerAgent?: boolean;
  stop(): void;
}

export interface StartOpencodeOptions {
  modelOptions?: Record<string, unknown>;
  verificationModelOptions?: Record<string, unknown>;
  port?: number;
  promptCache?: boolean;
  baseURL?: string;
  additionalProviderKeys?: ModelEntry[];
  proxyEnv?: NodeJS.ProcessEnv;
  scrubEnv?: boolean;
  transcriptDir?: string;
  verifyFork?: boolean;
  reviewerAgent?: boolean;
  runStats?: boolean;
}

export async function startOpencode(
  workspace: string,
  providerID: string,
  modelID: string,
  apiKey: string,
  log: (msg: string) => void,
  options: StartOpencodeOptions = {},
): Promise<OpencodeRuntime> {
  const promptCache = options.promptCache ?? true;
  const models: ModelEntry[] = [
    {
      providerID,
      modelID,
      apiKey,
      baseURL: options.baseURL,
      promptCache,
      modelOptions: options.modelOptions,
      verificationModelOptions: options.verificationModelOptions,
    },
    ...(options.additionalProviderKeys ?? []),
  ];
  const config = buildConfig({ models, reviewerSystem: REVIEWER_SYSTEM_PROMPT });
  const dataHome = mkdtempSync(join(tmpdir(), 'jbot-opencode-data-'));
  const sessionOptionsFile = join(dataHome, 'jbot-session-options.json');
  let server: SpawnedServer | undefined;
  // Removed once the child has exited: a stopping server still writes there.
  const removeDataHome = () => {
    try {
      rmSync(dataHome, { recursive: true, force: true });
    } catch (error) {
      log(
        `opencode data home not removed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  const stopServer = () => (server ? server.close(removeDataHome) : removeDataHome());
  let client: OpenCodeClient;
  try {
    writeFileSync(sessionOptionsFile, '{}');
    const env = childEnv({
      base: process.env,
      scrub: options.scrubEnv !== false,
      keys: providerKeyVariables(models),
      config,
      configHome: hermeticOpencodeConfigHome(),
      dataHome,
      sessionOptionsFile,
      proxyEnv: options.proxyEnv,
    });
    // 0: the OS picks a free port and the banner reports it.
    const port = options.port ?? parsePortEnv('JBOT_OPENCODE_PORT', 0);
    server = await spawnServer(resolveOpencodeBin(), port, env, log);
    client = OpenCode.make({
      baseUrl: server.url,
      headers: { authorization: basicAuthHeader(server.password) },
    });
    await waitForModels(
      client,
      workspace,
      models.map((m) => `${m.providerID}/${m.modelID}`),
    );
    await waitForPlugin(client, workspace);
  } catch (error) {
    stopServer();
    throw error;
  }
  log(`opencode server listening at ${server.url} (provider=${providerID} model=${modelID})`);
  const stopProgress = startProgressLogger(client, log);
  // Stats are fire-and-forget before the kill: stop() stays synchronous for the runner.
  const stop = () => {
    stopProgress();
    if (!options.runStats) return stopServer();
    void client.session
      .stats(undefined, { signal: AbortSignal.timeout(STATS_TIMEOUT_MS) })
      .then((s) =>
        log(
          `opencode run stats: prompts=${s.prompts} steps=${s.steps} tokens=${JSON.stringify(s.tokens)} cost=${s.cost}`,
        ),
      )
      .catch(() => undefined)
      .finally(stopServer);
  };
  return {
    client,
    workspace,
    modelOptions: modelOptionsByModel(models),
    sessionOptionsFile,
    transcriptDir: options.transcriptDir,
    verifyFork: options.verifyFork,
    reviewerAgent: options.reviewerAgent,
    stop,
  };
}
