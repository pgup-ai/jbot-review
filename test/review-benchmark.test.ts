import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

const ROOT = resolve(import.meta.dirname, '..');
const MANIFEST = join(ROOT, 'test/fixtures/review-benchmark/manifest.json');
const TSX = join(ROOT, 'node_modules/.bin/tsx');

describe('review-benchmark', () => {
  it('rejects an undeclared reasoning mismatch before executing a runner', () => {
    const root = mkdtempSync(join(tmpdir(), 'jbot-benchmark-test-'));
    try {
      const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as {
        treatment: { configuration: { reasoningEffort: string } };
      };
      manifest.treatment.configuration.reasoningEffort = 'low';
      const path = join(root, 'manifest.json');
      writeFileSync(path, JSON.stringify(manifest));
      assert.throws(
        () =>
          execFileSync(
            TSX,
            [
              join(ROOT, 'scripts/review-benchmark.ts'),
              '--manifest',
              path,
              '--output',
              join(root, 'output'),
            ],
            { encoding: 'utf8', stdio: 'pipe' },
          ),
        (error: unknown) => {
          const stderr = (error as { stderr?: string }).stderr ?? '';
          assert.match(stderr, /undeclared difference\(s\): reasoningEffort/);
          return true;
        },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
