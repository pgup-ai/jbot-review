import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';

import {
  MAX_BLAST_SYMBOLS,
  buildBlastRadiusBlock,
  extractChangedExportedSymbols,
} from '../src/shared/blast-radius.ts';
import type { PrFile } from '../src/shared/github.ts';

const execFileAsync = promisify(execFile);

describe('extractChangedExportedSymbols', () => {
  it('extracts exported declarations from added lines only', () => {
    const patch = [
      '@@ -1,4 +1,8 @@',
      '+export function addedFn(a: number) {',
      '+export const addedConst = 1;',
      '+export async function addedAsync() {',
      '+export interface AddedShape {',
      '-export function removedFn() {',
      ' export function contextFn() {',
      '+const internal = 2;',
    ].join('\n');

    const symbols = extractChangedExportedSymbols([{ filename: 'src/a.ts', patch }]);

    assert.deepEqual(symbols, ['addedFn', 'addedConst', 'addedAsync', 'AddedShape']);
  });

  it('handles default exports, generators, and abstract classes', () => {
    const patch = [
      '@@ -1,1 +1,4 @@',
      '+export default function main() {',
      '+export function* makeThings() {',
      '+export abstract class BaseStore {',
    ].join('\n');

    const symbols = extractChangedExportedSymbols([{ filename: 'src/a.ts', patch }]);

    assert.deepEqual(symbols, ['main', 'makeThings', 'BaseStore']);
  });

  it('extracts named export lists and aliases from added lines', () => {
    const patch = [
      '@@ -1,1 +1,4 @@',
      '+export { rawName, localName as exportedName };',
      '+export type { Shape, Internal as PublicShape };',
      '+export * from "./elsewhere.ts";',
    ].join('\n');

    const symbols = extractChangedExportedSymbols([{ filename: 'src/a.ts', patch }]);

    assert.deepEqual(symbols, ['rawName', 'exportedName', 'Shape', 'PublicShape']);
  });

  it('ignores files without patches', () => {
    assert.deepEqual(extractChangedExportedSymbols([{ filename: 'src/a.ts' }]), []);
  });

  it('includes removed/renamed exports when includeRemoved is set', () => {
    const patch = [
      '@@ -1,2 +1,1 @@',
      '+export const kept = 1;',
      '-export function removedFn() {',
      '-export { gone };',
    ].join('\n');
    const file: PrFile = { filename: 'src/a.ts', patch };

    assert.deepEqual(extractChangedExportedSymbols([file]), ['kept']);
    assert.deepEqual(extractChangedExportedSymbols([file], { includeRemoved: true }), [
      'kept',
      'removedFn',
      'gone',
    ]);
  });
});

describe('buildBlastRadiusBlock', () => {
  const files: PrFile[] = [
    { filename: 'src/a.ts', patch: '@@ -1,1 +1,1 @@\n+export function changedFn() {' },
  ];

  it('lists only call sites outside the changed files', async () => {
    const block = await buildBlastRadiusBlock('/ws', files, async () => [
      'src/a.ts',
      'src/caller.ts',
      'src/other-caller.ts',
    ]);

    assert.match(block, /## Changed symbol usage/);
    assert.match(
      block,
      /`changedFn` — referenced by unchanged: src\/caller\.ts, src\/other-caller\.ts/,
    );
    assert.doesNotMatch(block, /unchanged: src\/a\.ts/);
  });

  it('returns empty when every reference lives in changed files', async () => {
    const block = await buildBlastRadiusBlock('/ws', files, async () => ['src/a.ts']);

    assert.equal(block, '');
  });

  it('caps the listed call sites per symbol with a remainder note', async () => {
    const callers = Array.from({ length: 12 }, (_, i) => `src/c${i}.ts`);
    const block = await buildBlastRadiusBlock('/ws', files, async () => callers);

    assert.match(block, /\+4 more/);
  });

  it('returns empty instead of throwing when grep fails', async () => {
    const block = await buildBlastRadiusBlock('/ws', files, async () => {
      throw new Error('git exploded');
    });

    assert.equal(block, '');
  });

  it('greps at most MAX_BLAST_SYMBOLS symbols', async () => {
    const patch = [
      '@@ -1,1 +1,30 @@',
      ...Array.from({ length: MAX_BLAST_SYMBOLS + 5 }, (_, i) => `+export const sym${i} = ${i};`),
    ].join('\n');
    const grepped: string[] = [];
    await buildBlastRadiusBlock('/ws', [{ filename: 'src/a.ts', patch }], async (_, symbol) => {
      grepped.push(symbol);
      return ['src/elsewhere.ts'];
    });

    assert.equal(grepped.length, MAX_BLAST_SYMBOLS);
  });

  it('lists when exported symbols are omitted by the symbol cap', async () => {
    const patch = [
      '@@ -1,1 +1,30 @@',
      ...Array.from({ length: MAX_BLAST_SYMBOLS + 5 }, (_, i) => `+export const sym${i} = ${i};`),
    ].join('\n');

    const block = await buildBlastRadiusBlock(
      '/ws',
      [{ filename: 'src/a.ts', patch }],
      async () => ['src/elsewhere.ts'],
    );

    assert.match(block, new RegExp(`Showing ${MAX_BLAST_SYMBOLS} of ${MAX_BLAST_SYMBOLS + 5}`));
  });

  // The production grep path: git grep exits 1 on "no matches", which must
  // be treated as an empty result. If that regressed, the outer fail-open
  // catch would silently erase the WHOLE block whenever any symbol had zero
  // call sites — only a real-git test can catch it.
  it('handles hits and no-match exit codes through real git grep', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'jbot-blast-radius-'));
    try {
      await execFileAsync('git', ['init', '-q'], { cwd: repo });
      await mkdir(join(repo, 'src'), { recursive: true });
      await writeFile(join(repo, 'src', 'a.ts'), 'export function changedFn() {}\n');
      await writeFile(join(repo, 'src', 'caller.ts'), 'import { changedFn } from "./a.ts";\n');
      await writeFile(join(repo, 'src', 'dollar.ts'), 'import { foo$ } from "./a.ts";\n');
      await execFileAsync('git', ['add', '-A'], { cwd: repo });

      const block = await buildBlastRadiusBlock(repo, [
        {
          filename: 'src/a.ts',
          // ghostFn exists only in the patch, not the worktree: its grep
          // exits 1 (no matches) and must not poison changedFn's result.
          patch:
            '@@ -1,1 +1,3 @@\n+export function changedFn() {\n+export function ghostFn() {\n+export const foo$ = 1;',
        },
      ]);

      assert.match(block, /`changedFn` — referenced by unchanged: src\/caller\.ts/);
      assert.match(block, /`foo\$` — referenced by unchanged: src\/dollar\.ts/);
      assert.doesNotMatch(block, /ghostFn/);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
