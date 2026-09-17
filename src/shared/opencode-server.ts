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
const MODELS_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 10_000;
const KILL_GRACE_MS = 5_000;

/**
 * Env vars withheld from the opencode server — and therefore from every
 * session's bash children, which inherit its environment. The Action maps ALL
 * inputs to INPUT_* (the write-scoped GitHub token plus every provider key),
 * and app/local modes hold credential-suffixed vars; sessions need none of
 * them, since provider auth travels inside the opencode config. With these
 * gone, "prompt injection runs `env`" stops yielding tokens that act OUTSIDE
 * the container (post as the bot, spend provider credits) — the exfil surface
 * the bash accident-filter above explicitly does not close.
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

/** Env override, then the pinned devDependency binary, then whatever `opencode` is on PATH (the image). */
/**
 * The pinned launcher when @opencode/cli is installed beside this package
 * (dev, tests, the benchmark harness — whatever the cwd; a cwd-relative
 * lookup once picked a global V1 binary), else `opencode` on PATH, which the
 * image installs globally. JBOT_OPENCODE_BIN overrides both.
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

/**
 * The server's env, composed on the child only (never by mutating
 * process.env): inherited env minus credentials, plus proxy vars, the run's
 * provider keys, the hermetic config/data homes and the inline config.
 */
export function childEnv(input: ChildEnvInput): Record<string, string> {
  const denied = new Set(input.scrub ? sessionEnvDenyKeys(Object.keys(input.base)) : []);
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.base)) {
    if (value !== undefined && !denied.has(name)) env[name] = value;
  }
  for (const [name, value] of Object.entries(input.proxyEnv ?? {})) {
    if (value !== undefined) env[name] = value;
  }
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
  close(): void;
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
  const close = () => {
    stopping = true;
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
      output += chunk.toString();
      if (settled) return;
      const banner = parseServerBanner(output);
      if (!banner) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...banner, close });
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
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
  while (Date.now() < deadline) {
    const listed = new Set(
      ((await client.model.list({ location: { directory: workspace } })).data ?? []).map(
        (m) => `${m.providerID}/${m.id}`,
      ),
    );
    missing = models.filter((model) => !listed.has(model));
    if (missing.length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `opencode server never listed ${missing.join(', ')}; check the provider key env var and config entry.`,
  );
}

export interface OpencodeRuntime {
  client: OpenCodeClient;
  workspace: string;
  /** Provider options per model and tier; sessions register theirs in sessionOptionsFile. */
  modelOptions?: ModelOptionsByModel;
  sessionOptionsFile?: string;
  /** Directory for `session.export` transcripts; unset = no export. */
  transcriptDir?: string;
  /** JBOT_VERIFY_FORK: verification forks the single main review session. */
  verifyFork?: boolean;
  /** JBOT_REVIEWER_AGENT: review turns use jbot-reviewer instead of plan. */
  reviewerAgent?: boolean;
  stop(): void;
}

export interface StartOpencodeOptions {
  modelOptions?: Record<string, unknown>;
  verificationModelOptions?: Record<string, unknown>;
  port?: number;
  promptCache?: boolean;
  baseURL?: string;
  additionalProviderKeys?: Array<
    Omit<ModelEntry, 'promptCache' | 'modelID'> & { modelID?: string; promptCache?: boolean }
  >;
  proxyEnv?: NodeJS.ProcessEnv;
  scrubEnv?: boolean;
  transcriptDir?: string;
  verifyFork?: boolean;
  reviewerAgent?: boolean;
  /** JBOT_RUN_STATS: log session.stats at stop. */
  runStats?: boolean;
}

/** Boots one V2 server for this run and returns an authenticated client. */
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
    ...(options.additionalProviderKeys ?? [])
      .filter((entry) => entry.providerID)
      .map((entry) => ({
        ...entry,
        modelID: entry.modelID ?? '',
        promptCache: entry.promptCache ?? promptCache,
      })),
  ];
  const config = buildConfig({ models, reviewerSystem: REVIEWER_SYSTEM_PROMPT });
  const dataHome = mkdtempSync(join(tmpdir(), 'jbot-opencode-data-'));
  const sessionOptionsFile = join(dataHome, 'jbot-session-options.json');
  let server: SpawnedServer | undefined;
  const stopServer = () => {
    server?.close();
    rmSync(dataHome, { recursive: true, force: true });
  };
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
    const port = options.port ?? parsePortEnv('JBOT_OPENCODE_PORT', 4096);
    server = await spawnServer(resolveOpencodeBin(), port, env, log);
    client = OpenCode.make({
      baseUrl: server.url,
      headers: { authorization: basicAuthHeader(server.password) },
    });
    await waitForModels(
      client,
      workspace,
      models.filter((m) => m.modelID).map((m) => `${m.providerID}/${m.modelID}`),
    );
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
      .stats(undefined, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
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
