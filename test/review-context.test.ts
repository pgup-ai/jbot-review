import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

import {
  buildReviewContext,
  discoverGuidelines,
  formatDiffScope,
} from '../src/shared/review-context.ts';

async function withTempRepo(run: (repo: string) => Promise<void>): Promise<void> {
  const repo = await mkdtemp(join(tmpdir(), 'jbot-review-guidelines-'));
  try {
    await run(repo);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}

describe('discoverGuidelines', () => {
  it('lists referenced markdown docs without preloading their content', async () => {
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
      assert.match(guidelines, /### Referenced Markdown documents/);
      assert.match(guidelines, /- \.pr-governance\/design\/NORTH_STAR\.md/);
      assert.match(guidelines, /- \.pr-governance\/review\/PR_REVIEW_RUBRIC\.md/);
      assert.doesNotMatch(guidelines, /### \.pr-governance\/design\/NORTH_STAR\.md\n# North Star/);
      assert.doesNotMatch(guidelines, /Nested design instructions/);
      assert.doesNotMatch(guidelines, /Nested review instructions/);
    });
  });

  it('lists markdown references from root guidelines once when they overlap with governance docs', async () => {
    await withTempRepo(async (repo) => {
      await mkdir(join(repo, '.pr-governance'), { recursive: true });
      await mkdir(join(repo, 'docs'), { recursive: true });
      await writeFile(
        join(repo, 'AGENTS.md'),
        ['# Agents', '', 'Read `docs/SHARED.md` and [extra](docs/EXTRA.md).'].join('\n'),
      );
      await writeFile(join(repo, 'REVIEW.md'), '# Review\nAlso read `docs/SHARED.md`.');
      await writeFile(
        join(repo, '.pr-governance', 'README.md'),
        '# Governance\nRequired: `../docs/SHARED.md`',
      );
      await writeFile(join(repo, 'docs', 'SHARED.md'), '# Shared\nLoad this once');
      await writeFile(join(repo, 'docs', 'EXTRA.md'), '# Extra\nLoad this too');

      const guidelines = await discoverGuidelines(repo);

      assert.match(guidelines, /- docs\/SHARED\.md/);
      assert.match(guidelines, /- docs\/EXTRA\.md/);
      assert.doesNotMatch(guidelines, /Load this once/);
      assert.doesNotMatch(guidelines, /Load this too/);
      assert.equal(guidelines.match(/^- docs\/SHARED\.md$/gm)?.length, 1);
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

  it('loads compatible review-bot rules and scopes nested Bugbot files to changed paths', async () => {
    await withTempRepo(async (repo) => {
      await mkdir(join(repo, '.cursor', 'rules'), { recursive: true });
      await mkdir(join(repo, 'backend', 'api', '.cursor'), { recursive: true });
      await mkdir(join(repo, 'frontend', '.cursor'), { recursive: true });
      await mkdir(join(repo, '.jbot-review'), { recursive: true });
      await writeFile(join(repo, '.cursor', 'BUGBOT.md'), '# Root Bugbot\nAlways load this');
      await writeFile(join(repo, '.cursor', 'rules', 'a.mdc'), '# A Cursor Rule\nRoot rule A');
      await writeFile(join(repo, '.cursor', 'rules', 'b.mdc'), '# B Cursor Rule\nRoot rule B');
      await writeFile(join(repo, '.cursor', 'rules', 'review.mdc'), '# Cursor Rule\nRoot rule');
      await writeFile(join(repo, '.coderabbit.yaml'), 'reviews:\n  high_level_summary: true\n');
      await writeFile(
        join(repo, 'backend', 'api', '.cursor', 'BUGBOT.md'),
        '# API Bugbot\nScoped API rule',
      );
      await writeFile(
        join(repo, 'frontend', '.cursor', 'BUGBOT.md'),
        '# Frontend Bugbot\nShould not load',
      );
      await writeFile(join(repo, '.jbot-review', 'rules.md'), '# Private J-Bot\nShould not load');

      const guidelines = await discoverGuidelines(repo, ['backend/api/routes/user.ts']);

      assert.match(guidelines, /### \.cursor\/BUGBOT\.md\n# Root Bugbot/);
      assert.match(guidelines, /### \.cursor\/rules\/a\.mdc\n# A Cursor Rule/);
      assert.match(guidelines, /### \.cursor\/rules\/b\.mdc\n# B Cursor Rule/);
      assert.match(guidelines, /### \.cursor\/rules\/review\.mdc\n# Cursor Rule/);
      assert.ok(
        guidelines.indexOf('### .cursor/rules/a.mdc') <
          guidelines.indexOf('### .cursor/rules/b.mdc'),
      );
      assert.ok(
        guidelines.indexOf('### .cursor/rules/b.mdc') <
          guidelines.indexOf('### .cursor/rules/review.mdc'),
      );
      assert.match(guidelines, /### \.coderabbit\.yaml\nreviews:/);
      assert.match(guidelines, /### backend\/api\/\.cursor\/BUGBOT\.md\n# API Bugbot/);
      assert.doesNotMatch(guidelines, /Frontend Bugbot/);
      assert.doesNotMatch(guidelines, /Private J-Bot/);
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
          await writeFile(join(repo, '.pr-governance', 'INSIDE.md'), '# Inside\nAvailable only');
          await writeFile(traversalFile, '# Traversal\nDo not load this either');

          const guidelines = await discoverGuidelines(repo, ['../outside.ts']);

          assert.match(guidelines, /- \.pr-governance\/INSIDE\.md/);
          assert.doesNotMatch(guidelines, /Available only/);
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

  it('ignores symlinked guideline files and rule directories that resolve outside the repository', async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), 'jbot-review-outside-guidelines-'));
    try {
      await writeFile(join(outsideDir, 'SECRET.md'), '# Secret\nDo not inject this');
      await mkdir(join(outsideDir, 'rules'), { recursive: true });
      await writeFile(
        join(outsideDir, 'rules', 'outside.mdc'),
        '# Outside Rule\nDo not inject this either',
      );

      await withTempRepo(async (repo) => {
        await mkdir(join(repo, '.cursor'), { recursive: true });
        await symlink(join(outsideDir, 'SECRET.md'), join(repo, 'AGENTS.md'));
        await symlink(join(outsideDir, 'rules'), join(repo, '.cursor', 'rules'));
        await writeFile(join(repo, 'REVIEW.md'), '# Review\nValid in-repo guidance');

        const guidelines = await discoverGuidelines(repo);

        assert.match(guidelines, /### REVIEW\.md\n# Review/);
        assert.doesNotMatch(guidelines, /Secret/);
        assert.doesNotMatch(guidelines, /Outside Rule/);
        assert.doesNotMatch(guidelines, /Do not inject this/);
      });
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('truncates large guideline files instead of inlining them fully', async () => {
    await withTempRepo(async (repo) => {
      await writeFile(
        join(repo, 'AGENTS.md'),
        ['# Agents', '世界'.repeat(6000), 'END_SHOULD_NOT_APPEAR'].join('\n'),
      );

      const guidelines = await discoverGuidelines(repo);

      assert.match(guidelines, /### AGENTS\.md\n# Agents/);
      assert.match(guidelines, /Guidance truncated after \d+ bytes/);
      assert.doesNotMatch(guidelines, /END_SHOULD_NOT_APPEAR/);
      assert.doesNotMatch(guidelines, /\uFFFD/);
    });
  });
});

describe('formatDiffScope', () => {
  it('prefers SHAs and emits a three-dot diff command', () => {
    const baseSha = 'a'.repeat(40);
    const headSha = 'b'.repeat(40);
    const text = formatDiffScope({ baseRef: 'develop', baseSha, headSha });

    assert.match(text, /Base: develop \(a{40}\)/);
    assert.match(text, /Head: b{40}/);
    assert.match(text, new RegExp(`git diff ${baseSha}\\.\\.\\.${headSha}`));
    assert.match(text, /Only review changes within this diff\./);
  });

  it('falls back to origin/<baseRef>...HEAD when SHAs are missing', () => {
    const text = formatDiffScope({ baseRef: 'main' });

    assert.match(text, /Base: main/);
    assert.match(text, /git diff origin\/main\.\.\.HEAD/);
  });

  it('uses HEAD when only the base SHA is known', () => {
    const baseSha = 'c'.repeat(40);
    const text = formatDiffScope({ baseSha });

    assert.match(text, new RegExp(`git diff ${baseSha}\\.\\.\\.HEAD`));
  });

  it('returns an empty string when no scope data is available', () => {
    assert.equal(formatDiffScope({}), '');
  });
});

describe('buildReviewContext', () => {
  const baseParams = {
    pullTitle: 'Add retry logic',
    pullBody: '',
    changedFiles: ['src/a.ts'],
    priorComments: [],
    commits: [],
    checkSummary: 'All checks passed',
    guidelines: '',
  };

  it('embeds the diff scope inside the Pull request section', () => {
    const context = buildReviewContext({
      ...baseParams,
      diffScope: { baseRef: 'main', baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) },
    });

    const sections = context.split('\n\n');
    const prSection = sections.find((section) => section.startsWith('## Pull request')) ?? '';
    assert.match(prSection, /Base: main/);
    assert.match(prSection, /git diff a{40}\.\.\.b{40}/);
  });

  it('omits the diff scope lines when no scope is provided', () => {
    const context = buildReviewContext(baseParams);

    assert.doesNotMatch(context, /git diff/);
    assert.doesNotMatch(context, /Base:/);
  });
});
