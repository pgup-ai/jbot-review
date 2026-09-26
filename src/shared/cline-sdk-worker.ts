// Child process for the opt-in Cline SDK verifier (JBOT_CLINE_SDK_VERIFIER). It runs the
// SDK's bare Agent, never ClineCore, which runs a checkout's .cline hooks and loads its
// .clinerules; its only tools are the three below, which read tracked files in the checkout.
import { execFile } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import type { AgentTool } from '@cline/sdk';
import { resolveWithinWorkspace } from './pi.ts';
import { CLINE_SDK_VERIFIER_SYSTEM_PROMPT, truncateUtf8WithNotice } from './prompt.ts';

const MAX_TOOL_OUTPUT_BYTES = 32 * 1024;
const MAX_ITERATIONS = 20;

/** Inside the checkout and outside `.git`, whose config can include a persisted job token. */
export function readablePath(workspace: string, path: string): string | undefined {
  const root = resolveWithinWorkspace(workspace, '.');
  const target = root && resolveWithinWorkspace(root, path);
  if (!root || !target) return undefined;
  const inside = relative(root, target);
  return inside === '.git' || inside.startsWith(`.git${sep}`) ? undefined : target;
}

// The notice fits inside the cap.
const cap = (text: string) => truncateUtf8WithNotice(text, MAX_TOOL_OUTPUT_BYTES - 128, 'Output');

// Repo config can name programs (fsmonitor, hooks); none may run while the tools read.
// The Action trusts its checkout (another uid's) only in the global config HOME hides.
async function git(root: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await promisify(execFile)(
      'git',
      [
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        `safe.directory=${root}`,
        ...args,
      ],
      {
        cwd: root,
        env: { PATH: process.env.PATH ?? '', GIT_CONFIG_NOSYSTEM: '1', HOME: '/nonexistent' },
        maxBuffer: 4 * MAX_TOOL_OUTPUT_BYTES,
        timeout: 20_000,
      },
    );
    return stdout;
  } catch (error) {
    // Output past the buffer is capped anyway: keep what arrived.
    if ((error as { code?: string }).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
      return String((error as { stdout?: string }).stdout ?? '');
    throw error;
  }
}

export function readOnlyTools(workspace: string, calls: { denied: boolean }[]): AgentTool[] {
  const root = resolveWithinWorkspace(workspace, '.') ?? workspace;
  // Files must also be tracked: untracked ones can be runner credentials (e.g. gha-creds-*.json).
  const allow = async (path: unknown, file = false) => {
    let target = readablePath(workspace, String(path ?? '') || '.');
    if (target && file)
      await git(root, [
        '--literal-pathspecs',
        'ls-files',
        '--error-unmatch',
        '--',
        relative(root, target),
      ]).catch(() => (target = undefined));
    calls.push({ denied: !target });
    return target;
  };
  const denied = 'Denied: the path is missing, untracked, outside the repository, or inside .git.';
  return [
    {
      name: 'read_file',
      description:
        'Read a text file in the repository under review. `path` is relative to the repository root; start_line/end_line select a range. Returns numbered lines.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          start_line: { type: 'integer' },
          end_line: { type: 'integer' },
        },
        required: ['path'],
      },
      async execute(input: unknown) {
        const { path, start_line, end_line } = input as Record<string, unknown>;
        const target = await allow(path, true);
        if (!target) return denied;
        try {
          if (!statSync(target).isFile()) return denied;
          const lines = readFileSync(target, 'utf8').split('\n');
          const start = Math.max(1, Number(start_line) || 1);
          const end = Math.min(lines.length, Number(end_line) || start + 399);
          return cap(
            lines
              .slice(start - 1, end)
              .map((line, i) => `${start + i}: ${line}`)
              .join('\n'),
          );
        } catch (error) {
          return `read_file failed: ${(error as Error).message.slice(0, 200)}`;
        }
      },
    },
    {
      name: 'grep',
      description:
        'Search tracked files with `git grep -n -I -E`. `pattern` is an extended regex; optional `path` limits it to a file or directory relative to the repository root.',
      inputSchema: {
        type: 'object',
        properties: { pattern: { type: 'string' }, path: { type: 'string' } },
        required: ['pattern'],
      },
      async execute(input: unknown) {
        const { pattern, path } = input as Record<string, unknown>;
        const target = await allow(path);
        if (!target) return denied;
        const args = ['grep', '-n', '-I', '-E', '--max-count=50', '-e', String(pattern)];
        try {
          return cap(
            (await git(root, [...args, '--', relative(root, target) || '.'])) || '(no matches)',
          );
        } catch (error) {
          return (error as { code?: number }).code === 1
            ? '(no matches)'
            : `grep failed: ${(error as Error).message.slice(0, 200)}`;
        }
      },
    },
    {
      name: 'list_files',
      description:
        'List tracked files under an optional directory relative to the repository root.',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      async execute(input: unknown) {
        const target = await allow((input as Record<string, unknown>).path);
        if (!target) return denied;
        try {
          return cap(await git(root, ['ls-files', '--', relative(root, target) || '.']));
        } catch (error) {
          return `list_files failed: ${(error as Error).message.slice(0, 200)}`;
        }
      },
    },
  ];
}

