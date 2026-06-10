import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { buildReviewContext, discoverGuidelines } from '../src/shared/review-context.ts';
import type { ReviewCommit } from '../src/shared/review-context.ts';

interface ReplayPullRequest {
  title: string;
  body: string;
  baseRef?: string;
  baseSha?: string;
  headSha?: string;
}

interface ReplayFile {
  filename: string;
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    warnUnlessMissing(path, error);
    return fallback;
  }
}

async function readText(path: string, fallback: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    warnUnlessMissing(path, error);
    return fallback;
  }
}

function warnUnlessMissing(path: string, error: unknown): void {
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`Warning: ${path}: ${message}`);
}

const fixtureDir = process.argv[2] ?? 'fixtures/replay';
const pr = await readJson<ReplayPullRequest>(join(fixtureDir, 'pr.json'), {
  title: 'Replay PR',
  body: '',
});
const files = await readJson<ReplayFile[]>(join(fixtureDir, 'files.json'), []);
const priorComments = await readJson<string[]>(join(fixtureDir, 'comments.json'), []);
const commits = await readJson<ReviewCommit[]>(join(fixtureDir, 'commits.json'), []);
const checkSummary = await readText(
  join(fixtureDir, 'checks.txt'),
  'No check summary fixture provided.',
);
const changedFiles = files.map((file) => file.filename);
const guidelines = await discoverGuidelines(fixtureDir, changedFiles);

const context = buildReviewContext({
  pullTitle: pr.title,
  pullBody: pr.body,
  changedFiles,
  priorComments,
  commits,
  checkSummary: checkSummary.trim(),
  guidelines,
  diffScope: { baseRef: pr.baseRef, baseSha: pr.baseSha, headSha: pr.headSha },
});

console.log(context);
