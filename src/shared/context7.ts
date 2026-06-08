import type { PrFile } from './github.ts';

export type Context7Mode = 'auto' | 'always' | 'off';

export interface Context7Decision {
  enabled: boolean;
  reason: string;
}

const CONTEXT7_PATH_PATTERNS = [
  /(^|\/)package\.json$/i,
  /(^|\/)action\.ya?ml$/i,
  /^\.github\/workflows\/.+\.ya?ml$/i,
];

const CONTEXT7_PATCH_PATTERNS = [
  /\b(openai|anthropic|openrouter|octokit|stripe|plaid|quickbooks|supabase|firebase)\b/i,
  /\b(@actions\/github|@actions\/core|@octokit\/|@aws-sdk\/|googleapis|@google-cloud\/)\b/i,
  /\b(github\.rest|graphql\(|fetch\(|axios\.|undici|authorization|bearer|api[_-]?key)\b/i,
  /\b(webhook|pagination|rate[- ]?limit|streaming|tool[- ]?call|retry)\b/i,
];

export function parseContext7Mode(value: string): Context7Mode {
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === 'auto') return 'auto';
  if (['true', 'always', 'on', 'yes', '1'].includes(normalized)) return 'always';
  if (['false', 'off', 'no', '0'].includes(normalized)) return 'off';
  throw new Error('Invalid context7 value: expected auto, true, or false.');
}

export function decideContext7Mode(params: {
  mode: Context7Mode;
  files: PrFile[];
  apiKey: string;
}): Context7Decision {
  if (params.mode === 'off') {
    return { enabled: false, reason: 'disabled by configuration' };
  }

  if (!params.apiKey.trim()) {
    return { enabled: false, reason: 'no Context7 API key configured' };
  }

  if (params.mode === 'always') {
    return { enabled: true, reason: 'enabled by configuration' };
  }

  const match = params.files.find(isExternalContractChange);
  if (!match) {
    return {
      enabled: false,
      reason: 'no external API, SDK, framework, CLI, or workflow contract changes detected',
    };
  }

  return { enabled: true, reason: `external contract change detected in ${match.filename}` };
}

function isExternalContractChange(file: PrFile): boolean {
  if (CONTEXT7_PATH_PATTERNS.some((pattern) => pattern.test(file.filename))) return true;
  const patch = file.patch ?? '';
  return CONTEXT7_PATCH_PATTERNS.some((pattern) => pattern.test(patch));
}
