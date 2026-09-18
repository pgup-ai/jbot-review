import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatOpencodeKeyProbeLine,
  parseOpencodeGoStatus,
  pickOpencodeApiKey,
  resolveOpencodeApiKeys,
  type OpencodeGoUsage,
} from '../src/shared/opencode-usage.ts';

// The live payload shape (probed 2026-09-18): microcents as strings, resetsAt
// only on the rolling windows.
const statusPayload = (weekUsed: string, monthUsed = '100') => ({
  subscriberUserId: 'acc_1',
  useBalance: true,
  access: {
    startsAt: '2026-09-06T02:22:32.000Z',
    endsAt: '2026-10-06T02:22:32.000Z',
    meters: {
      fiveHour: {
        resetsAt: '2026-09-18T21:58:24.000Z',
        limitMicroCents: '1200000000',
        usedMicroCents: '285509386',
      },
      week: {
        resetsAt: '2026-09-21T00:00:00.000Z',
        limitMicroCents: '1000',
        usedMicroCents: weekUsed,
      },
      month: { limitMicroCents: '1000', usedMicroCents: monthUsed },
    },
  },
});

/** Both roles on one value, which is how the runner resolves a shared list. */
const resolveKey = async (
  providerID: string,
  raw: string,
  log: (msg: string) => void = () => {},
): Promise<string> =>
  (
    await resolveOpencodeApiKeys(
      { providerID, apiKey: raw, auxProviderID: providerID, auxApiKey: raw },
      log,
    )
  ).apiKey;

const usage = (weekUsed: number, monthUsed = 0): OpencodeGoUsage => ({
  week: { used: weekUsed, limit: 1000 },
  month: { used: monthUsed, limit: 1000 },
  useBalance: true,
});

