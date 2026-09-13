import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

import {
  buildDevinReadOnlyConfig,
  DEVIN_CLI_BIN,
  DEVIN_PROVIDER_ID,
  devinCredentialsPath,
  parseModelName,
  truncateForLog,
} from '@symma/protocol';

import {
  CONTINUATION_NUDGE_PROMPT,
  isNoAttemptReply,
  assembleAddressedPriorCommentsPrompt,
  assembleChangesSinceLastReviewPrompt,
  assembleFindingVerificationPrompt,
  assembleGuidelineCompliancePrompt,
  assembleReviewPrompt,
  buildJsonRepairPrompt,
} from './prompt.ts';
import {
  parseChangesSinceLastReviewSummary,
  parseFindingVerdicts,
  parseReview,
  sessionEnvDenyKeys,
} from './opencode.ts';
import { createCliProcessScope, onCliFatalSignal, runCliProcess } from './cli-process.ts';
import type { ReviewBackend } from './session-concurrency.ts';

const DEVIN_CLI_TELEMETRY_CAPABILITY = 'opaque' as const;

const DEVIN_PROMPT_TIMEOUT_MS = 20 * 60_000;
const DEVIN_CLI_LOG_TAIL_LINES = 12;
const DEVIN_STOP_HOOK_TIMEOUT_S = 10;

const deadline = (timeoutMs = DEVIN_PROMPT_TIMEOUT_MS) => Date.now() + timeoutMs;

/** The CLI and its ACP child each log under the session root. */
function devinCliLogTail(root: string): string {
  const dir = join(dirname(devinCredentialsPath(root)), 'cli', 'logs');
  let lines: string[];
  try {
    lines = readdirSync(dir)
      .filter((name) => name.endsWith('.log'))
      .sort()
      .flatMap((name) => readFileSync(join(dir, name), 'utf8').split(/\r?\n/));
  } catch {
    return '';
  }
  const notable = lines.filter((line) => / (WARN|ERROR) /.test(line));
  return truncateForLog(
    (notable.length ? notable : lines.filter(Boolean)).slice(-DEVIN_CLI_LOG_TAIL_LINES).join('\n'),
    2000,
  );
}

function removeDevinSession(dir: string, log: (msg: string) => void): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (error) {
    log(`Could not remove isolated Devin session: ${String(error)}`);
  }
}

export function buildDevinCliArgs(
  model: string,
  promptFile: string,
  configFile: string,
  continueSession = false,
): string[] {
  const { modelID } = parseModelName(model);
  const args = [
    '--respect-workspace-trust',
    'false',
    '--permission-mode',
    'dangerous',
    '--config',
    configFile,
    '--prompt-file',
    promptFile,
  ];
  if (modelID !== 'default') args.push('--model', modelID);
  // Sessions persist under the launch HOME, so -c resumes this session's own turn.
  if (continueSession) args.push('-c');
  args.push('-p');
  return args;
}

const shellQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

/**
 * Stop hook: block an abandoned turn's first stop so the model continues
 * in-session instead of the driver relaunching with the whole prompt. The CLI
 * sets `stop_hook_active` on its retry, so a second announcement is final. The
 * marker tells the driver the nudge happened; the classifier is embedded by
 * source so the abandoned-turn rule stays defined once.
 */
export function buildDevinStopHookScript(nudgedMarker: string): string {
  return `import { writeFileSync } from 'node:fs';
const isNoAttemptReply = ${isNoAttemptReply.toString()};
let raw = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) raw += chunk;
try {
  const stop = JSON.parse(raw);
  if (
    !stop.stop_hook_active &&
    typeof stop.last_assistant_message === 'string' &&
    isNoAttemptReply(stop.last_assistant_message)
  ) {
    writeFileSync(${JSON.stringify(nudgedMarker)}, '');
    process.stdout.write(
      JSON.stringify({ decision: 'block', reason: ${JSON.stringify(CONTINUATION_NUDGE_PROMPT)} }),
    );
  }
} catch {}
`;
}