/** stdin: { providerId, modelId, prompt, workspace, timeoutMs }; stdout: { text, toolCalls, denied }. */
async function main(): Promise<string> {
  const job = JSON.parse(readFileSync(0, 'utf8')) as {
    providerId: string;
    modelId: string;
    prompt: string;
    workspace: string;
    timeoutMs: number;
  };
  // Loaded only in the worker, under its temp HOME: importing the tools never loads the SDK.
  const { Agent, buildClineClientHeaders, createTool, getValidClineCredentials } =
    await import('@cline/sdk');
  // The parent's temp HOME holds a copy of CLINE_AUTH_JSON, as for the CLI.
  const providers = JSON.parse(
    readFileSync(join(homedir(), '.cline', 'data', 'settings', 'providers.json'), 'utf8'),
  );
  const auth = providers.providers?.[job.providerId]?.settings?.auth;
  if (!auth?.refreshToken) throw new Error(`No ${job.providerId} OAuth login in CLINE_AUTH_JSON.`);
  const credentials = await getValidClineCredentials(
    {
      access: String(auth.accessToken ?? '').replace(/^workos:/i, ''),
      refresh: auth.refreshToken,
      expires: auth.expiresAt,
      accountId: auth.accountId,
    },
    { apiBaseUrl: 'https://api.cline.bot' },
  );
  if (!credentials) throw new Error('Cline rejected the refresh token; run `cline auth` again.');
  const calls: { denied: boolean }[] = [];
  const agent = new Agent({
    providerId: job.providerId,
    modelId: job.modelId,
    apiKey: `workos:${credentials.access}`,
    // The SDK's own identity; free models answer only to Cline clients.
    headers: buildClineClientHeaders(),
    systemPrompt: CLINE_SDK_VERIFIER_SYSTEM_PROMPT,
    tools: readOnlyTools(job.workspace, calls).map((tool) => createTool(tool)),
    maxIterations: MAX_ITERATIONS,
  });
  const timer = setTimeout(() => agent.abort(new Error('timed out')), job.timeoutMs);
  const result = await agent.run(job.prompt).finally(() => clearTimeout(timer));
  if (result.status !== 'completed') throw result.error ?? new Error(`run ${result.status}`);
  const denied = calls.filter((call) => call.denied).length;
  return JSON.stringify({ text: result.outputText, toolCalls: calls.length, denied });
}

// Exit once the output is flushed: the SDK's keep-alive sockets would hold the process open.
// The parent reads a 403 in the error text as Cline refusing the SDK route.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then(
    (output) => process.stdout.write(output, () => process.exit(0)),
    (error: unknown) => process.stderr.write(String(error).slice(0, 1000), () => process.exit(1)),
  );
}
