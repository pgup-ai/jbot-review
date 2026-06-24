import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MAX_REVIEW_PLAYBOOK_BLOCK_BYTES, buildReviewPlaybookBlock } from '../src/shared/prompt.ts';
import { selectReviewPlaybookIds } from '../src/shared/review-playbooks.ts';

describe('selectReviewPlaybookIds', () => {
  it('always includes the compact core review playbook', () => {
    assert.deepEqual(selectReviewPlaybookIds(['docs/readme.txt']), ['code-review-core']);
  });

  it('selects contract and external integration playbooks for workflow/config changes', () => {
    const ids = selectReviewPlaybookIds(['.github/workflows/jbot-review.yml', 'package.json']);

    assert.ok(ids.includes('code-review-core'));
    assert.ok(ids.includes('contract-api'));
    assert.ok(ids.includes('external-integration'));
  });

  it('selects contract review for dotenv template files', () => {
    const ids = selectReviewPlaybookIds(['.env.example']);

    assert.ok(ids.includes('contract-api'));
  });

  it('selects persistence/data review for database and repository changes', () => {
    const ids = selectReviewPlaybookIds([
      'apps/core-ledger/src/orders/orders.repository.ts',
      'apps/core-ledger/src/db/migrations/001_add_index.sql',
    ]);

    assert.ok(ids.includes('backend-data'));
  });

  it('does not treat report layout files as repositories', () => {
    const ids = selectReviewPlaybookIds(['src/shared/report.ts']);

    assert.deepEqual(ids, ['code-review-core']);
  });

  it('selects frontend workflow review for React UI changes', () => {
    const ids = selectReviewPlaybookIds(['src/components/InvoiceDialog.tsx']);

    assert.ok(ids.includes('frontend-workflow'));
  });

  it('does not treat backend router files as frontend workflow files', () => {
    const ids = selectReviewPlaybookIds(['apps/api/src/routes/router.ts']);

    assert.ok(!ids.includes('frontend-workflow'));
  });

  it('does not treat application workflow directories as external integrations', () => {
    const ids = selectReviewPlaybookIds(['apps/billing/src/workflows/reconcile.ts']);

    assert.ok(!ids.includes('external-integration'));
  });

  it('deduplicates playbooks selected by multiple files', () => {
    const ids = selectReviewPlaybookIds([
      'src/components/InvoiceDialog.tsx',
      'src/frontend/hooks/use-invoice.ts',
    ]);

    assert.equal(ids.filter((id) => id === 'frontend-workflow').length, 1);
  });

  it('selects infra-ops for IaC and container changes', () => {
    assert.ok(selectReviewPlaybookIds(['infra/main.tf']).includes('infra-ops'));
    assert.ok(selectReviewPlaybookIds(['Dockerfile']).includes('infra-ops'));
    assert.ok(selectReviewPlaybookIds(['deploy/k8s/app.yaml']).includes('infra-ops'));
  });

  it('routes remote-fetch scripts to external-integration (supply-chain)', () => {
    const ids = selectReviewPlaybookIds(['scripts/fetch-logos.mjs']);
    assert.ok(ids.includes('external-integration'), `got: ${ids.join(', ')}`);
  });
});

describe('selectReviewPlaybookIds with change shape', () => {
  it('suppresses non-core playbooks for a test-only change', () => {
    const ids = selectReviewPlaybookIds(
      ['src/components/Invoice.test.tsx', 'apps/api/src/routes/router.test.ts'],
      { testOnly: true, largeDeletion: false, dependencyManifestChange: false },
    );

    assert.deepEqual(ids, ['code-review-core']);
  });

  it('keeps path-based selection when the change is not test-only', () => {
    // largeDeletion/dependencyManifestChange are not read by this function
    // (they only drive focus-block emphasis), so they are left false here.
    const ids = selectReviewPlaybookIds(['apps/api/src/routes/router.ts'], {
      testOnly: false,
      largeDeletion: false,
      dependencyManifestChange: false,
    });

    assert.ok(ids.includes('contract-api'));
  });

  it('is unchanged when no shape is provided (back-compat)', () => {
    assert.deepEqual(selectReviewPlaybookIds(['docs/readme.txt']), ['code-review-core']);
    assert.ok(selectReviewPlaybookIds(['infra/main.tf']).includes('infra-ops'));
  });

  it('treats bare app/ and ui/ directories as frontend (Next.js app-router, ui dirs)', () => {
    // A plain .ts file under app//ui is frontend in Next.js/Nuxt/SvelteKit
    // layouts (server actions, route data, theme), so it gets the frontend
    // playbook rather than core-only.
    assert.ok(selectReviewPlaybookIds(['src/app/actions.ts']).includes('frontend-workflow'));
    assert.ok(selectReviewPlaybookIds(['src/ui/theme.ts']).includes('frontend-workflow'));
    // ...but a non-web `apps/<pkg>` path is not auto-frontend.
    assert.ok(!selectReviewPlaybookIds(['apps/api/src/server.ts']).includes('frontend-workflow'));
  });
});

describe('buildReviewPlaybookBlock', () => {
  it('renders selected built-in review skills as bounded prompt checklists', () => {
    const block = buildReviewPlaybookBlock([
      'code-review-core',
      'contract-api',
      'backend-data',
      'frontend-workflow',
      'external-integration',
    ]);

    assert.ok(Buffer.byteLength(block, 'utf8') <= MAX_REVIEW_PLAYBOOK_BLOCK_BYTES);
    assert.match(block, /## Built-in review playbooks/);
    assert.match(block, /narrow attention, not scope/);
    assert.match(block, /### Code review core \(code-review-core\)/);
    assert.match(block, /### Persistence\/data review \(backend-data\)/);
    assert.match(block, /### Frontend\/workflow review \(frontend-workflow\)/);
    assert.match(block, /### External integration review \(external-integration\)/);
    assert.match(block, /### Contract\/API review \(contract-api\)/);
  });

  it('lists playbooks omitted by a small byte budget', () => {
    const block = buildReviewPlaybookBlock(
      [
        'code-review-core',
        'contract-api',
        'backend-data',
        'frontend-workflow',
        'external-integration',
      ],
      { budgetBytes: 800 },
    );

    assert.ok(Buffer.byteLength(block, 'utf8') <= 800);
    assert.match(block, /contract-api, backend-data, frontend-workflow, external-integration/);
  });

  it('renders the infra-ops playbook when infra files change', () => {
    const block = buildReviewPlaybookBlock(selectReviewPlaybookIds(['infra/main.tf']));
    assert.match(block, /### Infra\/ops review \(infra-ops\)/);
  });

  it('renders the playbooks selected for a representative PR', () => {
    const block = buildReviewPlaybookBlock(
      selectReviewPlaybookIds([
        'apps/core-ledger/src/orders/orders.repository.ts',
        'src/components/InvoiceDialog.tsx',
        '.github/workflows/jbot-review.yml',
      ]),
    );

    assert.match(block, /## Built-in review playbooks/);
    assert.match(block, /narrow attention, not scope/);
    assert.match(block, /### Code review core \(code-review-core\)/);
    assert.match(block, /### Persistence\/data review \(backend-data\)/);
    assert.match(block, /### Frontend\/workflow review \(frontend-workflow\)/);
    assert.match(block, /### External integration review \(external-integration\)/);
    assert.match(block, /### Contract\/API review \(contract-api\)/);
  });
});
