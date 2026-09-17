import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  basicAuthHeader,
  childEnv,
  parseServerBanner,
  resolveOpencodeBin,
  waitForModels,
} from '../src/shared/opencode-server.ts';
import { fakeOpencodeServer } from './support/opencode-fake.ts';

describe('parseServerBanner', () => {
  it('needs both the listening and password lines', () => {
    assert.equal(parseServerBanner('server listening on http://127.0.0.1:4096\n'), undefined);
    assert.deepEqual(
      parseServerBanner(
        'noise\nserver listening on http://127.0.0.1:4096\nserver password abc-DEF_1\n',
      ),
      { url: 'http://127.0.0.1:4096', password: 'abc-DEF_1' },
    );
  });
});

describe('basicAuthHeader', () => {
  it('encodes opencode:<password>', () => {
    assert.equal(basicAuthHeader('pw'), `Basic ${Buffer.from('opencode:pw').toString('base64')}`);
  });
});

describe('resolveOpencodeBin', () => {
  it('prefers the env override, then the pinned local binary, then PATH', () => {
    assert.equal(
      resolveOpencodeBin({ JBOT_OPENCODE_BIN: '/x/opencode' }, () => true),
      '/x/opencode',
    );
    assert.match(
      resolveOpencodeBin({}, () => true),
      /node_modules\/\.bin\/opencode$/,
    );
    assert.equal(
      resolveOpencodeBin({}, () => false),
      'opencode',
    );
  });
});

describe('childEnv', () => {
  const base = {
    PATH: '/bin',
    INPUT_GITHUB_TOKEN: 'gh',
    JBOT_OPENAI_API_KEY: 'jbot',
    STRIPE_SECRET: 's',
    LANG: 'C',
  };
  const common = {
    keys: { OPENAI_API_KEY: 'k' },
    config: { a: 1 },
    configHome: '/cfg',
    dataHome: '/data',
    sessionOptionsFile: '/data/jbot-session-options.json',
  };

  it('scrubs credentials, adds provider keys, and pins the hermetic V2 variables', () => {
    const env = childEnv({ base, scrub: true, ...common, proxyEnv: { HTTPS_PROXY: 'http://p' } });
    assert.deepEqual(env, {
      PATH: '/bin',
      LANG: 'C',
      HTTPS_PROXY: 'http://p',
      OPENAI_API_KEY: 'k',
      OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      XDG_CONFIG_HOME: '/cfg',
      XDG_DATA_HOME: '/data',
      OPENCODE_CONFIG_CONTENT: '{"a":1}',
      JBOT_OPENCODE_SESSION_OPTIONS: '/data/jbot-session-options.json',
    });
  });

  it('keeps inherited credentials when the scrub is off (multi-run app)', () => {
    const env = childEnv({ base, scrub: false, ...common });
    assert.equal(env.INPUT_GITHUB_TOKEN, 'gh');
    assert.equal(env.OPENAI_API_KEY, 'k');
  });
});

describe('waitForModels', () => {
  it('resolves once every requested model is listed and names the missing ones otherwise', async () => {
    const fake = fakeOpencodeServer(() => ({ text: '' }), {
      models: [{ providerID: 'openai', id: 'gpt-5' }],
    });
    await waitForModels(fake.client, '/ws', ['openai/gpt-5'], 200);
    await assert.rejects(
      waitForModels(fake.client, '/ws', ['openai/gpt-5', 'anthropic/claude'], 50),
      /anthropic\/claude/,
    );
  });
});