export function buildDevinCliConfig(home: string, stopHookScript: string) {
  const config = buildDevinReadOnlyConfig();
  return {
    ...config,
    permissions: {
      ...config.permissions,
      deny: [...config.permissions.deny, `Read(${home}/**)`],
    },
    hooks: {
      Stop: [
        {
          hooks: [
            {
              type: 'command',
              // Devin runs hook commands through a shell (measured), so quote both.
              command: `${shellQuote(process.execPath)} ${shellQuote(stopHookScript)}`,
              timeout: DEVIN_STOP_HOOK_TIMEOUT_S,
            },
          ],
        },
      ],
    },
    read_config_from: {
      agents_standard: false,
      cursor: false,
      windsurf: false,
      claude: false,
      opencode: false,
      vscode: false,
      zed: false,
    },
    auto_update: false,
    // Without this, each run's fresh home wastes a CLI launch on first-run onboarding.
    shell: { setup_complete: true },
  };
}

export function parseDevinCliOutput(output: string): { response: string; setupOnly: boolean } {
  const text = stripVTControlCharacters(output);
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== 'Welcome to Devin CLI!') {
    return { response: text, setupOnly: false };
  }
  const marker = lines.findIndex((line) => line.startsWith("You're all set. Run "));
  if (marker < 0) return { response: text, setupOnly: false };
  const response = lines
    .slice(marker + 1)
    .join('\n')
    .trimStart();
  return { response, setupOnly: !response };
}

/** One CLI session: the first prompt launches it, later prompts continue it. */
function openDevinSession(
  workspace: string,
  home: string,
  model: string,
  log: (msg: string) => void,
) {
  const root = mkdtempSync(join(home, 'session-'));
  const promptFile = join(root, 'prompt.txt');
  const configFile = join(root, 'config.json');
  const stopHook = join(root, 'stop-hook.mjs');
  const nudgedMarker = join(root, 'nudged');
  try {
    const credentials = devinCredentialsPath(root);
    mkdirSync(dirname(credentials), { recursive: true, mode: 0o700 });
    writeFileSync(credentials, readFileSync(devinCredentialsPath(home)), { mode: 0o600 });
    writeFileSync(stopHook, buildDevinStopHookScript(nudgedMarker), { mode: 0o600 });
    writeFileSync(configFile, JSON.stringify(buildDevinCliConfig(home, stopHook)), {
      mode: 0o600,
    });
    // The Action's safe.directory entry lives under the process HOME; git run
    // from this HOME refuses a checkout owned by another uid without its own.
    // Double-quoted: `#`, `;` and whitespace are literal only inside quotes.
    const directory = `"${workspace.replace(/[\\"]/g, '\\$&').replace(/\n/g, '\\n')}"`;
    writeFileSync(join(root, '.gitconfig'), `[safe]\n\tdirectory = ${directory}\n`, {
      mode: 0o600,
    });
  } catch (error) {
    // No session handle exists yet, so nothing else would reclaim the credential copy.
    removeDevinSession(root, log);
    throw error;
  }
  let launched = false;
  return {
    async prompt(prompt: string, label: string, timeoutMs = DEVIN_PROMPT_TIMEOUT_MS) {
      const deadlineAt = Date.now() + timeoutMs;
      writeFileSync(promptFile, prompt, { mode: 0o600 });
      log(`Calling ${label} prompt (agent=devin-cli, model=${model})`);
      let retriedSetup = false;
      let retriedCatalog = false;
      let retriedEmpty = false;
      for (;;) {
        // Per attempt: a relaunch must not inherit a nudge from the attempt it replaces.
        rmSync(nudgedMarker, { force: true });
        const remainingMs = deadlineAt - Date.now();
        if (remainingMs <= 0) throw new Error(`devin ${label} prompt deadline expired`);
        const result = await runCliProcess(
          DEVIN_CLI_BIN,
          buildDevinCliArgs(model, promptFile, configFile, launched),
          {
            cwd: workspace,
            env: { ...devinEnvForHome(root), GIT_OPTIONAL_LOCKS: '0' },
            timeoutMs: remainingMs,
            timeoutMessage: `devin ${label} prompt timed out after ${Math.round(timeoutMs / 1000)}s`,
          },
        );
        const output = parseDevinCliOutput(result.stdout);
        if (output.setupOnly) {
          if (!retriedSetup) {
            retriedSetup = true;
            log(`${label} devin first-run setup completed; retrying prompt once.`);
            continue;
          }
          throw new Error(`devin ${label} returned setup output instead of a prompt response.`);
        }
        if (result.exitCode !== 0) {
          const errorOutput = stripVTControlCharacters(result.stderr || result.stdout);
          const emptyCatalog =
            /Unknown model: '[^'\r\n]+'\r?\nAvailable:\s*$/.test(errorOutput) ||
            /session\/set_config_option \(model\) failed: Resource not found:\s*\{\s*"uri":\s*"Model not found: [^"\r\n]+\. Available models:\s*"\s*\}\s*$/.test(
              errorOutput,
            );
          if (!retriedCatalog && emptyCatalog) {
            retriedCatalog = true;
            log(`${label} devin returned an empty model catalog; retrying startup once.`);
            continue;
          }
          // Truncate the CLI's own output apart from the tail so long output can't hide it.
          throw new Error(
            `devin ${label} exited ${result.exitCode}: ${
              result.stderr
                ? truncateForLog(result.stderr, 1000)
                : [truncateForLog(result.stdout, 1000), devinCliLogTail(root)]
                    .filter(Boolean)
                    .join('\n')
            }`,
          );
        }
        log(
          `${label} prompt complete via devin: stdout=${result.stdout.length} chars stderr=${result.stderr.length} chars`,
        );
        // Nothing on stdout is a CLI-level failure, not an announced-then-stopped
        // turn: relaunch the same prompt once instead of sending a continuation.
        if (!output.response.trim()) {
          const detail = [
            result.stderr && `stderr: ${truncateForLog(result.stderr, 1000)}`,
            devinCliLogTail(root),
          ]
            .filter(Boolean)
            .join('\n');
          const suffix = detail && `\n${detail}`;
          if (!retriedEmpty) {
            retriedEmpty = true;
            log(`${label} devin exited 0 with no output; retrying once.${suffix}`);
            continue;
          }
          throw new Error(`devin ${label} exited 0 with no output${suffix}`);
        }
        launched = true;
        if (existsSync(nudgedMarker))
          log(`${label} Stop hook continued an announced-then-stopped turn in-session`);
        return output.response;
      }
    },
    nudged: () => existsSync(nudgedMarker),
    close: () => removeDevinSession(root, log),
  };
}

