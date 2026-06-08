import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

import { discoverGuidelines } from '../src/shared/review-context.ts';

async function withTempRepo(run: (repo: string) => Promise<void>): Promise<void> {
  const repo = await mkdtemp(join(tmpdir(), 'jbot-review-guidelines-'));
  try {
    await run(repo);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}

describe('discoverGuidelines', () => {
  it('loads the governance README and its required-reading markdown references', async () => {
    await withTempRepo(async (repo) => {
      await mkdir(join(repo, '.pr-governance', 'design'), { recursive: true });
      await mkdir(join(repo, '.pr-governance', 'review'), { recursive: true });
      await writeFile(join(repo, 'AGENTS.md'), '# Agents\nRoot agent instructions');
      await writeFile(join(repo, 'REVIEW.md'), '# Review\nRoot review instructions');
      await writeFile(
        join(repo, '.pr-governance', 'README.md'),
        [
          '# Governance',
          '',
          'Required reading:',
          '- `../AGENTS.md`',
          '- `design/NORTH_STAR.md`',
          '- [Review rubric](review/PR_REVIEW_RUBRIC.md)',
        ].join('\n'),
      );
      await writeFile(
        join(repo, '.pr-governance', 'design', 'NORTH_STAR.md'),
        '# North Star\nNested design instructions',
      );
      await writeFile(
        join(repo, '.pr-governance', 'review', 'PR_REVIEW_RUBRIC.md'),
        '# Rubric\nNested review instructions',
      );

      const guidelines = await discoverGuidelines(repo);

      assert.match(guidelines, /### AGENTS\.md\n# Agents/);
      assert.match(guidelines, /### REVIEW\.md\n# Review/);
      assert.match(guidelines, /### \.pr-governance\/README\.md\n# Governance/);
      assert.match(guidelines, /### \.pr-governance\/design\/NORTH_STAR\.md\n# North Star/);
      assert.match(guidelines, /### \.pr-governance\/review\/PR_REVIEW_RUBRIC\.md\n# Rubric/);
      assert.match(guidelines, /Nested design instructions/);
      assert.match(guidelines, /Nested review instructions/);
    });
  });

  it('falls back to immediate governance files when no governance README exists', async () => {
    await withTempRepo(async (repo) => {
      await mkdir(join(repo, '.pr-governance'), { recursive: true });
      await writeFile(join(repo, '.pr-governance', 'PARADIGM_SNAPSHOT.md'), '# Snapshot');

      const guidelines = await discoverGuidelines(repo);

      assert.match(guidelines, /### \.pr-governance\/PARADIGM_SNAPSHOT\.md\n# Snapshot/);
    });
  });

  it('ignores governance references outside the repository root', async () => {
    const outsideFile = join(tmpdir(), `jbot-review-outside-${Date.now()}.md`);
    await writeFile(outsideFile, '# Outside\nDo not load this');
    try {
      await withTempRepo(async (repo) => {
        const traversalFile = resolve(repo, '..', 'outside.md');
        await mkdir(join(repo, '.pr-governance'), { recursive: true });
        try {
          await writeFile(
            join(repo, '.pr-governance', 'README.md'),
            [
              '# Governance',
              '',
              `- [absolute outside](${outsideFile})`,
              '- `../../outside.md`',
              '- `INSIDE.md`',
            ].join('\n'),
          );
          await writeFile(join(repo, '.pr-governance', 'INSIDE.md'), '# Inside\nLoad this');
          await writeFile(traversalFile, '# Traversal\nDo not load this either');

          const guidelines = await discoverGuidelines(repo);

          assert.match(guidelines, /### \.pr-governance\/INSIDE\.md\n# Inside/);
          assert.doesNotMatch(guidelines, /Do not load this/);
          assert.doesNotMatch(guidelines, /Do not load this either/);
        } finally {
          await rm(traversalFile, { force: true });
        }
      });
    } finally {
      await rm(outsideFile, { force: true });
    }
  });
});
