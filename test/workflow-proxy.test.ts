import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { sdkEngineForProxy, verifyOpencodeProxy } from '../src/workflow/proxy.ts';

const action = readFileSync(new URL('../action.yml', import.meta.url), 'utf8');
const workflow = readFileSync(
  new URL('../.github/workflows/jbot-review.yml', import.meta.url),
  'utf8',
);
const proxyEnv = {
  HTTPS_PROXY: 'http://user:pass@proxy.example:50100',
  NO_PROXY: 'localhost,127.0.0.1',
};
const log = { info() {}, warning() {} };

describe('optional OpenCode proxy', () => {
  it('does not check an absent proxy or expose one to a fork-head PR', async () => {
    let checks = 0;
    const check = async () => {
      checks += 1;
      return '203.0.113.10';
    };

    assert.deepEqual(await verifyOpencodeProxy({}, true, log, check), {});
    assert.deepEqual(await verifyOpencodeProxy(proxyEnv, false, log, check), {});
    assert.equal(checks, 0);
  });

  it('returns the proxy environment after a successful egress check', async () => {
    assert.equal(
      await verifyOpencodeProxy(proxyEnv, true, log, async (env) => {
        assert.equal(env, proxyEnv);
        return '203.0.113.10';
      }),
      proxyEnv,
    );
    assert.equal(sdkEngineForProxy('auto', proxyEnv), 'opencode');
  });

  it('fails open on failed or invalid egress checks', async () => {
    assert.deepEqual(
      await verifyOpencodeProxy(proxyEnv, true, log, async () => {
        throw new Error('unreachable');
      }),
      {},
    );
    for (const response of ['', 'not-an-ip']) {
      assert.deepEqual(await verifyOpencodeProxy(proxyEnv, true, log, async () => response), {});
    }
    assert.equal(sdkEngineForProxy('auto', {}), 'auto');
  });

  it('maps the public input to the scoped runtime contract', () => {
    const input = action.split('\n  opencode-proxy-url:\n')[1]?.split('\n  opencode-api-key:\n')[0];

    assert.ok(input);
    assert.match(input, /default: ''/);
    assert.match(action, /JBOT_OPENCODE_HTTPS_PROXY: \$\{\{ inputs\.opencode-proxy-url \}\}/);
    assert.match(
      workflow,
      /EVENT_HEAD_REPO: \$\{\{ github\.event\.pull_request\.head\.repo\.full_name \}\}/,
    );
    assert.match(workflow, /\.head\.repo\.full_name \/\/ empty/);
    assert.match(workflow, /\[ "\$head_repo" = "\$REPOSITORY" \]/);
    assert.match(
      workflow,
      /opencode-proxy-url: \$\{\{ steps\.pr\.outputs\.same_repo == 'true' && secrets\.OPENCODE_PROXY_URL \|\| '' \}\}/,
    );
    assert.doesNotMatch(workflow, /steps\.proxy_check|Check optional OpenCode proxy/);
  });
});