/**
 * One prompt with two one-shot recoveries, shared by the main and auxiliary
 * sessions: an in-session continuation for an abandoned turn (the Stop hook's
 * when it ran, the driver's otherwise), and one JSON repair for a malformed one.
 */
async function promptWithRecovery<T>(
  workspace: string,
  home: string,
  model: string,
  prompt: string,
  label: string,
  log: (msg: string) => void,
  deadlineAt: number,
  parse: (raw: string, parseLabel: string) => T,
): Promise<T> {
  const session = openDevinSession(workspace, home, model, log);
  const remaining = () => Math.max(0, deadlineAt - Date.now());
  const parseWithRepair = async (raw: string, parseLabel: string): Promise<T> => {
    try {
      return parse(raw, parseLabel);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(
        `${parseLabel} response unparseable; sending one JSON repair prompt via devin: ${message}`,
      );
      const repaired = await session.prompt(
        buildJsonRepairPrompt(message),
        `${parseLabel}-repair`,
        remaining(),
      );
      return parse(repaired, `${parseLabel}-repair`);
    }
  };
  const twice = () =>
    new Error(
      `${label}: the agent twice ended its turn without attempting the task (an announcement, then again after an explicit continuation). This model/CLI pairing appears unable to complete a session of this size in one turn — try more shards (review-shards: 0 for auto) or a different model/backend.`,
    );
  try {
    const raw = await session.prompt(prompt, label, remaining());
    if (!isNoAttemptReply(raw)) return await parseWithRepair(raw, label);
    // A second announcement is final whichever side sent the first continuation.
    if (session.nudged()) throw twice();
    log(`${label} ended its turn without attempting the task; sending one continuation prompt`);
    const continued = await session.prompt(
      CONTINUATION_NUDGE_PROMPT,
      `${label}-continue`,
      remaining(),
    );
    if (isNoAttemptReply(continued)) throw twice();
    return await parseWithRepair(continued, `${label}-continue`);
  } finally {
    session.close();
  }
}

