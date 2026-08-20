import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

const workflow = readFileSync(
  new URL('../.github/workflows/jbot-review.yml', import.meta.url),
  'utf8',
);
const proxyStep = workflow
  .split('\n      - name: Check optional OpenCode proxy\n')[1]
  ?.split('\n      - uses: ./\n')[0];
const proxyScript = proxyStep
  ?.split('\n        run: |\n')[1]
  ?.split('\n')
  .map((line) => line.replace(/^ {10}/, ''))
  .join('\n');

assert.ok(proxyScript);

function checkProxy(proxyUrl = '', proxyIp = '', dockerStatus = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'jbot-proxy-'));
  const outputPath = join(dir, 'output');
  const dockerPath = join(dir, 'docker');
  writeFileSync(outputPath, '');
  writeFileSync(dockerPath, '#!/bin/sh\nprintf %s "$FAKE_PROXY_IP"\nexit "$FAKE_DOCKER_STATUS"\n');
  chmodSync(dockerPath, 0o755);
  try {
    const result = spawnSync('/bin/bash', ['-c', proxyScript], {
      encoding: 'utf8',
      env: {
        HTTPS_PROXY: proxyUrl,
        NO_PROXY: 'localhost,127.0.0.1',
        GITHUB_OUTPUT: outputPath,
        FAKE_PROXY_IP: proxyIp,
        FAKE_DOCKER_STATUS: String(dockerStatus),
        PATH: dir,
      },
    });
    return {
      status: result.status,
      output: readFileSync(outputPath, 'utf8').trim(),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('optional OpenCode proxy', () => {
  it('stays disabled when the secret is absent', () => {
    const result = checkProxy();

    assert.equal(result.status, 0);
    assert.equal(result.output, 'enabled=false');
  });

  it('enables the proxy after a successful egress check', () => {
    const result = checkProxy('http://user:pass@proxy.example:50100', '203.0.113.10');

    assert.equal(result.status, 0);
    assert.equal(result.output, 'enabled=true');
  });

  it('fails open when proxy verification fails', () => {
    const result = checkProxy('http://user:pass@proxy.example:50100', '', 1);

    assert.equal(result.status, 0);
    assert.equal(result.output, 'enabled=false');
  });

  it('injects the proxy only after verification', () => {
    assert.match(
      workflow,
      /HTTPS_PROXY: \$\{\{ steps\.proxy_check\.outputs\.enabled == 'true' && secrets\.OPENCODE_PROXY_URL \|\| '' \}\}/,
    );
  });
});
