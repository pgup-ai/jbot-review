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
const FORMAT_PAGE = [
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
    references: async (symbol, paths) =>
      Object.entries(files)
        .filter(([path]) => !paths || paths.includes(path))
        .flatMap(([path, text]) =>
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
  assert.match(pack.text, /\n- apps\/api\/: src\/\n\n- apps\/: api\/\n\n- \.\/: apps\/, libs\/$/);
  assert.deepEqual(pack.supplied.ranges.get('apps/api/src/ledger.service.ts'), [
    [7, 8],
    [10, 17],
  ]);
  assert.deepEqual([...pack.supplied.directories], ['apps/api/src', 'apps/api', 'apps', '.']);
});

test('surrounding code encloses changes in top-level variables and in class bodies', async () => {
  const path = 'apps/api/src/retry.ts';
  const source = [
    "import { Injectable, Scope } from '@nestjs/common';",
    "import { withRetry } from './retry-policy';",
    '',
    'export const retried = withRetry(',
    '  async (id: string) => {',
    '    const key = id.trim();',
    '    return key;',
    '  },',
    '  { attempts: 5 },',
    ');',
    '',
    '@Injectable({ scope: Scope.REQUEST })',
    'export class RetryService {',
    '  run(id: string) {',
    '    return retried(id);',
    '  }',
    '}',
  ].join('\n');
  const patch = [
    '@@ -8,3 +8,3 @@',
    '   },',
    '-  { attempts: 3 },',
    '+  { attempts: 5 },',
    ' );',
    '@@ -11,3 +11,3 @@',
    ' ',
    '-@Injectable()',
    '+@Injectable({ scope: Scope.REQUEST })',
    ' export class RetryService {',
  ].join('\n');
  const pack = await buildContextPack(
    [{ filename: path, patch }],
    new Set([path]),
    provider({ ...REPO, [path]: source }),
    64 * 1024,
  );
  assert.match(pack.text, /#### apps\/api\/src\/retry\.ts:4-10 \(retried\)\n4: export const/);
  assert.match(pack.text, /#### apps\/api\/src\/retry\.ts:14-17 \(RetryService\)\n14: {3}run/);
  const blank = [{ filename: 'apps/api/src/ledger.service.ts', patch: '@@ -8,0 +9 @@\n+' }];
  const spaced = await buildContextPack(blank, CHANGED, provider(), 64 * 1024);
  assert.doesNotMatch(spaced.text, /\(LedgerService[,)]/);
});

test('the budget cuts whole items from the end and lists them as omitted', async () => {
  const full = await buildContextPack(PAGE, CHANGED, provider(), 64 * 1024);
  const budget = Buffer.byteLength(full.text) - 40;
  const tight = await buildContextPack(PAGE, CHANGED, provider(), budget);
  assert.ok(Buffer.byteLength(tight.text) <= budget);
  assert.match(tight.text, /### Omitted\n- apps\/api\/src \(directories\)/);
  // An ancestor's Omitted line costs about what its listing saves, so the whole map goes.
  assert.equal(tight.omitted, 4);
  assert.equal((await buildContextPack(PAGE, CHANGED, provider(), 100)).text, '');
});

test('a source the provider cannot deliver makes the pack partial', async () => {
  const failing = { ...provider(), load: async () => Promise.reject(new Error('timeout')) };
  const pack = await buildContextPack(PAGE, CHANGED, failing, 64 * 1024);
  assert.equal(pack.state, 'partial');
  assert.equal(pack.uncollected, 1);
  assert.match(pack.text, /- 1 item\(s\) not collected within the pack's time and file limits/);
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
  assert.doesNotMatch(pack.text, /No references to/);
  // The caller excerpt is formatId's call in post, not ledger.service.ts's import block.
  const formatPack = await buildContextPack(
    FORMAT_PAGE,
    new Set([FORMAT_PAGE[0].filename]),
    provider(),
    64 * 1024,
  );
  assert.match(
    formatPack.text,
    /#### apps\/api\/src\/ledger\.service\.ts:10-18 \(LedgerService\.post, calls formatId\)/,
  );
  assert.doesNotMatch(formatPack.text, /ledger\.service\.ts:1-/);
  // The import in ledger.service.ts is not shown, but its file's call is.
  assert.match(
    formatPack.text,
    /18: \}\n\nNo references to `formatId` in JS or TS files beyond this page's diff and the excerpts above\./,
  );
  // The diff shows all of format.ts, so a re-read of it counts as supplied.
  assert.equal(formatPack.supplied.lines.get('apps/api/src/format.ts'), 3);
  assert.deepEqual(formatPack.supplied.ranges.get('apps/api/src/format.ts'), [[1, 3]]);
  const controller = REPO['apps/api/src/ledger.controller.ts'].replace(
    '    return',
    '    this.service.post(id);\n'.repeat(3) + '    return',
  );
  const clustered = await buildContextPack(
    PAGE,
    CHANGED,
    provider({ ...REPO, 'apps/api/src/ledger.controller.ts': controller }),
    64 * 1024,
  );
  assert.equal(clustered.text.match(/calls LedgerService\.post\)/g)?.length, 1);
  assert.doesNotMatch(clustered.text, /Other import-linked callers/);
});

test('an all-shown claim needs a complete search and every match shown', async () => {
  const text = async (page: typeof PAGE, source: PackSourceProvider, budget = 64 * 1024) =>
    (await buildContextPack(page, new Set([page[0].filename]), source, budget)).text;
  const long = REPO['apps/api/src/ledger.service.ts'].replace(
    'key));',
    `key)); // ${'x'.repeat(2000)}`,
  );
  // A failed or capped search, an aliased import or export, or a cut caller excerpt.
  const capped = Array.from({ length: 51 }, () => ({ path: 'apps/api/src/format.ts', line: 1 }));
  for (const [source, budget] of [
    [{ ...provider(), references: () => Promise.reject(new Error('timeout')) }, 64 * 1024],
    [{ ...provider(), references: async () => capped }, 64 * 1024],
    [
      provider({
        ...REPO,
        'apps/api/src/format.ts': `${REPO['apps/api/src/format.ts']}\nexport { formatId as fmt };`,
      }),
      64 * 1024,
    ],
    [
      provider({
        ...REPO,
        'apps/api/src/alias.ts': "import { formatId as fmt } from './format';\nfmt('x');",
      }),
      64 * 1024,
    ],
    [provider({ ...REPO, 'apps/api/src/ledger.service.ts': long }), 1500],
  ] as const)
    assert.doesNotMatch(await text(FORMAT_PAGE, source, budget), /No references to/);
  // Member names collide across classes, so members never get the claim.
  assert.doesNotMatch(
    await text(PAGE, provider({ ...REPO, 'apps/api/src/legacy.ts': '' })),
    /No references to/,
  );
});
