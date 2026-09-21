import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { formatFindingSources } from '../src/shared/prompt.ts';
import {
  investigationOverlap,
  NativeEvidenceStore,
  nativeEvidenceCandidates,
  nativeInvestigationTrace,
} from '../src/shared/native-evidence.ts';

it('hands off only snapshot-matching native source and counts overlapping lines once', () => {
  const sources = new Map([
    ['src/a.ts', "import { b } from './b';\nexport const a = b;\n"],
    ['src/b.ts', 'export const b = 1;\n'],
    ['src/unrelated.ts', 'export const secret = 3;\n'],
  ]);
  const transcript = (reads: { id: string; path: unknown; text: string; error?: boolean }[]) =>
    [
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: reads.map((r) => ({
            type: 'tool_use',
            id: r.id,
            name: 'read_file',
            input: { file_path: r.path },
          })),
        },
      },
      {
        type: 'message',
        message: {
          role: 'user',
          content: reads.map((r) => ({
            type: 'tool_result',
            tool_use_id: r.id,
            is_error: r.error,
            content: [{ type: 'text', text: r.text }],
          })),
        },
      },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n');
  const read = {
    id: 'a',
    path: '/repo/src/a.ts',
    text: "1: import { b } from './b';\n2: export const a = b;",
  };
  const review = nativeInvestigationTrace(
    transcript([
      read,
      { id: 'b', path: '/repo/src/b.ts', text: '1: export const b = 1;' },
      { id: 'bad', path: '/repo/src/a.ts', text: '1: stale content' },
      { id: 'outside', path: '/credentials', text: '1: secret' },
      { id: 'many', path: ['/repo/src/a.ts'], text: read.text },
      { id: 'failed', path: read.path, text: read.text, error: true },
      { id: 'unrelated', path: '/repo/src/unrelated.ts', text: '1: export const secret = 3;' },
    ]),
    '/repo',
    sources,
  );
  assert.equal(review.unsupportedReads, 4);
  const verification = nativeInvestigationTrace(
    transcript([
      { ...read, text: '2: export const a = b;' },
      { ...read, id: 'again', text: '2: export const a = b;' },
    ]),
    '/repo',
    sources,
  );
  assert.deepEqual(investigationOverlap(review, verification), {
    readCalls: 2,
    overlappingReadCalls: 2,
    fullyOverlappingReadCalls: 2,
    uniqueReadLines: 1,
    overlappingLines: 1,
    exactRepeatedSearches: 0,
    unsupportedReads: 0,
  });
  const findings = [
    {
      path: 'src/a.ts',
      line: 2,
      severity: 'P2' as const,
      title: 'CLAIM_NOT_EVIDENCE',
      body: 'Unproven claim',
    },
  ];
  const handoff = nativeEvidenceCandidates(review, findings, sources, 'head-sha');
  assert.deepEqual(
    handoff.candidates.map((c) => c.path),
    ['src/a.ts', 'src/b.ts'],
  );
  assert.deepEqual(handoff.omitted, ['src/unrelated.ts']);
  assert.match(JSON.stringify(handoff.candidates), /head-sha/);
  assert.doesNotMatch(
    JSON.stringify(handoff.candidates),
    /stale content|CLAIM_NOT_EVIDENCE|export const secret/,
  );
  const large = Array.from({ length: 100 }, (_, i) => `export const v${i} = '${'x'.repeat(50)}';`);
  const largeSources = new Map([['src/a.ts', large.join('\n')]]);
  const partial = nativeEvidenceCandidates(
    {
      reads: [{ path: 'src/a.ts', lines: Array.from({ length: 60 }, (_, i) => i + 21) }],
      searchReads: [],
      paths: ['src/a.ts'],
      searches: [],
      unsupportedReads: 0,
    },
    findings,
    largeSources,
    'head-sha',
  );
  assert.equal(partial.candidates[0].completeFile, false);
  assert.ok(Buffer.byteLength(partial.candidates[0].text) <= 2048);
  assert.match(partial.candidates[0].text, /^21: /);
  assert.doesNotMatch(partial.candidates[0].text, /(?:^|\n)(?:1|81): /);
  const supplied = formatFindingSources(
    [
      { path: 'src/a.ts', line: 2, startLine: 2, lines: ['export const a = b;'] },
      { path: 'src/b.ts', line: 1, startLine: 1, lines: ['stale content'] },
    ],
    [],
  );
  const deduped = nativeEvidenceCandidates(review, findings, sources, 'head-sha', supplied);
  assert.equal(deduped.duplicateLines, 1);
  assert.equal(deduped.candidates[0].text, "1: import { b } from './b';");
  assert.equal(deduped.candidates[0].completeFile, false);
  assert.equal(deduped.candidates[1].text, '1: export const b = 1;');
  const truncated = formatFindingSources(
    [{ path: 'src/a.ts', line: 50, startLine: 1, lines: large }],
    [],
  );
  const remaining = nativeEvidenceCandidates(
    nativeInvestigationTrace(
      transcript([{ ...read, text: large.map((line, i) => `${i + 1}: ${line}`).join('\n') }]),
      '/repo',
      largeSources,
    ),
    findings,
    largeSources,
    'head-sha',
    truncated,
  );
  assert.ok(remaining.duplicateLines > 0 && remaining.duplicateLines < large.length);
  for (const line of remaining.candidates[0].text.split('\n'))
    assert.ok(!truncated.split('\n').includes(line));
  const newSources = new Map(sources).set('src/a.ts', 'changed\n');
  assert.equal(nativeInvestigationTrace(transcript([read]), '/repo', newSources).reads.length, 0);
  const search = [
    {
      type: 'message',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'search',
            name: 'grep',
            input: { path: '/repo', pattern: 'export', output_mode: 'content' },
          },
        ],
      },
    },
    {
      type: 'message',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'search',
            content: `/repo/src/a.ts-1-import { b } from './b';\n/repo/src/a.ts:2:export const a = b;\n/repo/src/b.ts:1:stale content\n/outside:1:secret`,
          },
        ],
      },
    },
  ]
    .map((entry) => JSON.stringify(entry))
    .join('\n');
  const fromSearch = nativeInvestigationTrace(search, '/repo', sources);
  assert.deepEqual(fromSearch.paths, ['src/a.ts', 'src/b.ts']);
  assert.deepEqual(fromSearch.searchReads, [{ path: 'src/a.ts', lines: [1, 2] }]);
  assert.equal(investigationOverlap(fromSearch, verification).fullyOverlappingReadCalls, 2);
});