describe('opencode Go plan usage', () => {
  it('parses the meter payload, degrades on absent meters, and poisons on drift', () => {
    const parsed = parseOpencodeGoStatus(statusPayload('250'));
    assert.deepEqual(parsed?.week, {
      used: 250,
      limit: 1000,
      resetAtMs: Date.parse('2026-09-21T00:00:00.000Z'),
    });
    // The monthly meter has no reset timestamp; useBalance rides along.
    assert.deepEqual(parsed?.month, { used: 100, limit: 1000 });
    assert.equal(parsed?.useBalance, true);
    assert.equal(parsed?.fiveHour?.used, 285509386);

    // An absent meter drops only its own segment.
    const partial = parseOpencodeGoStatus({ access: { meters: { week: undefined } } });
    assert.deepEqual(partial, {
      fiveHour: undefined,
      week: undefined,
      month: undefined,
      useBalance: false,
    });

    // A present-but-malformed field poisons the whole payload, so a partial
    // line can never hide a real cap.
    for (const meters of [
      null,
      { week: null },
      { week: { limitMicroCents: '1000' } },
      { week: { limitMicroCents: '0', usedMicroCents: '1' } },
      { week: { limitMicroCents: '1000', usedMicroCents: '-1' } },
      { week: { limitMicroCents: '1000', usedMicroCents: 'nope' } },
      { week: { limitMicroCents: '1000', usedMicroCents: '1', resetsAt: 'not-a-date' } },
      { week: 5 },
    ]) {
      assert.equal(parseOpencodeGoStatus({ access: { meters } }), undefined);
    }
    for (const bad of [null, 'x', {}, { access: 5 }, { access: { meters: 5 } }]) {
      assert.equal(parseOpencodeGoStatus(bad), undefined);
    }
  });

  it('picks the most weekly headroom, breaking ties on monthly and skipping spent windows', () => {
    const probes = [
      { key: 'aaaa1111', usage: usage(900) },
      { key: 'bbbb2222', usage: usage(100) },
      { key: 'cccc3333' },
    ];
    const picked = pickOpencodeApiKey(probes);
    assert.equal(picked.key, 'bbbb2222');
    assert.match(picked.reason, /picked 2\/3 \(…2222, 90% of weekly limit left\)/);

    // Equal weekly headroom falls through to the monthly meter.
    assert.equal(
      pickOpencodeApiKey([
        { key: 'a', usage: usage(500, 900) },
        { key: 'b', usage: usage(500, 100) },
      ]).key,
      'b',
    );
    // A spent window is skipped even when it has more weekly room than the
    // alternative; here the five-hour cap is the one that is spent.
    assert.equal(
      pickOpencodeApiKey([
        { key: 'a', usage: { ...usage(0), fiveHour: { used: 10, limit: 10 } } },
        { key: 'b', usage: usage(800) },
      ]).key,
      'b',
    );
    // A spent monthly cap with overage blocked cannot serve at all, so it loses
    // to a key with far less weekly room.
    assert.equal(
      pickOpencodeApiKey([
        { key: 'monthly-dead', usage: { ...usage(0, 1000), useBalance: false } },
        { key: 'usable', usage: usage(900) },
      ]).key,
      'usable',
    );
    // Every window spent still yields a key rather than failing the run, and a
    // plan that can bill overage outranks one where overage is blocked.
    const allSpent = pickOpencodeApiKey([
      { key: 'a', usage: usage(1000) },
      { key: 'b', usage: usage(1200) },
    ]);
    assert.equal(allSpent.key, 'a');
    assert.equal(
      pickOpencodeApiKey([
        { key: 'blocked', usage: { ...usage(1000), useBalance: false } },
        { key: 'overage-ok', usage: usage(1200) },
      ]).key,
      'overage-ok',
    );
    assert.match(
      allSpent.reason,
      /all 2 window-limited; picked 1\/2 \(…a, 0% of weekly limit left\)/,
    );
    // An unmetered account reads as full headroom, not as a 100% meter.
    assert.match(
      pickOpencodeApiKey([{ key: 'solo', usage: { useBalance: false } }]).reason,
      /no weekly limit/,
    );
    // No probe reached: keep the first key rather than guessing.
    assert.deepEqual(pickOpencodeApiKey([{ key: 'first' }, { key: 'second' }]), {
      key: 'first',
      reason: 'probes unavailable; using first of 2',
    });
  });

  it('renders per-key meter lines with the spent marker and overage disposition', () => {
    const now = Date.parse('2026-09-20T00:00:00.000Z');
    const line = formatOpencodeKeyProbeLine(
      {
        key: 'keyabcd',
        usage: {
          week: {
            used: 3_000_000_000,
            limit: 3_000_000_000,
            resetAtMs: Date.parse('2026-09-21T00:00:00.000Z'),
          },
          month: { used: 2_239_887_227, limit: 6_000_000_000 },
          useBalance: true,
        },
      },
      0,
      2,
      now,
    );
    assert.equal(
      line,
      'Opencode key 1/2 (…abcd): weekly $30.00/$30.00 (100%, EXCEEDED, resets in 24h 0m), ' +
        'monthly $22.40/$60.00 (37%); overage draws on the credit balance.',
    );
    assert.equal(
      formatOpencodeKeyProbeLine({ key: 'keyabcd' }, 1, 2, now),
      'Opencode key 2/2 (…abcd): plan usage unavailable.',
    );
  });

  it('probes only for opencode key lists and returns the best key', async (t) => {
    const requests: string[] = [];
    t.mock.method(
      globalThis,
      'fetch',
      async (_url: unknown, init: { headers: Record<string, string> }) => {
        const key = init.headers.Authorization;
        requests.push(key);
        return new Response(JSON.stringify(statusPayload(key.endsWith('rich') ? '10' : '990')));
      },
    );
    const logs: string[] = [];
    assert.equal(
      await resolveKey('opencode-go', 'k-poor, k-rich', (line) => logs.push(line)),
      'k-rich',
    );
    assert.deepEqual(requests, ['Bearer k-poor', 'Bearer k-rich']);
    assert.ok(logs.some((line) => line.startsWith('Opencode key 1/2')));
    assert.ok(logs.at(-1)?.includes('picked 2/2'));

    // A single key, a non-opencode provider, and an unparseable list all skip
    // the probe entirely, so the common case adds no request.
    requests.length = 0;
    for (const [providerID, raw, expected] of [
      ['opencode', 'only-key', 'only-key'],
      ['deepseek', 'a,b', 'a,b'],
      ['opencode', 'a,', 'a'],
      ['opencode', ',,', ',,'],
    ] as const) {
      assert.equal(await resolveKey(providerID, raw), expected);
    }
    assert.deepEqual(requests, []);
  });

  it('treats a refused, unparseable, or throwing status endpoint as no usage', async (t) => {
    // The refusal path returns !ok; the other two reject inside the probe, so
    // only these reach the catch that keeps a broken endpoint from failing a run.
    let respond: () => Response = () => new Response('nope', { status: 403 });
    t.mock.method(globalThis, 'fetch', async () => respond());
    for (const stub of [
      () => new Response('nope', { status: 403 }),
      () => new Response('not json', { status: 200 }),
      (): Response => {
        throw new Error('network down');
      },
    ]) {
      respond = stub;
      const logs: string[] = [];
      assert.equal(await resolveKey('opencode', 'a,b', (line) => logs.push(line)), 'a');
      assert.ok(logs.some((line) => line.includes('plan usage unavailable')));
      assert.ok(logs.at(-1)?.includes('probes unavailable'));
    }
  });
});
