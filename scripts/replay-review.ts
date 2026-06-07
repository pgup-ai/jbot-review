import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { buildReviewContext, discoverGuidelines } from '../src/shared/review-context.ts';
import type { ReviewCommit } from '../src/shared/review-context.ts';

interface ReplayPullRequest {
  title: string;
  body: string;
}

interface ReplayFile {
  filename: string;
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

async function readText(path: string, fallback: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return fallback;
  }
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
const guidelines = await discoverGuidelines(fixtureDir);

const context = buildReviewContext({
  pullTitle: pr.title,
  pullBody: pr.body,
  changedFiles: files.map((file) => file.filename),
  priorComments,
  commits,
  checkSummary: checkSummary.trim(),
  guidelines,
});

console.log(context);
