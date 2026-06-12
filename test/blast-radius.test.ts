import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildBlastRadiusBlock,
  extractChangedExportedSymbols,
} from '../src/shared/blast-radius.ts';
import type { PrFile } from '../src/shared/github.ts';

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

  it('ignores files without patches', () => {
    assert.deepEqual(extractChangedExportedSymbols([{ filename: 'src/a.ts' }]), []);
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
});
