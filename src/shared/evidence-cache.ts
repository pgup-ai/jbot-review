import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { resolveShardCacheDir } from './shard-cache.ts';

export const evidenceHash = (value: string) => createHash('sha256').update(value).digest('hex');
const MAX_ENTRY_BYTES = 256 * 1024;
const MAX_ENTRIES = 256;
const MAX_AGE_MS = 24 * 60 * 60_000;

export class EvidenceDiskCache {
  private directory?: string;
  hits = 0;
  misses = 0;
  writes = 0;
  constructor(workspace: string, directory?: string) {
    const safe = directory && resolveShardCacheDir(directory, workspace);
    if (safe) this.directory = join(safe, evidenceHash(resolve(workspace)));
  }

  get enabled() {
    return Boolean(this.directory);
  }

  async get(key: string): Promise<unknown> {
    if (!this.directory) return undefined;
    try {
      const handle = await open(
        join(this.directory, evidenceHash(key) + '.json'),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > MAX_ENTRY_BYTES || Date.now() - info.mtimeMs > MAX_AGE_MS)
          throw new Error('cache miss');
        const buffer = Buffer.alloc(MAX_ENTRY_BYTES + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > MAX_ENTRY_BYTES) throw new Error('cache miss');
        const value: unknown = JSON.parse(buffer.toString('utf8', 0, bytesRead));
        this.hits++;
        return value;
      } finally {
        await handle.close();
      }
    } catch {
      this.misses++;
      return undefined;
    }
  }

  async set(key: string, value: unknown): Promise<void> {
    if (!this.directory) return;
    const body = JSON.stringify(value);
    if (Buffer.byteLength(body) > MAX_ENTRY_BYTES) return;
    const temporary = join(this.directory, randomUUID() + '.tmp');
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await writeFile(temporary, body, { flag: 'wx', mode: 0o600 });
      await rename(temporary, join(this.directory, evidenceHash(key) + '.json'));
      this.writes++;
      const files = (await readdir(this.directory)).filter((name) =>
        /^[a-f0-9]{64}\.json$/.test(name),
      );
      if (files.length > MAX_ENTRIES) {
        const ages = await Promise.all(
          files.map(async (name) => ({
            name,
            time: (await stat(join(this.directory!, name))).mtimeMs,
          })),
        );
        ages.sort((a, b) => a.time - b.time);
        await Promise.all(
          ages
            .slice(0, files.length - MAX_ENTRIES)
            .map(({ name }) => rm(join(this.directory!, name), { force: true })),
        );
      }
    } catch {
      /* Optional persistence must never block a review. */
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}
