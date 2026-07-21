import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

import { GIT_DIFF_ARGS } from '../src/shared/git.ts';
import {
  buildReviewContext,
  discoverGuidelineDocs,
  discoverGuidelines,
  formatContextBudget,
  formatDiffScope,
  formatFinderGuidelines,
  formatGuidelines,
  truncatePrBody,
  MAX_FINDER_GUIDELINE_BYTES,
  MAX_PR_BODY_BYTES,
} from '../src/shared/review-context.ts';

const GIT_DIFF_COMMAND = `git ${GIT_DIFF_ARGS.join(' ')}`;

describe('formatContextBudget', () => {
  it('reports per-fragment bytes largest-first with a total, dropping empties', () => {
    const line = formatContextBudget([
      { name: 'guidelines', text: 'x'.repeat(100) },
      { name: 'diff', text: 'y'.repeat(250) },
      { name: 'context7', text: '' },
    ]);
    assert.equal(line, 'Context budget (bytes): diff=250 guidelines=100 total=350');
  });

  it('measures UTF-8 bytes, not code units', () => {
    assert.match(formatContextBudget([{ name: 'core', text: '日' }]), /core=3 total=3/);
  });
});

async function withTempRepo(run: (repo: string) => Promise<void>): Promise<void> {
  const repo = await mkdtemp(join(tmpdir(), 'jbot-review-guidelines-'));
  try {
    await run(repo);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}

describe('discoverGuidelines', () => {
  it('preloads governance README references while keeping root-guideline references listed', async () => {
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
      assert.match(guidelines, /Nested design instructions/);
      assert.match(guidelines, /Nested review instructions/);
      assert.doesNotMatch(guidelines, /### Referenced Markdown documents/);
    });
  });

  it('preloads TECHNICAL_STANDARDS.md and ARCHITECTURE.md from the repo root', async () => {
    await withTempRepo(async (repo) => {
      await writeFile(join(repo, 'TECHNICAL_STANDARDS.md'), '# Standards\nNo floating promises.');
      await writeFile(
        join(repo, 'ARCHITECTURE.md'),
        '# Architecture\nServices never import from app/.',
      );

      const guidelines = await discoverGuidelines(repo);

      assert.match(guidelines, /### TECHNICAL_STANDARDS\.md\n# Standards/);
      assert.match(guidelines, /No floating promises\./);
      assert.match(guidelines, /### ARCHITECTURE\.md\n# Architecture/);
      assert.match(guidelines, /Services never import from app\//);
    });
  });

  it('lists governance references that exceed the guidance budget instead of dropping them', async () => {
    await withTempRepo(async (repo) => {
      await mkdir(join(repo, '.pr-governance'), { recursive: true });
      // 5 x 24KB files exhaust the 96KB total budget before the last reference.
      const bigBody = 'x'.repeat(25 * 1024);
      const references: string[] = [];
      for (let index = 1; index <= 5; index += 1) {
        await writeFile(
          join(repo, '.pr-governance', `BIG_${index}.md`),
          `# Big ${index}\n${bigBody}`,
        );
        references.push(`- \`BIG_${index}.md\``);
      }
      await writeFile(join(repo, '.pr-governance', 'LAST.md'), '# Last\nBudget exhausted by now');
      references.push('- `LAST.md`');
      await writeFile(
        join(repo, '.pr-governance', 'README.md'),
        ['# Governance', '', ...references].join('\n'),
      );

      const guidelines = await discoverGuidelines(repo);

      assert.match(guidelines, /### Review guidance budget/);
      assert.doesNotMatch(guidelines, /Budget exhausted by now/);
      assert.match(guidelines, /### Referenced Markdown documents/);
      assert.match(guidelines, /- \.pr-governance\/LAST\.md/);
    });
  });

  it('preloads markdown references from root guidelines once, including governance overlaps', async () => {
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

      assert.match(guidelines, /### docs\/SHARED\.md\n# Shared/);
      assert.match(guidelines, /Load this once/);
      assert.match(guidelines, /### docs\/EXTRA\.md\n# Extra/);
      assert.match(guidelines, /Load this too/);
      assert.equal(guidelines.match(/Load this once/g)?.length, 1);
      assert.doesNotMatch(guidelines, /### Referenced Markdown documents/);
    });
  });

  it('lists root-guideline references that exceed the guidance budget instead of dropping them', async () => {
    await withTempRepo(async (repo) => {
      await mkdir(join(repo, 'docs'), { recursive: true });
      const bigBody = 'x'.repeat(25 * 1024);
      const references: string[] = [];
      for (let index = 1; index <= 4; index += 1) {
        await writeFile(join(repo, 'docs', `BIG_${index}.md`), `# Big ${index}\n${bigBody}`);
        references.push(`- \`docs/BIG_${index}.md\``);
      }
      await writeFile(join(repo, 'docs', 'LAST.md'), '# Last\nBudget exhausted by now');
      references.push('- `docs/LAST.md`');
      await writeFile(join(repo, 'AGENTS.md'), ['# Agents', '', ...references].join('\n'));

      const guidelines = await discoverGuidelines(repo);

      assert.match(guidelines, /### Review guidance budget/);
      assert.doesNotMatch(guidelines, /Budget exhausted by now/);
      assert.match(guidelines, /### Referenced Markdown documents/);
      assert.match(guidelines, /- docs\/LAST\.md/);
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

          assert.match(guidelines, /### \.pr-governance\/INSIDE\.md\n# Inside/);
          assert.match(guidelines, /Available only/);
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

  it('loads DESIGN.md and DECISIONS.md as root guidance', async () => {
    await withTempRepo(async (repo) => {
      await writeFile(join(repo, 'DESIGN.md'), '# Design\nArchitecture decisions');
      await writeFile(join(repo, 'DECISIONS.md'), '# Decisions\nADR log');
      const guidelines = await discoverGuidelines(repo);
      assert.match(guidelines, /### DESIGN\.md\n# Design/);
      assert.match(guidelines, /### DECISIONS\.md\n# Decisions/);
    });
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
    assert.ok(text.includes(`${GIT_DIFF_COMMAND} ${baseSha}...${headSha}`));
    assert.match(text, /Only review changes within this diff\./);
  });

  it('falls back to origin/<baseRef>...HEAD when SHAs are missing', () => {
    const text = formatDiffScope({ baseRef: 'main' });

    assert.match(text, /Base: main/);
    assert.ok(text.includes(`${GIT_DIFF_COMMAND} origin/main...HEAD`));
  });

  it('uses HEAD when only the base SHA is known', () => {
    const baseSha = 'c'.repeat(40);
    const text = formatDiffScope({ baseSha });

    assert.ok(text.includes(`${GIT_DIFF_COMMAND} ${baseSha}...HEAD`));
  });

  it('returns an empty string when no scope data is available', () => {
    assert.equal(formatDiffScope({}), '');
  });

  it('emits a two-dot worktree diff command in local mode', () => {
    const baseSha = 'd'.repeat(40);
    const text = formatDiffScope({ baseSha, worktree: true });

    // Two-dot against the working tree (no ...HEAD), with the content-shaping
    // flags that match the embedded hunks, and it must say so.
    assert.ok(text.includes(`${GIT_DIFF_COMMAND} ${baseSha}`));
    assert.doesNotMatch(text, /\.\.\./);
    assert.match(text, /working tree/i);
    assert.match(text, /uncommitted/i);
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
    assert.ok(prSection.includes(`${GIT_DIFF_COMMAND} ${'a'.repeat(40)}...${'b'.repeat(40)}`));
  });

  it('omits the diff scope lines when no scope is provided', () => {
    const context = buildReviewContext(baseParams);

    assert.doesNotMatch(context, /git diff/);
    assert.doesNotMatch(context, /Base:/);
  });

  it('bounds an oversized PR description at the byte budget and discloses the truncation', () => {
    const context = buildReviewContext({
      ...baseParams,
      pullBody: `${'x'.repeat(8000)}TAIL_SENTINEL`,
    });

    assert.match(context, /\[PR description truncated to keep the review prompt bounded\.\]/);
    assert.doesNotMatch(context, /TAIL_SENTINEL/);
  });

  it('keeps a small PR description intact without a truncation notice', () => {
    const context = buildReviewContext({ ...baseParams, pullBody: 'Fixes the retry backoff.' });

    assert.match(context, /Fixes the retry backoff\./);
    assert.doesNotMatch(context, /PR description truncated/);
  });

  it('keeps the truncated output within the byte budget INCLUDING the disclosure notice', () => {
    // The cap is a hard budget (invariant #4): body slice + appended notice
    // together must not exceed it, or the "bounded" block still bloats.
    const out = truncatePrBody('x'.repeat(8000));
    assert.ok(
      Buffer.byteLength(out, 'utf8') <= MAX_PR_BODY_BYTES,
      `truncated body ${Buffer.byteLength(out, 'utf8')} bytes exceeds the ${MAX_PR_BODY_BYTES} cap`,
    );
    assert.match(out, /PR description truncated/);
  });

  it('truncates the PR description on a UTF-8 boundary, never mid-character', () => {
    const context = buildReviewContext({ ...baseParams, pullBody: '€'.repeat(3000) });

    assert.match(context, /PR description truncated/);
    assert.ok(!context.includes('�'), 'truncation split a multi-byte character');
  });
});

describe('discoverGuidelineDocs', () => {
  it('returns structured docs and marks scoped guidance higher relevance', async () => {
    await withTempRepo(async (repo) => {
      await writeFile(join(repo, 'AGENTS.md'), '# Agents\nRoot');
      await mkdir(join(repo, 'apps', 'web'), { recursive: true });
      await writeFile(join(repo, 'apps', 'web', 'AGENTS.md'), '# Web Agents\nScoped');

      const discovered = await discoverGuidelineDocs(repo, ['apps/web/index.ts']);
      const root = discovered.docs.find((d) => d.label === 'AGENTS.md');
      const scoped = discovered.docs.find((d) => d.label === 'apps/web/AGENTS.md');

      assert.ok(root, 'root AGENTS.md present');
      assert.ok(scoped, 'scoped AGENTS.md present');
      assert.ok(scoped.relevance > root.relevance, 'scoped outranks root');
      // formatGuidelines still emits the legacy section markers for both docs.
      // (Asserting against discoverGuidelines() would be circular — it now
      // delegates to formatGuidelines. The pre-existing discoverGuidelines
      // regex assertions above are the real behavior-preservation guard.)
      const full = formatGuidelines(discovered);
      assert.match(full, /### AGENTS\.md\n# Agents/);
      assert.match(full, /### apps\/web\/AGENTS\.md\n# Web Agents/);
    });
  });
});

describe('formatFinderGuidelines', () => {
  it('keeps scoped guidance and drops lower-relevance root docs past the cap', async () => {
    await withTempRepo(async (repo) => {
      await writeFile(join(repo, 'AGENTS.md'), '# Root\n' + 'x'.repeat(4000));
      await mkdir(join(repo, 'apps', 'web'), { recursive: true });
      await writeFile(join(repo, 'apps', 'web', 'REVIEW.md'), '# Scoped review\nfindme-scoped');

      const discovered = await discoverGuidelineDocs(repo, ['apps/web/index.ts']);
      const finder = formatFinderGuidelines(discovered, { capBytes: 1024 });

      assert.ok(Buffer.byteLength(finder, 'utf8') <= 1024 + 256, 'within cap (+ notice slack)');
      assert.match(finder, /findme-scoped/, 'scoped doc kept');
      assert.doesNotMatch(finder, /x{4000}/, 'large root doc dropped');
      assert.match(finder, /omitted from this pass/, 'omission notice present');
    });
  });

  it('returns the same docs as the full render when everything fits', async () => {
    await withTempRepo(async (repo) => {
      await writeFile(join(repo, 'AGENTS.md'), '# Agents\nsmall');
      const discovered = await discoverGuidelineDocs(repo, []);
      const finder = formatFinderGuidelines(discovered, { capBytes: 96 * 1024 });
      assert.match(finder, /### AGENTS\.md\n# Agents/);
      assert.doesNotMatch(finder, /omitted from this pass/);
    });
  });

  it('always keeps the highest-relevance doc even when it alone exceeds the cap', async () => {
    await withTempRepo(async (repo) => {
      await mkdir(join(repo, 'apps', 'web'), { recursive: true });
      await writeFile(join(repo, 'apps', 'web', 'REVIEW.md'), '# Scoped\n' + 'findme '.repeat(500));
      const discovered = await discoverGuidelineDocs(repo, ['apps/web/index.ts']);
      const finder = formatFinderGuidelines(discovered, { capBytes: 256 });
      assert.match(finder, /findme/, 'top doc kept despite exceeding the cap');
    });
  });

  it('uses MAX_FINDER_GUIDELINE_BYTES by default and is smaller than the total cap', () => {
    assert.ok(MAX_FINDER_GUIDELINE_BYTES < 96 * 1024);
  });
});
