import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { PROVIDERS } from '../src/shared/config.ts';

const catalog = readFileSync(new URL('../MODEL_CATALOG.md', import.meta.url), 'utf8');

describe('model catalog', () => {
  it('covers every centralized provider exactly once', () => {
    const headings = [...catalog.matchAll(/^### `([^`]+)`$/gm)].map((match) => match[1]);
    assert.deepEqual(headings.sort(), Object.keys(PROVIDERS).sort());
  });

  it('includes every configured default and keeps the custom provider explicit', () => {
    for (const provider of Object.values(PROVIDERS)) {
      if (provider.defaultModel) assert.ok(catalog.includes(`\`${provider.defaultModel}\``));
    }
    assert.match(catalog, /`openai-compatible\/<endpoint-model-id>`/);
    assert.match(catalog, /does not invent or probe a default/);
  });

  it('publishes sourced CLI snapshots with copyable J-Bot values', () => {
    for (const providerID of [
      'commandcode',
      'cursor',
      'qoder',
      'codex',
      'cline',
      'cline-pass',
      'grok',
      'kilo',
      'poolside',
    ]) {
      const section = catalog.split(`### \`${providerID}\``)[1]?.split('\n### ')[0];
      assert.ok(section, `missing ${providerID} catalog section`);
      assert.match(section, /- Source:/);
      assert.ok(section.includes(`- \`${providerID}/`));
    }

    assert.match(catalog, /`codex debug models`/);
    assert.match(catalog, /`grok models`/);
    assert.match(catalog, /authenticated remote catalog/);
    assert.match(catalog, /interactive `\/model` picker/);
    assert.doesNotMatch(catalog, /pool agents list/);
    assert.doesNotMatch(catalog, /`kilo\/kilo\/[^`]+`/);
  });

  it('documents the one non-enumerable CLI boundary', () => {
    const devin = catalog.split('### `devin`')[1]?.split('\n### ')[0];
    assert.ok(devin);
    assert.match(devin, /no machine-readable or non-interactive list/);
    assert.match(devin, /`devin\/default`/);
  });
});
