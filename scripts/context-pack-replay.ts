import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildContextPack } from '../src/shared/context-pack.ts';
import { EvidenceStore } from '../src/shared/evidence.ts';
import { isNoiseFile } from '../src/shared/filter.ts';
import { GIT_DIFF_ARGS, parseGitDiff } from '../src/shared/git.ts';
import { suppliedOverlap, type SuppliedContext } from '../src/shared/review-read-locations.ts';
import { benchmarkArgument } from './benchmark-args.ts';

/**
 * One historical run: head, base, pack budget and each main session's logged calls (ms).
 * Calls come from CI `<label> tool: key=value` lines (key: the call's first string argument,
 * value cut at 120 chars); `start`/`end` bracket the session; paths are under /github/workspace.
 */
interface ReplayRun {
  id: string;
  head: string;
  base: string;
  /**
   * Live pack budget: the sum over pages of min(64 KiB, input capacity - page prompt without
   * caller evidence - 1 KiB), from the run's logs.
   */
  packBytes: number;
  sessions: {
    label: string;
    start: number;
    end: number;
    calls: { t: number; key: string; value: string }[];
  }[];
}

// Calls are logged when made: a turn's calls land milliseconds apart, turns a second or more.
const TURN_GAP_MS = 500;
const CI_WORKSPACE = '/github/workspace';

const runsPath = benchmarkArgument('runs');
const repository = benchmarkArgument('repo');
if (!runsPath || !repository)
  throw new Error(
    'usage: context-pack-replay.ts --runs <runs.jsonl> --repo <clone holding the run heads>',
  );

const TOOLS: Record<string, string> = { path: 'read', pattern: 'grep', command: 'shell' };

/** The live re-read counter's verdict; a path-only log counts as a whole-file read. */
function answered(call: { key: string; value: string }, supplied: SuppliedContext): boolean {
  const tool = TOOLS[call.key];
  return (
    Boolean(tool) &&
    suppliedOverlap(CI_WORKSPACE, tool, { [call.key]: call.value }, supplied) !== false
  );
}

/** Upper bound: every file the pack touches counts as fully supplied. */
const wholeFiles = (supplied: SuppliedContext): SuppliedContext => ({
  ...supplied,
  ranges: new Map<string, [number, number][]>(
    [...supplied.lines].map(([path, lines]) => [path, [[1, lines]]]),
  ),
});

let turns = 0;
let sessionMs = 0;
const bounds = { answered: { turns: 0, ms: 0 }, touched: { turns: 0, ms: 0 } };
const detail: { id: string; buildMs?: number; state?: string; error?: string }[] = [];
for (const line of readFileSync(runsPath, 'utf8').split('\n').filter(Boolean)) {
  const run = JSON.parse(line) as ReplayRun;
  const root = mkdtempSync(join(tmpdir(), 'context-pack-replay-'));
  const workspace = join(root, 'workspace');
  try {
    if (
      !run.sessions.every(
        (s) =>
          Number.isFinite(s.start) &&
          Number.isFinite(s.end) &&
          s.calls.every((c) => Number.isFinite(c.t)),
      )
    )
      throw new Error('non-numeric session or call time');
    if (!Number.isFinite(run.packBytes) || run.packBytes < 0) throw new Error('invalid packBytes');
    execFileSync('git', [
      '-C',
      repository,
      'worktree',
      'add',
      '--detach',
      '--quiet',
      workspace,
      run.head,
    ]);
    const files = parseGitDiff(
      execFileSync('git', ['-C', workspace, ...GIT_DIFF_ARGS, `${run.base}...${run.head}`], {
        encoding: 'utf8',
        maxBuffer: 512 * 1024 * 1024,
      }),
    ).filter((file) => file.patch && !isNoiseFile(file.filename));
    const started = Date.now();
    const provider = await new EvidenceStore(workspace, files).packProvider(
      AbortSignal.timeout(5000),
    );
    // Page assignments are not logged, so a multi-page run is scored at PR level.
    const pack = await buildContextPack(
      files,
      new Set(files.map((file) => file.filename)),
      provider,
      run.packBytes,
    );
    const buildMs = Date.now() - started;
    // Like addContextPack: a pack without a code slice is not served.
    const served = pack.slices.surrounding || pack.slices.definitions || pack.slices.callers;
    const views = [
      [bounds.answered, pack.supplied],
      [bounds.touched, wholeFiles(pack.supplied)],
    ] as const;
    for (const session of run.sessions) {
      let previous = session.start;
      let turn: typeof session.calls = [];
      const close = () => {
        if (!turn.length) return;
        turns++;
        for (const [bound, supplied] of views)
          if (served && turn.every((call) => answered(call, supplied))) {
            bound.turns++;
            bound.ms += turn[0].t - previous;
          }
        previous = turn.at(-1)!.t;
        turn = [];
      };
      for (const call of [...session.calls].sort((a, b) => a.t - b.t)) {
        if (turn.length && call.t - turn.at(-1)!.t > TURN_GAP_MS) close();
        turn.push(call);
      }
      close();
      turns++; // the final answer turn
      sessionMs += session.end - session.start;
    }
    detail.push({ id: run.id, buildMs, state: served ? pack.state : 'empty' });
  } catch (error) {
    detail.push({ id: run.id, error: String(error).slice(0, 200) });
  } finally {
    spawnSync('git', ['-C', repository, 'worktree', 'remove', '--force', workspace], {
      stdio: 'ignore',
    });
    rmSync(root, { recursive: true, force: true });
  }
}
const built = detail.flatMap((run) => (run.buildMs === undefined ? [] : [run.buildMs]));
const p90 = built.sort((a, b) => a - b)[Math.floor(0.9 * (built.length - 1))] ?? 0;
console.log(
  JSON.stringify(
    {
      runs: detail.length,
      failedRuns: detail.filter((run) => run.error).length,
      turns,
      answeredTurnShare: turns ? bounds.answered.turns / turns : 0,
      answeredTimeShare: sessionMs ? bounds.answered.ms / sessionMs : 0,
      touchedTurnShare: turns ? bounds.touched.turns / turns : 0,
      touchedTimeShare: sessionMs ? bounds.touched.ms / sessionMs : 0,
      buildMsP90: p90,
      emptyPacks: detail.filter((run) => run.state === 'empty').length,
      detail,
    },
    null,
    2,
  ),
);
