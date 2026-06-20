import { PATH_PATTERNS } from './diff-context.ts';
import type { ReviewPlaybookId } from './prompt.ts';

const CODE_REVIEW_CORE: ReviewPlaybookId = 'code-review-core';
const CONTRACT_API: ReviewPlaybookId = 'contract-api';
const BACKEND_DATA: ReviewPlaybookId = 'backend-data';
const FRONTEND_WORKFLOW: ReviewPlaybookId = 'frontend-workflow';
const EXTERNAL_INTEGRATION: ReviewPlaybookId = 'external-integration';

const REVIEW_PLAYBOOK_ORDER = [
  CODE_REVIEW_CORE,
  CONTRACT_API,
  BACKEND_DATA,
  FRONTEND_WORKFLOW,
  EXTERNAL_INTEGRATION,
] as const satisfies readonly ReviewPlaybookId[];

const CONTRACT_API_PATTERNS = [
  PATH_PATTERNS.api,
  PATH_PATTERNS.tooling,
  /(^|\/)(schemas?|descriptors?|contracts?|capabilit(?:y|ies)|config|settings|routes?|controllers?|webhooks?)\//i,
  /(^|\/)(package\.json|README\.md|AGENTS\.md|REVIEW\.md|TECHNICAL_STANDARDS\.md|ARCHITECTURE\.md)$/i,
  /(^|\/)\.env[^/]*$/i,
  /\.(ya?ml|json|toml|env|md|mdx)$/i,
];

const BACKEND_DATA_PATTERNS = [
  PATH_PATTERNS.data,
  /(^|\/)(repositories?|models?|entities|services?|ledger|accounting|orders?|bills?|invoices?|tax|imports?|exports?)\//i,
  /(^|\/)[^/]*(repository|migration|schema|ledger|aggregate|projection|read-model)[^/]*\.[cm]?[jt]s$/i,
  /\.(sql|prisma)$/i,
];

const FRONTEND_WORKFLOW_PATTERNS = [
  /(^|\/)(apps?\/web|frontend|client|components?|pages?|views?|hooks?|stores?)\//i,
  /(^|\/)[^/]*(component|hook|form|dialog|modal|page|view)[^/]*\.[cm]?[jt]sx?$/i,
  /\.(tsx|jsx|vue|svelte)$/i,
];

const EXTERNAL_INTEGRATION_PATTERNS = [
  PATH_PATTERNS.tooling,
  /(^|\/)(integrations?|clients?|providers?|webhooks?|workers?|jobs?|auth|oauth)\//i,
  /(^|\/)\.github\/workflows\/.+\.ya?ml$/i,
  /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|action\.ya?ml)$/i,
  /(^|\/)[^/]*(client|provider|webhook|oauth|github|octokit|stripe|openai|anthropic|sdk)[^/]*\.[cm]?[jt]sx?$/i,
];

export function selectReviewPlaybookIds(changedFiles: string[]): ReviewPlaybookId[] {
  const selected = new Set<ReviewPlaybookId>([CODE_REVIEW_CORE]);

  if (matchesAny(changedFiles, CONTRACT_API_PATTERNS)) selected.add(CONTRACT_API);
  if (matchesAny(changedFiles, BACKEND_DATA_PATTERNS)) selected.add(BACKEND_DATA);
  if (matchesAny(changedFiles, FRONTEND_WORKFLOW_PATTERNS)) selected.add(FRONTEND_WORKFLOW);
  if (matchesAny(changedFiles, EXTERNAL_INTEGRATION_PATTERNS)) selected.add(EXTERNAL_INTEGRATION);

  return REVIEW_PLAYBOOK_ORDER.filter((id) => selected.has(id));
}

function matchesAny(files: string[], patterns: RegExp[]): boolean {
  return files.some((file) => patterns.some((pattern) => pattern.test(file)));
}