it('revalidates stored native evidence and subtracts only delivered source', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'jbot-native-evidence-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', workspace]);
  const source = "import { b } from './b';\nexport const a = b;\n";
  await writeFile(join(workspace, 'a.ts'), source);
  await writeFile(join(workspace, 'b.ts'), 'export const b = 1;\n');
  execFileSync('git', ['-C', workspace, 'add', '.']);
  const transcript = [
    {
      type: 'message',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'b', name: 'read_file', input: { path: 'b.ts' } }],
      },
    },
    {
      type: 'message',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'b', content: '1: export const b = 1;' }],
      },
    },
  ]
    .map((entry) => JSON.stringify(entry))
    .join('\n');
  const store = new NativeEvidenceStore(workspace, 'snapshot');
  const finding = [{ path: 'a.ts', line: 2, body: 'Check the imported contract.' }];
  assert.equal((await store.prepare(finding, '')).packet, '');
  await store.observe(transcript);
  const supplied = formatFindingSources(
    [{ path: 'a.ts', line: 2, startLine: 1, lines: source.trimEnd().split('\n') }],
    [],
  );
  const result = await store.prepare(finding, supplied);
  assert.equal(result.stats.duplicateLines, 0);
  assert.equal(result.stats.selected, 1);
  assert.match(result.packet, /export const b = 1;/);
  assert.doesNotMatch(result.packet, /export const a/);
  await writeFile(join(workspace, 'b.ts'), 'export const b = 2;\n');
  const stale = await store.prepare(finding, supplied);
  assert.equal(stale.stats.staleFiles, 1);
  assert.equal(stale.packet, '');
});
