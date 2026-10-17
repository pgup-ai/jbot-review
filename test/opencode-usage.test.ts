import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatOpencodeKeyProbeLine,
  parseOpencodeGoStatus,
  pickOpencodeApiKey,
  resolveOpencodeApiKeys,
  type OpencodeGoUsage,
} from '../src/shared/opencode-usage.ts';

// The live payload shape (probed 2026-10-16): microcents as strings; the
// monthly meter resets at the subscription's own billing anchor.
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
      month: {
        resetsAt: '2026-10-06T02:22:32.000Z',
        limitMicroCents: '1000',
        usedMicroCents: monthUsed,
      },
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

// Thousandths of a $10 cap, so reasons print readable dollars.
const usage = (weekUsed: number, monthUsed = 0, monthResetAtMs?: number): OpencodeGoUsage => ({
  week: { used: weekUsed * 1e6, limit: 1e9 },
  month: {
    used: monthUsed * 1e6,
    limit: 1e9,
    ...(monthResetAtMs === undefined ? {} : { resetAtMs: monthResetAtMs }),
  },
  useBalance: true,
});
const NOW = Date.parse('2026-10-17T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

describe('opencode Go plan usage', () => {
  it('parses the meter payload, degrades on absent meters, and poisons on drift', () => {
    const parsed = parseOpencodeGoStatus(statusPayload('250'));
    assert.deepEqual(parsed?.week, {
      used: 250,
      limit: 1000,
      resetAtMs: Date.parse('2026-09-21T00:00:00.000Z'),
    });
    assert.deepEqual(parsed?.month, {
      used: 100,
      limit: 1000,
      resetAtMs: Date.parse('2026-10-06T02:22:32.000Z'),
    });
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

  it('picks the open-window key whose monthly allowance lapses soonest', () => {
    // Equal allowance left: the earliest monthly reset wins, but a key nearly
    // spent loses to one that would otherwise lapse with far more unused.
    assert.equal(
      pickOpencodeApiKey(
        [
          { key: 'late', usage: usage(0, 800, NOW + 20 * DAY) },
          { key: 'soon', usage: usage(900, 800, NOW + 8 * DAY) },
        ],
        NOW,
      ).key,
      'soon',
    );
    const picked = pickOpencodeApiKey(
      [
        { key: 'dregs', usage: usage(0, 990, NOW + 1 * DAY) },
        { key: 'full', usage: usage(0, 0, NOW + 20 * DAY) },
      ],
      NOW,
    );
    assert.equal(picked.key, 'full');
    assert.match(picked.reason, /\(…full, \$10\.00 of monthly limit left, resets in 20d 0h\)/);
  });

  it('keeps the window gates and fallbacks, breaking ties on weekly', () => {
    // A barely-used week does not rescue a nearly spent month.
    const probes = [
      { key: 'aaaa1111', usage: usage(0, 940) },
      { key: 'bbbb2222', usage: usage(300, 380) },
      { key: 'cccc3333' },
    ];
    const picked = pickOpencodeApiKey(probes, NOW);
    assert.equal(picked.key, 'bbbb2222');
    assert.match(picked.reason, /picked 2\/3 \(…2222, \$6\.20 of monthly limit left\)/);

    // Equal monthly headroom falls through to the weekly meter.
    assert.equal(
      pickOpencodeApiKey(
        [
          { key: 'a', usage: usage(900, 500) },
          { key: 'b', usage: usage(100, 500) },
        ],
        NOW,
      ).key,
      'b',
    );
    // A spent 5h or weekly window is skipped even with more monthly room.
    for (const spentKey of [{ ...usage(0), fiveHour: { used: 10, limit: 10 } }, usage(1000)]) {
      assert.equal(
        pickOpencodeApiKey(
          [
            { key: 'a', usage: spentKey },
            { key: 'b', usage: usage(0, 900) },
          ],
          NOW,
        ).key,
        'b',
      );
    }
    // A spent monthly cap with overage blocked cannot serve at all.
    assert.equal(
      pickOpencodeApiKey(
        [
          { key: 'monthly-dead', usage: { ...usage(0, 1000), useBalance: false } },
          { key: 'usable', usage: usage(900) },
        ],
        NOW,
      ).key,
      'usable',
    );
    // Every window spent still yields a key rather than failing the run, and a
    // plan that can bill overage outranks one where overage is blocked.
    const allSpent = pickOpencodeApiKey(
      [
        { key: 'a', usage: usage(1000, 500) },
        { key: 'b', usage: usage(1200, 600) },
      ],
      NOW,
    );
    assert.equal(allSpent.key, 'a');
    assert.equal(
      pickOpencodeApiKey(
        [
          { key: 'blocked', usage: { ...usage(1000), useBalance: false } },
          { key: 'overage-ok', usage: usage(1200) },
        ],
        NOW,
      ).key,
      'overage-ok',
    );
    assert.match(
      allSpent.reason,
      /all 2 window-limited; picked 1\/2 \(…a, \$5\.00 of monthly limit left\)/,
    );
    // An unmetered account reads as full headroom, not as a 100% meter.
    assert.match(
      pickOpencodeApiKey([{ key: 'solo', usage: { useBalance: false } }], NOW).reason,
      /no monthly limit/,
    );
    // No probe reached: keep the first key rather than guessing.
    assert.deepEqual(pickOpencodeApiKey([{ key: 'first' }, { key: 'second' }], NOW), {
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

    // A non-opencode provider and an unparseable list never reach the endpoint.
    requests.length = 0;
    for (const [providerID, raw] of [
      ['deepseek', 'a,b'],
      ['opencode', ',,'],
    ] as const) {
      assert.equal(await resolveKey(providerID, raw), raw);
    }
    assert.deepEqual(requests, []);

    // A single key has no pick to make but still reports its meters, and a
    // trailing comma resolves to the key the run actually uses.
    const soloLogs: string[] = [];
    assert.equal(
      await resolveKey('opencode', 'only-key,', (line) => soloLogs.push(line)),
      'only-key',
    );
    assert.deepEqual(requests, ['Bearer only-key']);
    assert.equal(soloLogs.length, 1);
    assert.match(soloLogs[0], /^Opencode plan usage: 5h \$/);
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

      // One key has no pick to make, so it reports the absence on its own line
      // and still hands back the key.
      const soloLogs: string[] = [];
      assert.equal(await resolveKey('opencode', 'solo', (line) => soloLogs.push(line)), 'solo');
      assert.deepEqual(soloLogs, ['Opencode plan usage unavailable.']);
    }
  });
});
