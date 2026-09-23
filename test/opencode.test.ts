import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  abortOpencodeSessionsByLabel,
  parseChangesSinceLastReviewSummary,
  sessionEnvDenyKeys,
  takeOpencodeProxyEnv,
  withCredentialEnvWithheld,
} from '../src/shared/opencode.ts';
import {
  recordAssistantTools,
  registerOpencodeSessionForAbort,
  unregisterOpencodeSessionForAbort,
} from '../src/shared/opencode-session.ts';
import { fakeOpencodeServer } from './support/opencode-fake.ts';

const noop = () => {};

describe('recordAssistantTools', () => {
  it('records completed and errored V2 tool content and one session finish', () => {
    const rows: unknown[] = [];
    const telemetry = {
      startTool: (input: unknown) => (finish: unknown) => rows.push({ input, finish }),
      finishSession: (input: unknown) => rows.push({ session: input }),
    } as never;
    recordAssistantTools(telemetry, 'review', [
      {
        id: 'm1',
        type: 'assistant',
        time: { created: 1, completed: 2 },
        content: [
          {
            type: 'tool',
            id: 't1',
            name: 'read',
            state: {
              status: 'completed',
              input: { filePath: 'a.ts' },
              content: [{ type: 'text', text: 'x' }],
            },
            time: { created: 1, completed: 3 },
          },
          {
            type: 'tool',
            id: 't2',
            name: 'shell',
            state: { status: 'error', input: { command: 'git diff' }, error: 'nope' },
            time: { created: 1 },
          },
          {
            type: 'tool',
            id: 't3',
            name: 'grep',
            state: { status: 'running', input: {} },
            time: { created: 1 },
          },
          {
            type: 'tool',
            id: 't4',
            name: 'shell',
            state: {
              status: 'completed',
              input: {
                command: 'git --literal-pathspecs -c diff.noprefix=false diff HEAD -- a.ts b.ts',
              },
              content: [
                {
                  type: 'text',
                  text: 'diff --git a/a.ts b/a.ts\n+new\ndiff --git a/b.ts b/b.ts\n+new',
                },
              ],
            },
            time: { created: 1, completed: 3 },
          },
        ],
      },
    ]);
    const [read, shell, batch, session] = rows as Array<{
      input?: { toolClass: string; diffScope?: string };
      finish?: {
        success: boolean;
        failureClass?: string;
        durationMs?: number;
        diffFileHeaders?: number;
      };
      session?: { turnCount?: number };
    }>;
    assert.equal(rows.length, 4);
    assert.doesNotMatch(JSON.stringify(rows), /git diff|nope|"x"/, 'raw tool data never persists');
    assert.equal(read!.finish!.success, true);
    assert.equal(read!.finish!.durationMs, 2);
    assert.equal(shell!.input!.diffScope, 'whole');
    // 'shell' reaches the classifier as bash, so its `git diff` command classifies as diff-recovery.
    assert.equal(shell!.input!.toolClass, 'diff-recovery');
    assert.equal(shell!.finish!.failureClass, 'execution');
    assert.equal(shell!.finish!.diffFileHeaders, undefined);
    assert.equal(batch!.input!.toolClass, 'diff-recovery');
    assert.equal(batch!.finish!.diffFileHeaders, 2);
    assert.equal(session!.session!.turnCount, 1);
  });

  it('marks reads and searches of context-pack ranges for the session that got the pack', () => {
    const starts: { supplied?: unknown }[] = [];
    let finished: { suppliedTracked?: boolean } | undefined;
    const telemetry = {
      startTool: (input: { supplied?: unknown }) => {
        starts.push(input);
        return () => {};
      },
      finishSession: (input: { suppliedTracked?: boolean }) => {
        finished = input;
      },
    } as never;
    const tool = (id: string, name: string, input: Record<string, unknown>) => ({
      type: 'tool',
      id,
      name,
      state: { status: 'completed', input, content: [] },
      time: { created: 1, completed: 2 },
    });
    recordAssistantTools(
      telemetry,
      'review',
      [
        {
          id: 'm1',
          type: 'assistant',
          time: { created: 1, completed: 2 },
          content: [
            tool('t1', 'read', { path: '/w/src/a.ts', offset: 10, limit: 5 }),
            tool('t2', 'grep', { pattern: 'LedgerService' }),
            tool('t3', 'read', { path: '/w/src/b.ts' }),
          ],
        },
      ] as never,
      {
        supplied: {
          workspace: '/w',
          context: {
            ranges: new Map<string, [number, number][]>([['src/a.ts', [[12, 20]]]]),
            lines: new Map([['src/a.ts', 400]]),
            symbols: new Set(['LedgerService']),
            directories: new Set(),
          },
        },
      },
    );
    assert.deepEqual(
      starts.map((start) => start.supplied),
      ['read', 'search', false],
    );
    assert.equal(finished?.suppliedTracked, true);
  });
});

describe('parseChangesSinceLastReviewSummary', () => {
  it('extracts the summary string from a valid object', () => {
    const out = parseChangesSinceLastReviewSummary(
      '{"summary":"- did a thing"}',
      'changes-since',
      noop,
    );
    assert.equal(out, '- did a thing');
  });

  it('returns empty string on unparseable output (fail open, omit the block)', () => {
    const out = parseChangesSinceLastReviewSummary('not json at all', 'changes-since', noop);
    assert.equal(out, '');
  });

  it('returns empty string when summary is missing or not a string', () => {
    assert.equal(parseChangesSinceLastReviewSummary('{"findings":[]}', 'changes-since', noop), '');
    assert.equal(parseChangesSinceLastReviewSummary('{"summary":42}', 'changes-since', noop), '');
    assert.throws(
      () =>
        parseChangesSinceLastReviewSummary('not json at all', 'changes-since', noop, {
          strict: true,
        }),
      /unparseable JSON/,
    );
    assert.throws(
      () =>
        parseChangesSinceLastReviewSummary('{"summary":42}', 'changes-since', noop, {
          strict: true,
        }),
      /summary string/,
    );
  });
});

