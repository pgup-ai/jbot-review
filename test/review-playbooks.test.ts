import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildReviewPlaybookBlock, selectReviewPlaybooks } from '../src/shared/review-playbooks.ts';

describe('selectReviewPlaybooks', () => {
  it('always includes the compact core review playbook', () => {
    const playbooks = selectReviewPlaybooks(['docs/readme.txt']);

    assert.deepEqual(
      playbooks.map((playbook) => playbook.id),
      ['code-review-core'],
    );
  });

  it('selects contract and external integration playbooks for workflow/config changes', () => {
    const playbooks = selectReviewPlaybooks(['.github/workflows/jbot-review.yml', 'package.json']);
    const ids = playbooks.map((playbook) => playbook.id);

    assert.ok(ids.includes('code-review-core'));
    assert.ok(ids.includes('contract-api'));
    assert.ok(ids.includes('external-integration'));
  });

  it('selects persistence/data review for database and repository changes', () => {
    const playbooks = selectReviewPlaybooks([
      'apps/core-ledger/src/orders/orders.repository.ts',
      'apps/core-ledger/src/db/migrations/001_add_index.sql',
    ]);
    const ids = playbooks.map((playbook) => playbook.id);

    assert.ok(ids.includes('backend-data'));
  });

  it('selects frontend workflow review for React UI changes', () => {
    const playbooks = selectReviewPlaybooks(['src/components/InvoiceDialog.tsx']);
    const ids = playbooks.map((playbook) => playbook.id);

    assert.ok(ids.includes('frontend-workflow'));
  });

  it('deduplicates playbooks selected by multiple files', () => {
    const playbooks = selectReviewPlaybooks([
      'src/components/InvoiceDialog.tsx',
      'src/frontend/hooks/use-invoice.ts',
    ]);

    assert.equal(playbooks.filter((playbook) => playbook.id === 'frontend-workflow').length, 1);
  });
});

describe('buildReviewPlaybookBlock', () => {
  it('renders selected built-in review skills as bounded prompt checklists', () => {
    const block = buildReviewPlaybookBlock([
      'apps/core-ledger/src/orders/orders.repository.ts',
      'src/components/InvoiceDialog.tsx',
      '.github/workflows/jbot-review.yml',
    ]);

    assert.match(block, /## Built-in review playbooks/);
    assert.match(block, /narrow attention, not scope/);
    assert.match(block, /### Code review core \(code-review-core\)/);
    assert.match(block, /### Persistence\/data review \(backend-data\)/);
    assert.match(block, /### Frontend\/workflow review \(frontend-workflow\)/);
    assert.match(block, /### External integration review \(external-integration\)/);
    assert.match(block, /### Contract\/API review \(contract-api\)/);
  });
});
