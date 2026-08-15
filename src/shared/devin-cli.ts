import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

import {
  buildDevinReadOnlyConfig,
  DEVIN_CLI_BIN,
  DEVIN_PROVIDER_ID,
  onFatalSignal,
  parseModelName,
  spawnWithTimeout,
  truncateForLog,
} from '@symma/protocol';

import {
  assembleAddressedPriorCommentsPrompt,
  assembleChangesSinceLastReviewPrompt,
  assembleFindingVerificationPrompt,
  assembleGuidelineCompliancePrompt,
  assembleReviewPrompt,
  buildJsonRepairFollowupPrompt,
} from './prompt.ts';
import {
  parseChangesSinceLastReviewSummary,
  parseFindingVerdicts,
  parseReview,
  sessionEnvDenyKeys,
} from './opencode.ts';
import type { ReviewBackend } from './session-concurrency.ts';

const DEVIN_PROMPT_TIMEOUT_MS = 20 * 60_000;
const DEVIN_REPAIR_PROMPT_BUDGET_BYTES = 80_000;
const DEVIN_REPAIR_RESPONSE_BUDGET_BYTES = 20_000;

function removeDevinSession(dir: string, log: (msg: string) => void): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (error) {
    log(`Could not remove isolated Devin session: ${String(error)}`);
  }
}

export function buildDevinCliArgs(model: string, promptFile: string, configFile: string): string[] {
  const { modelID } = parseModelName(model);
  const args = [
    '--respect-workspace-trust',
    'false',
    '--permission-mode',
    'auto',
    '--config',
    configFile,
    '--prompt-file',
    promptFile,
  ];
  if (modelID !== 'default') args.push('--model', modelID);
  args.push('-p');
  return args;
}

export function buildDevinCliConfig(home: string) {
  const config = buildDevinReadOnlyConfig();
  return {
    ...config,
    permissions: {
      ...config.permissions,
      deny: [...config.permissions.deny, `Read(${home}/**)`],
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

async function runDevinPrompt(
  workspace: string,
  home: string,
  model: string,
  prompt: string,
  label: string,
  log: (msg: string) => void,
  timeoutMs = DEVIN_PROMPT_TIMEOUT_MS,
): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'jbot-devin-session-'));
  const unregister = onFatalSignal(() => removeDevinSession(root, log));
  const promptFile = join(root, 'prompt.txt');
  const configFile = join(root, 'config.json');
  try {
    writeFileSync(promptFile, prompt, { mode: 0o600 });
    writeFileSync(configFile, JSON.stringify(buildDevinCliConfig(home)), { mode: 0o600 });
    log(`Calling ${label} prompt (agent=devin-cli, model=${model})`);
    for (let attempt = 0; ; attempt += 1) {
      const result = await spawnWithTimeout(
        DEVIN_CLI_BIN,
        buildDevinCliArgs(model, promptFile, configFile),
        {
          cwd: workspace,
          env: devinEnvForHome(home),
          timeoutMs,
          timeoutMessage: `devin ${label} prompt timed out after ${Math.round(timeoutMs / 1000)}s`,
        },
      );
      const output = parseDevinCliOutput(result.stdout);
      if (output.setupOnly) {
        if (attempt === 0) {
          log(`${label} devin first-run setup completed; retrying prompt once.`);
          continue;
        }
        throw new Error(`devin ${label} returned setup output instead of a prompt response.`);
      }
      if (result.exitCode !== 0) {
        throw new Error(
          `devin ${label} exited ${result.exitCode}: ${truncateForLog(
            result.stderr || result.stdout,
            1000,
          )}`,
        );
      }
      log(
        `${label} prompt complete via devin: stdout=${result.stdout.length} chars stderr=${result.stderr.length} chars`,
      );
      if (!output.response && result.stderr) {
        log(`${label} returned empty stdout; stderr: ${truncateForLog(result.stderr, 1000)}`);
      }
      return output.response;
    }
  } finally {
    unregister();
    removeDevinSession(root, log);
  }
}

export function devinEnvForHome(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  for (const key of sessionEnvDenyKeys(Object.keys(env))) delete env[key];
  delete env.XDG_CONFIG_HOME;
  delete env.XDG_DATA_HOME;
  delete env.XDG_CACHE_HOME;
  delete env.XDG_RUNTIME_DIR;
  return env;
}

export function createDevinCliBackend(workspace: string, home: string): ReviewBackend {
  return {
    name: DEVIN_PROVIDER_ID,
    async runReview(model, prContext, guidelines, log, options = {}) {
      const label = options.label ?? 'review';
      const prompt = assembleReviewPrompt(
        prContext,
        guidelines,
        options.lensAddendum ?? '',
        options.evidenceQuotes ?? false,
      );
      log(
        `Prompt assembled (${label}, devin-cli): ${prompt.length} chars, guidelines=${!!guidelines}`,
      );
      const raw = await runDevinPrompt(
        workspace,
        home,
        model,
        prompt,
        label,
        log,
        options.timeoutMs,
      );
      try {
        return parseReview(raw, label, log, { strict: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`${label} response unparseable; sending one JSON repair prompt via devin: ${message}`);
        const repaired = await runDevinPrompt(
          workspace,
          home,
          model,
          buildJsonRepairFollowupPrompt({
            originalPrompt: prompt,
            invalidResponse: raw,
            parseError: message,
            promptBudgetBytes: DEVIN_REPAIR_PROMPT_BUDGET_BYTES,
            responseBudgetBytes: DEVIN_REPAIR_RESPONSE_BUDGET_BYTES,
          }),
          `${label}-repair`,
          log,
          options.timeoutMs,
        );
        return parseReview(repaired, `${label}-repair`, log, { strict: true });
      }
    },
    async runAddressedPriorCommentsCheck(model, prContext, log, timeoutMs) {
      const raw = await runDevinPrompt(
        workspace,
        home,
        model,
        assembleAddressedPriorCommentsPrompt(prContext),
        'addressed-prior-comments',
        log,
        timeoutMs,
      );
      return parseReview(raw, 'addressed-prior-comments', log).addressedPriorComments;
    },
    async runGuidelineComplianceCheck(model, prContext, guidelines, log, timeoutMs) {
      const raw = await runDevinPrompt(
        workspace,
        home,
        model,
        assembleGuidelineCompliancePrompt(prContext, guidelines),
        'guideline-compliance',
        log,
        timeoutMs,
      );
      return parseReview(raw, 'guideline-compliance', log).findings;
    },
    async runFindingVerification(model, prContext, findings, log, timeoutMs) {
      const raw = await runDevinPrompt(
        workspace,
        home,
        model,
        assembleFindingVerificationPrompt(prContext, findings),
        'finding-verification',
        log,
        timeoutMs,
      );
      return parseFindingVerdicts(raw, findings.length, log);
    },
    async runChangesSinceLastReview(model, prContext, deltaContext, log, timeoutMs) {
      const raw = await runDevinPrompt(
        workspace,
        home,
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