export function devinEnvForHome(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  for (const key of sessionEnvDenyKeys(Object.keys(env))) delete env[key];
  delete env.XDG_CONFIG_HOME;
  delete env.XDG_DATA_HOME;
  delete env.XDG_CACHE_HOME;
  delete env.XDG_RUNTIME_DIR;
  // Inherited GIT_* overrides (GIT_CONFIG_GLOBAL, GIT_CONFIG_COUNT, GIT_DIR…)
  // would bypass the session's own gitconfig; pin git to it instead.
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = join(home, '.gitconfig');
  return env;
}

export function createDevinCliBackend(
  workspace: string,
  home: string,
): ReviewBackend & { stop(): Promise<void> } {
  const processes = createCliProcessScope();
  const unregister = onCliFatalSignal(() => processes.stop());
  return {
    name: DEVIN_PROVIDER_ID,
    async stop() {
      try {
        await processes.stop();
      } finally {
        unregister();
      }
    },
    abortSessionsByLabel: (label) => processes.abort(label),
    observability: DEVIN_CLI_TELEMETRY_CAPABILITY,
    async runReview(model, prContext, guidelines, log, options = {}) {
      const label = options.label ?? 'review';
      return processes.run(label, async () => {
        const deadlineAt = Math.min(
          options.deadlineAt ?? Infinity,
          Date.now() + (options.timeoutMs ?? DEVIN_PROMPT_TIMEOUT_MS),
        );
        const prompt = assembleReviewPrompt(
          prContext,
          guidelines,
          options.lensAddendum ?? '',
          options.evidenceQuotes ?? false,
          options.embeddedFirstPrompt ?? false,
          { contextFirst: options.contextFirst },
        );
        log(
          `Prompt assembled (${label}, devin-cli): ${prompt.length} chars, guidelines=${!!guidelines}`,
        );
        return promptWithRecovery(
          workspace,
          home,
          model,
          prompt,
          label,
          log,
          deadlineAt,
          (raw, parseLabel) => parseReview(raw, parseLabel, log, { strict: true }),
        );
      });
    },
    async runAddressedPriorCommentsCheck(model, prContext, log, timeoutMs) {
      return processes.run('addressed-prior-comments', () =>
        promptWithRecovery(
          workspace,
          home,
          model,
          assembleAddressedPriorCommentsPrompt(prContext),
          'addressed-prior-comments',
          log,
          deadline(timeoutMs),
          (raw, parseLabel) =>
            parseReview(raw, parseLabel, log, { strict: true, field: 'addressedPriorComments' })
              .addressedPriorComments,
        ),
      );
    },
    async runGuidelineComplianceCheck(model, prContext, guidelines, log, timeoutMs) {
      return processes.run('guideline-compliance', () =>
        promptWithRecovery(
          workspace,
          home,
          model,
          assembleGuidelineCompliancePrompt(prContext, guidelines),
          'guideline-compliance',
          log,
          deadline(timeoutMs),
          (raw, parseLabel) => parseReview(raw, parseLabel, log, { strict: true }).findings,
        ),
      );
    },
    async runFindingVerification(model, prContext, findings, log, timeoutMs) {
      return processes.run('finding-verification', () =>
        promptWithRecovery(
          workspace,
          home,
          model,
          assembleFindingVerificationPrompt(prContext, findings),
          'finding-verification',
          log,
          deadline(timeoutMs),
          (raw) => parseFindingVerdicts(raw, findings.length, log, { strict: true }),
        ),
      );
    },
    async runChangesSinceLastReview(model, deltaContext, log, timeoutMs) {
      return processes.run('changes-since-last-review', () =>
        promptWithRecovery(
          workspace,
          home,
          model,
          assembleChangesSinceLastReviewPrompt(deltaContext),
          'changes-since-last-review',
          log,
          deadline(timeoutMs),
          (raw, parseLabel) =>
            parseChangesSinceLastReviewSummary(raw, parseLabel, log, { strict: true }),
        ),
      );
    },
  };
}
