import { PATH_PATTERNS } from './diff-context.ts';

export interface ReviewPlaybook {
  id: string;
  title: string;
  triggers: string[];
  checks: string[];
}

const CODE_REVIEW_CORE: ReviewPlaybook = {
  id: 'code-review-core',
  title: 'Code review core',
  triggers: ['always'],
  checks: [
    'Look for runtime errors, null/undefined paths, missing awaits, unhandled errors, and edge cases introduced by the diff.',
    'Check unintended side effects, backward-compatibility breaks, and changed defaults that can surprise unchanged callers.',
    'Flag security, performance, test, and maintainability risks only when they have a concrete trigger path.',
  ],
};

const CONTRACT_API: ReviewPlaybook = {
  id: 'contract-api',
  title: 'Contract/API review',
  triggers: [
    'API, route, schema, descriptor, config, docs-for-behavior, or package/workflow changes',
  ],
  checks: [
    'Verify every new or changed contract claim against implementation, callers, and docs/examples.',
    'Check schema/default/env/input compatibility, response shape drift, and migration or rollout path for breaking changes.',
    'Treat bounded results as suspicious: pagination, max rows, truncation, or caching must not be described as complete.',
  ],
};

const BACKEND_DATA: ReviewPlaybook = {
  id: 'backend-data',
  title: 'Persistence/data review',
  triggers: [
    'database, migration, repository, query, ledger/accounting, import/export, or aggregation changes',
  ],
  checks: [
    'Check query predicates, joins, tenant/entity scoping, ordering, grouping, totals, and nullable/empty-set behavior.',
    'Verify writes are transactional/idempotent where retries or duplicate events are plausible.',
    'Look for silent data loss from dropped rows, lossy normalization, precision changes, partial writes, or stale read models.',
  ],
};

const FRONTEND_WORKFLOW: ReviewPlaybook = {
  id: 'frontend-workflow',
  title: 'Frontend/workflow review',
  triggers: ['React, UI component, route, frontend state, form, or client workflow changes'],
  checks: [
    'Check loading, error, empty, disabled, permission-denied, and retry states for each changed workflow.',
    'Verify React hook dependencies, stale closures, async cancellation, optimistic updates, and derived state consistency.',
    'Look for lost user input, double-submit paths, stale data after mutations, and controls enabled before prerequisites are ready.',
  ],
};

const EXTERNAL_INTEGRATION: ReviewPlaybook = {
  id: 'external-integration',
  title: 'External integration review',
  triggers: [
    'SDK/client, webhook, auth, GitHub Action, workflow, package, or external-service changes',
  ],
  checks: [
    'Verify current API/SDK contract, auth scopes, request/response shape, pagination, retry semantics, and rate/error handling.',
    'Check idempotency for webhooks, jobs, and retries; avoid duplicate writes or dropped events after partial failure.',
    'Confirm config/env/docs expose the same provider, version, permission, and secret requirements the code actually uses.',
  ],
};

export const REVIEW_PLAYBOOKS = [
  CODE_REVIEW_CORE,
  CONTRACT_API,
  BACKEND_DATA,
  FRONTEND_WORKFLOW,
  EXTERNAL_INTEGRATION,
] as const satisfies readonly ReviewPlaybook[];

const CONTRACT_API_PATTERNS = [
  PATH_PATTERNS.api,
  PATH_PATTERNS.tooling,
  /(^|\/)(schemas?|descriptors?|contracts?|capabilit(?:y|ies)|config|settings|routes?|controllers?|webhooks?)\//i,
  /(^|\/)(package\.json|README\.md|AGENTS\.md|REVIEW\.md|TECHNICAL_STANDARDS\.md|ARCHITECTURE\.md)$/i,
  /\.(ya?ml|json|toml|env|md|mdx)$/i,
];

const BACKEND_DATA_PATTERNS = [
  PATH_PATTERNS.data,
  /(^|\/)(repositories?|models?|entities|services?|ledger|accounting|orders?|bills?|invoices?|tax|imports?|exports?)\//i,
  /(^|\/)[^/]*(repository|repo|migration|schema|ledger|aggregate|projection|read-model)[^/]*\.[cm]?[jt]s$/i,
  /\.(sql|prisma)$/i,
];

const FRONTEND_WORKFLOW_PATTERNS = [
  /(^|\/)(apps?\/web|frontend|client|components?|pages?|routes?|views?|hooks?|stores?)\//i,
  /(^|\/)[^/]*(component|hook|form|dialog|modal|page|route|view)[^/]*\.[cm]?[jt]sx?$/i,
  /\.(tsx|jsx|vue|svelte)$/i,
];

const EXTERNAL_INTEGRATION_PATTERNS = [
  PATH_PATTERNS.tooling,
  /(^|\/)(integrations?|clients?|providers?|webhooks?|workers?|jobs?|actions?|workflows?|auth|oauth)\//i,
  /(^|\/)\.github\/workflows\/.+\.ya?ml$/i,
  /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|action\.ya?ml)$/i,
  /(^|\/)[^/]*(client|provider|webhook|oauth|github|octokit|stripe|openai|anthropic|sdk)[^/]*\.[cm]?[jt]sx?$/i,
];

export function selectReviewPlaybooks(changedFiles: string[]): ReviewPlaybook[] {
  const selected = new Map<string, ReviewPlaybook>([[CODE_REVIEW_CORE.id, CODE_REVIEW_CORE]]);

  if (matchesAny(changedFiles, CONTRACT_API_PATTERNS)) selected.set(CONTRACT_API.id, CONTRACT_API);
  if (matchesAny(changedFiles, BACKEND_DATA_PATTERNS)) selected.set(BACKEND_DATA.id, BACKEND_DATA);
  if (matchesAny(changedFiles, FRONTEND_WORKFLOW_PATTERNS)) {
    selected.set(FRONTEND_WORKFLOW.id, FRONTEND_WORKFLOW);
  }
  if (matchesAny(changedFiles, EXTERNAL_INTEGRATION_PATTERNS)) {
    selected.set(EXTERNAL_INTEGRATION.id, EXTERNAL_INTEGRATION);
  }

  return REVIEW_PLAYBOOKS.filter((playbook) => selected.has(playbook.id));
}

export function buildReviewPlaybookBlock(changedFiles: string[]): string {
  const playbooks = selectReviewPlaybooks(changedFiles);
  return [
    '## Built-in review playbooks',
    'Apply these curated review skills as focused checklists. They narrow attention, not scope; still review the complete PR diff.',
    ...playbooks.map(formatPlaybook),
  ].join('\n');
}

function formatPlaybook(playbook: ReviewPlaybook): string {
  return [
    '',
    `### ${playbook.title} (${playbook.id})`,
    `When relevant: ${playbook.triggers.join('; ')}.`,
    ...playbook.checks.map((check) => `- ${check}`),
  ].join('\n');
}

function matchesAny(files: string[], patterns: RegExp[]): boolean {
  return files.some((file) => patterns.some((pattern) => pattern.test(file)));
}
