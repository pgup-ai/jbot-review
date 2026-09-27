import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  parseAacrDataset,
  sampleAacrInstances,
  toJudgeComments,
  toOfficialResult,
} from '../src/shared/aacr-bench.ts';
import type { Finding } from '../src/shared/types.ts';

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const row = (overrides: Record<string, unknown> = {}) => ({
  project_main_language: 'Go',
  pr_url: 'https://github.com/acme/widgets/pull/7',
  pr_source_commit: BASE,
  pr_target_commit: HEAD,
  pr_change_line_count: 40,
  path: 'pkg/a.go',
  side: 'right',
  from_line: 3,
  to_line: 5,
  note: 'nil map write',
  label: 1,
  ...overrides,
});

describe('parseAacrDataset', () => {
  it('groups rows per PR with the official commit mapping and keeps only correct comments', () => {
    const [instance, ...rest] = parseAacrDataset([
      row(),
      row({ note: 'wrong claim', label: 0 }),
      row({ pr_url: 'https://github.com/acme/other/pull/1', label: 0 }),
    ]);
    assert.equal(rest.length, 0);
    assert.deepEqual(instance, {
      instanceId: 'acme__widgets@bbbbbbb',
      repo: 'acme/widgets',
      prNumber: 7,
      language: 'Go',
      base: BASE,
      head: HEAD,
      changeLines: 40,
      references: [
        { path: 'pkg/a.go', side: 'right', fromLine: 3, toLine: 5, note: 'nil map write' },
      ],
    });
  });

  it('rejects rows without usable commits', () => {
    assert.throws(() => parseAacrDataset([row({ pr_source_commit: 'main' })]), /pr_source_commit/);
  });
});

describe('sampleAacrInstances', () => {
  it('picks the same per-language sample for a seed', () => {
    const instances = parseAacrDataset(
      ['Go', 'Go', 'Go', 'Rust', 'Rust'].map((language, index) =>
        row({
          project_main_language: language,
          pr_url: `https://github.com/acme/r${index}/pull/1`,
        }),
      ),
    );
    const first = sampleAacrInstances(instances, { perLanguage: 1, seed: 7 });
    assert.deepEqual(first, sampleAacrInstances(instances, { perLanguage: 1, seed: 7 }));
    assert.deepEqual(
      first.map((instance) => instance.language),
      ['Go', 'Rust'],
    );
  });
});

describe('toJudgeComments', () => {
  it('keeps postable findings, maps line 0 to file level and joins title with body', () => {
    const finding = (overrides: Partial<Finding>): Finding => ({
      path: 'pkg/a.go',
      line: 4,
      severity: 'P2',
      title: 'Nil map write',
      body: 'Panics when empty.',
      ...overrides,
    });
    assert.deepEqual(
      toJudgeComments([
        finding({}),
        finding({ line: 0 }),
        finding({ confidence: 'low' }),
        finding({ verificationUncertain: true, publishUnverified: 'P1' }),
      ]),
      [
        {
          path: 'pkg/a.go',
          side: 'right',
          fromLine: 4,
          toLine: 4,
          note: 'Nil map write\n\nPanics when empty.',
        },
        {
          path: 'pkg/a.go',
          side: 'right',
          fromLine: null,
          toLine: null,
          note: 'Nil map write\n\nPanics when empty.',
        },
        {
          path: 'pkg/a.go',
          side: 'right',
          fromLine: 4,
          toLine: 4,
          note: 'Nil map write\n\nPanics when empty.',
        },
      ],
    );
  });
});

describe('toOfficialResult', () => {
  it('writes the OCR-shaped file the official evaluate.py reads for unknown reviewers', () => {
    const [instance] = parseAacrDataset([row()]);
    const result = toOfficialResult({
      instance: instance!,
      comments: [{ path: 'pkg/a.go', side: 'right', fromLine: 4, toLine: 4, note: 'n' }],
      durationSeconds: 12.3456,
      inputTokens: 100,
      outputTokens: 7,
    });
    assert.deepEqual(result, {
      instance_id: 'acme__widgets@bbbbbbb',
      repo: 'acme/widgets',
      base_commit: BASE,
      head_commit: HEAD,
      reviewer: 'jbot',
      duration_seconds: 12.35,
      review: {
        comments: [{ path: 'pkg/a.go', start_line: 4, end_line: 4, content: 'n' }],
        summary: { input_tokens: 100, output_tokens: 7 },
      },
    });
  });
});
