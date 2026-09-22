import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildContextPack, type PackSourceProvider } from '../src/shared/context-pack.ts';
import { indexEvidenceSource, type PathAlias } from '../src/shared/evidence.ts';

const REPO: Record<string, string> = {
  'apps/api/src/ledger.service.ts': [
    "import { Injectable } from '@nestjs/common';",
    "import { LedgerRepository } from '@app/ledger';",
    "import { formatId } from './format';",
    '',
    '@Injectable()',
    'export class LedgerService {',
    "  private readonly prefix = 'L';",
    '  constructor(private readonly repo: LedgerRepository) {}',
    '',
    '  post(id: string) {',
    '    const key = id.trim();',
    '    if (!key) {',
    "      throw new Error('missing id');",
    '    }',
    '    const saved = this.repo.save(formatId(key));',
    '    return saved;',
    '  }',
    '}',
  ].join('\n'),
  'apps/api/src/format.ts': 'export function formatId(id: string) {\n  return `L-${id}`;\n}',
  'apps/api/src/ledger.controller.ts': [
    "import { LedgerService } from './ledger.service';",
    '',
    'export class LedgerController {',
    '  constructor(private readonly service: LedgerService) {}',
    '',
    '  create(id: string) {',
    '    return this.service.post(id);',
    '  }',
    '}',
  ].join('\n'),
  'apps/api/src/legacy.ts': [
    '// LedgerService used to live here',
    'export function replay(service: { post(id: string): string }) {',
    "  return service.post('x');",
    '}',
  ].join('\n'),
  'libs/ledger/src/index.ts': "export * from './ledger.repository';",
  'libs/ledger/src/ledger.repository.ts': [
    'export class LedgerRepository {',
    '  save(id: string) {',
    '    return id;',
    '  }',
    '}',
  ].join('\n'),
};

const PAGE = [
  {
    filename: 'apps/api/src/ledger.service.ts',
    patch: [
      '@@ -12,6 +12,6 @@',
      '     if (!key) {',
      "       throw new Error('missing id');",
      '     }',
      '-    const saved = this.repo.save(key);',
      '+    const saved = this.repo.save(formatId(key));',
      '     return saved;',
      '   }',
    ].join('\n'),
  },
];
const CHANGED = new Set(PAGE.map((file) => file.filename));
const ALIASES: PathAlias[] = [
  { prefix: '@app/ledger', wildcard: false, targets: ['libs/ledger/src'] },
];

function provider(files = REPO): PackSourceProvider {
  return {
    tracked: new Set(Object.keys(files)),
    aliases: ALIASES,
    load: async (path) =>
      files[path] === undefined
        ? undefined
        : {
            lines: files[path].split('\n'),
            index: indexEvidenceSource(path, files[path], { rich: true }),
          },
    references: async (symbol) =>
      Object.entries(files).flatMap(([path, text]) =>
        text
          .split('\n')
          .flatMap((line, i) =>
            new RegExp(`\\b${symbol}\\b`).test(line) ? [{ path, line: i + 1 }] : [],
          ),
      ),
  };
}

test('surrounding code adds the enclosing method and constructor lines the diff does not show', async () => {
  const pack = await buildContextPack(PAGE, CHANGED, provider(), 64 * 1024);
  assert.equal(pack.state, 'complete');
  assert.match(
    pack.text,
    /#### apps\/api\/src\/ledger\.service\.ts:7-8 \(LedgerService\.constructor\)\n7: {3}private readonly prefix = 'L';\n8: {3}constructor/,
  );
  assert.match(
    pack.text,
    /#### apps\/api\/src\/ledger\.service\.ts:10-17 \(LedgerService\.post\)\n10: {3}post\(id: string\) \{\n11: {5}const key = id\.trim\(\);\n\[lines 12-17: in this page's diff\]/,
  );
  assert.match(
    pack.text,
    /- apps\/api\/src\/: format\.ts, ledger\.controller\.ts, ledger\.service\.ts\*, legacy\.ts/,
  );
  assert.deepEqual(pack.supplied.ranges.get('apps/api/src/ledger.service.ts'), [
    [7, 8],
    [10, 11],
  ]);
  assert.deepEqual([...pack.supplied.directories], ['apps/api/src']);
});

test('the budget cuts whole items from the end and lists them as omitted', async () => {
  const full = await buildContextPack(PAGE, CHANGED, provider(), 64 * 1024);
  const budget = Buffer.byteLength(full.text) - 40;
  const tight = await buildContextPack(PAGE, CHANGED, provider(), budget);
  assert.ok(Buffer.byteLength(tight.text) <= budget);
  assert.match(tight.text, /### Omitted\n- apps\/api\/src \(directories\)/);
  assert.equal(tight.omitted, 1);
  assert.equal((await buildContextPack(PAGE, CHANGED, provider(), 100)).text, '');
});

test('a source the provider cannot deliver makes the pack partial', async () => {
  const failing = { ...provider(), load: async () => Promise.reject(new Error('timeout')) };
  const pack = await buildContextPack(PAGE, CHANGED, failing, 64 * 1024);
  assert.equal(pack.state, 'partial');
  assert.match(pack.text, /- 1 item\(s\) not collected before the pack deadline/);
});

test('used definitions follow imports, path aliases, re-exports and injected services', async () => {
  const pack = await buildContextPack(PAGE, CHANGED, provider(), 64 * 1024);
  assert.match(
    pack.text,
    /### Definitions used by the change\n\n#### apps\/api\/src\/format\.ts:1-3 \(formatId\)\n1: export function formatId/,
  );
  assert.match(
    pack.text,
    /#### libs\/ledger\/src\/ledger\.repository\.ts:2-4 \(LedgerRepository\.save\)\n2: {3}save\(id: string\) \{/,
  );
  // Task 9 adds caller symbols to the same set, so check membership only.
  assert.ok(pack.supplied.symbols.has('formatId') && pack.supplied.symbols.has('save'));
});

test('callers need an import link, and other name matches stay listed as unverified', async () => {
  const pack = await buildContextPack(PAGE, CHANGED, provider(), 64 * 1024);
  assert.match(
    pack.text,
    /### Callers of changed symbols\n\n#### apps\/api\/src\/ledger\.controller\.ts:3-9 \(LedgerController\.create, calls LedgerService\.post\)\n3: export class LedgerController \{/,
  );
  assert.match(
    pack.text,
    /Unverified name matches for `LedgerService\.post` \(no import link found\): apps\/api\/src\/legacy\.ts:2, apps\/api\/src\/legacy\.ts:3/,
  );
  assert.deepEqual(pack.supplied.ranges.get('apps/api/src/ledger.controller.ts'), [[3, 9]]);
  assert.equal(pack.supplied.symbols.has('post'), true);
  // The caller excerpt is formatId's call in post, not ledger.service.ts's import block.
  const page = [
    {
      filename: 'apps/api/src/format.ts',
      patch: [
        '@@ -1,3 +1,3 @@',
        ' export function formatId(id: string) {',
        '-  return id;',
        '+  return `L-${id}`;',
        ' }',
      ].join('\n'),
    },
  ];
  const formatPack = await buildContextPack(
    page,
    new Set([page[0].filename]),
    provider(),
    64 * 1024,
  );
  assert.match(
    formatPack.text,
    /#### apps\/api\/src\/ledger\.service\.ts:10-18 \(LedgerService\.post, calls formatId\)/,
  );
  assert.doesNotMatch(formatPack.text, /ledger\.service\.ts:1-/);
});
