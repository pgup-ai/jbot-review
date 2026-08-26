import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { PROVIDERS } from '../src/shared/config.ts';

const catalog = readFileSync(new URL('../MODEL_CATALOG.md', import.meta.url), 'utf8');
const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');

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
    assert.doesNotMatch(catalog, /`poolside\/poolside\//);
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
      'dim',
      'kilo',
    ]) {
      const section = catalog.split(`### \`${providerID}\``)[1]?.split('\n### ')[0];
      assert.ok(section, `missing ${providerID} catalog section`);
      assert.match(section, /- Source:/);
      assert.ok(section.includes(`- \`${providerID}/`));
    }

    assert.match(catalog, /`codex debug models`/);
    assert.match(catalog, /`grok models`/);
    assert.match(catalog, /authenticated remote catalog/);
    assert.doesNotMatch(catalog, /`kilo\/kilo\/[^`]+`/);
  });

  // Nothing but a text match links the catalog's claimed pins to the Dockerfile:
  // #100 swapped `@openai/codex` for the ACP adapter, and the generator threw on
  // every run after that while the stale file kept looking fine.
  it('sources every CLI snapshot from a package the Dockerfile still pins', () => {
    // Scoped names carry their own `@`, so the version is whatever follows the last one.
    const splitPin = (token: string): [string, string] => {
      const at = token.lastIndexOf('@');
      return [token.slice(0, at), token.slice(at + 1)];
    };
    const pins = new Map(
      [...dockerfile.matchAll(/npm install -g (.*)/g)]
        .flatMap((match) => match[1].split(/\s+/))
        .filter((token) => token.lastIndexOf('@') > 0)
        .map(splitPin),
    );
    const claims = [...catalog.matchAll(/Docker-pinned npm package \[`([^`]+)`\]/g)].map((match) =>
      splitPin(match[1]),
    );

    // Enumerated so a provider cannot quietly drop its source line. Deduped
    // because cline-pass is served by Cline's package and claims it too.
    assert.deepEqual([...new Set(claims.map(([pkg]) => pkg))].sort(), [
      '@agentclientprotocol/codex-acp',
      '@kilocode/cli',
      '@qoder-ai/qodercli',
      '@xai-official/grok',
      'cline',
      'command-code',
      'dimcode',
    ]);
    for (const [pkg, version] of claims) {
      assert.equal(pins.get(pkg), version, `${pkg} claims ${version}`);
    }
  });

  it('documents the one non-enumerable CLI boundary', () => {
    const devin = catalog.split('### `devin`')[1]?.split('\n### ')[0];
    assert.ok(devin);
    assert.match(devin, /no machine-readable or non-interactive list/);
    assert.match(devin, /`devin\/default`/);
  });
});
