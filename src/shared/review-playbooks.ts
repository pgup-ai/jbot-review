import { PATH_PATTERNS, type ChangeShape } from './diff-context.ts';
import type { ReviewPlaybookId } from './prompt.ts';

const CODE_REVIEW_CORE: ReviewPlaybookId = 'code-review-core';
const CONTRACT_API: ReviewPlaybookId = 'contract-api';
const BACKEND_DATA: ReviewPlaybookId = 'backend-data';
const FRONTEND_WORKFLOW: ReviewPlaybookId = 'frontend-workflow';
const EXTERNAL_INTEGRATION: ReviewPlaybookId = 'external-integration';
const INFRA_OPS: ReviewPlaybookId = 'infra-ops';

const REVIEW_PLAYBOOK_ORDER = [
  CODE_REVIEW_CORE,
  CONTRACT_API,
  BACKEND_DATA,
  FRONTEND_WORKFLOW,
  EXTERNAL_INTEGRATION,
  INFRA_OPS,
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
  // `ui` covers shared component/design-system dirs where even plain `.ts`
  // files (theme, tokens) are frontend. Bare `app` is deliberately NOT here:
  // it is too ambiguous — `src/app/` is a backend entry in this repo and many
  // Express/Nest apps, and even a Next.js `app/` route handler (`route.ts`) or
  // server action is backend-shaped. Real UI files under `app/` already match
  // by `.tsx`/`.jsx` extension below, so bare `app` would mostly add backend
  // false positives. `apps?/web` stays for the monorepo `apps/web` case.
  /(^|\/)(apps?\/web|ui|frontend|client|components?|pages?|views?|hooks?|stores?)\//i,
  /(^|\/)[^/]*(component|hook|form|dialog|modal|page|view)[^/]*\.[cm]?[jt]sx?$/i,
  /\.(tsx|jsx|vue|svelte)$/i,
];

const EXTERNAL_INTEGRATION_PATTERNS = [
  PATH_PATTERNS.tooling,
  /(^|\/)(integrations?|clients?|providers?|webhooks?|workers?|jobs?|auth|oauth)\//i,
  /(^|\/)\.github\/workflows\/.+\.ya?ml$/i,
  /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|action\.ya?ml)$/i,
  /(^|\/)[^/]*(client|provider|webhook|oauth|github|octokit|stripe|openai|anthropic|sdk)[^/]*\.[cm]?[jt]sx?$/i,
  /(^|\/)[^/]*(fetch|download|scrape|crawl|ingest)[^/]*\.[cm]?[jt]sx?$/i,
];

const INFRA_OPS_PATTERNS = [PATH_PATTERNS.infra];

/**
 * Whether the PR touches frontend files, by the SAME trigger the
 * frontend-workflow playbook uses (path + filename + extension — not extension
 * alone). Shared so the frontend recall lens and the playbook stay consistent:
 * a `.ts` store/hook under apps/web counts for both, or neither.
 */
export function changedFilesIncludeFrontend(changedFiles: string[]): boolean {
  return matchesAny(changedFiles, FRONTEND_WORKFLOW_PATTERNS);
}

export function selectReviewPlaybookIds(
  changedFiles: string[],
  shape?: ChangeShape,
): ReviewPlaybookId[] {
  // A test-only change touches no API/data/frontend/integration/infra
  // contract, so only the core checklist (plus the Tests focus item) applies.
  // Suppressing the rest cuts prompt dilution without narrowing scope — the
  // full diff is still reviewed. Core review is never suppressed.
  if (shape?.testOnly) return [CODE_REVIEW_CORE];

  const selected = new Set<ReviewPlaybookId>([CODE_REVIEW_CORE]);

  if (matchesAny(changedFiles, CONTRACT_API_PATTERNS)) selected.add(CONTRACT_API);
  if (matchesAny(changedFiles, BACKEND_DATA_PATTERNS)) selected.add(BACKEND_DATA);
  if (matchesAny(changedFiles, FRONTEND_WORKFLOW_PATTERNS)) selected.add(FRONTEND_WORKFLOW);
  if (matchesAny(changedFiles, EXTERNAL_INTEGRATION_PATTERNS)) selected.add(EXTERNAL_INTEGRATION);
  if (matchesAny(changedFiles, INFRA_OPS_PATTERNS)) selected.add(INFRA_OPS);

  return REVIEW_PLAYBOOK_ORDER.filter((id) => selected.has(id));
}

function matchesAny(files: string[], patterns: RegExp[]): boolean {
  return files.some((file) => patterns.some((pattern) => pattern.test(file)));
}