describe('sessionEnvDenyKeys', () => {
  it('strips action inputs, GitHub tokens, and credential-suffixed vars — nothing else', () => {
    const keys = [
      'INPUT_GITHUB-TOKEN',
      'INPUT_MODEL',
      'GITHUB_TOKEN',
      'GH_TOKEN',
      'OPENROUTER_API_KEY',
      'KILO_AUTH_CONTENT',
      'CODEX_AUTH_JSON',
      'DIM_AUTH_BUNDLE',
      'COMMANDCODE_ACCESS_KEY',
      'AWS_ACCESS_KEY_ID',
      'APP_WEBHOOK_SECRET',
      'GITHUB_APP_PRIVATE_KEY',
      'SERVICE_PASSWORD',
      // Credential-bearing names that no fixed suffix list catches.
      'STRIPE_SECRET_KEY',
      'API_KEY',
      'DATABASE_DSN',
      'GCP_CREDENTIALS',
      'PATH',
      'HOME',
      'JBOT_OPENCODE_PORT',
      // Ends in a credential WORD only as a prefix — must survive.
      'TOKENIZERS_PARALLELISM',
      'KEYCHAIN_PATH',
    ];
    assert.deepEqual(sessionEnvDenyKeys(keys), [
      'INPUT_GITHUB-TOKEN',
      'INPUT_MODEL',
      'GITHUB_TOKEN',
      'GH_TOKEN',
      'OPENROUTER_API_KEY',
      'KILO_AUTH_CONTENT',
      'CODEX_AUTH_JSON',
      'DIM_AUTH_BUNDLE',
      'COMMANDCODE_ACCESS_KEY',
      'AWS_ACCESS_KEY_ID',
      'APP_WEBHOOK_SECRET',
      'GITHUB_APP_PRIVATE_KEY',
      'SERVICE_PASSWORD',
      'STRIPE_SECRET_KEY',
      'API_KEY',
      'DATABASE_DSN',
      'GCP_CREDENTIALS',
    ]);
  });

  it('withholds credentials for one scope and restores them on failure', async () => {
    const env = { NVIDIA_API_KEY: 'selected-key', SAFE_SETTING: 'kept' };
    const selectedKey = env.NVIDIA_API_KEY;
    await assert.rejects(
      withCredentialEnvWithheld(async () => {
        assert.equal(env.NVIDIA_API_KEY, undefined);
        assert.equal(env.SAFE_SETTING, 'kept');
        assert.equal(selectedKey, 'selected-key');
        throw new Error('stop');
      }, env),
      /stop/,
    );
    assert.deepEqual(env, { NVIDIA_API_KEY: 'selected-key', SAFE_SETTING: 'kept' });
  });
});

describe('takeOpencodeProxyEnv', () => {
  it('removes the internal values and returns only the OpenCode child environment', () => {
    const env = {
      JBOT_OPENCODE_HTTPS_PROXY: ' http://proxy.example:50100 ',
      JBOT_OPENCODE_NO_PROXY: ' localhost,127.0.0.1 ',
      PATH: '/bin',
    };
    assert.deepEqual(takeOpencodeProxyEnv(env), {
      HTTPS_PROXY: 'http://proxy.example:50100',
      NO_PROXY: 'localhost,127.0.0.1',
    });
    assert.deepEqual(env, { PATH: '/bin' });
    const defaultBypass = { JBOT_OPENCODE_HTTPS_PROXY: 'http://proxy.example:50100' };
    assert.deepEqual(takeOpencodeProxyEnv(defaultBypass), {
      HTTPS_PROXY: 'http://proxy.example:50100',
      NO_PROXY: 'localhost,127.0.0.1',
    });
    assert.deepEqual(defaultBypass, {});
    assert.deepEqual(takeOpencodeProxyEnv({}), {});
  });
});

describe('grace-abandon session abort (TASK-076)', () => {
  it('interrupts registered sessions by label and ignores unknown labels', async () => {
    const fake = fakeOpencodeServer(() => ({ hang: true }));
    const { client } = fake;
    const session = await client.session.create({ location: { directory: '/ws' }, agent: 'plan' });

    registerOpencodeSessionForAbort(client, 'guideline-compliance', session.id);
    // The count gates the caller's aborted-after-grace coverage row: 0 means
    // the label had already settled and must not be re-marked failed.
    assert.equal(abortOpencodeSessionsByLabel(client, 'guideline-compliance', noop), 1);
    assert.equal(abortOpencodeSessionsByLabel(client, 'no-such-label', noop), 0);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(fake.sessions.get(session.id)!.interrupted, 1);

    // A settled prompt unregisters (mirrors the pi registry): a later
    // same-label abort must not fire at the finished session again.
    registerOpencodeSessionForAbort(client, 'review-frontend', session.id);
    unregisterOpencodeSessionForAbort(client, 'review-frontend', session.id);
    assert.equal(abortOpencodeSessionsByLabel(client, 'review-frontend', noop), 0);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(fake.sessions.get(session.id)!.interrupted, 1);
  });
});
