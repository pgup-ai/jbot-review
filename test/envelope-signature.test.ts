import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  generateSigningKeys,
  signEnvelope,
  verifyEnvelope,
  verifyJournalLines,
} from '../src/shared/envelope-signature.ts';

const envelope = {
  v: 1,
  runId: 'run-1',
  sessionId: 'sess-1',
  seq: 3,
  ts: 1_700_000_000_000,
  agent: 'kilo',
  label: 'review',
  dir: 'in',
  endpoint: 'e2e',
  frame: { jsonrpc: '2.0', method: 'session/update', params: { text: 'hello' } },
};

describe('envelope signatures', () => {
  it('verifies a signed envelope only under the key that signed it', () => {
    const { privateKey, publicKey } = generateSigningKeys();
    const other = generateSigningKeys();

    const signed = signEnvelope(envelope, privateKey);
    assert.equal(verifyEnvelope(signed, publicKey), true);
    assert.equal(verifyEnvelope(signed, other.publicKey), false);
  });

  it('survives the JSON round trip the relay puts it through', () => {
    const { privateKey, publicKey } = generateSigningKeys();
    const signed = signEnvelope(envelope, privateKey);

    // What the gateway journals and a viewer reads back is the serialized line,
    // so verification has to hold on the reparsed object, not just this one.
    const relayed = JSON.parse(JSON.stringify(signed)) as Record<string, unknown>;
    assert.equal(verifyEnvelope(relayed, publicKey), true);
  });

  it('rejects tampering with any covered field, and rejects unsigned lines', () => {
    const { privateKey, publicKey } = generateSigningKeys();
    const signed = signEnvelope(envelope, privateKey);

    assert.equal(verifyEnvelope({ ...signed, seq: 4 }, publicKey), false);
    assert.equal(
      verifyEnvelope({ ...signed, frame: { jsonrpc: '2.0', method: 'evil' } }, publicKey),
      false,
    );
    // Unsigned and forged must be indistinguishable to a caller: both false.
    assert.equal(verifyEnvelope(envelope, publicKey), false);
    assert.equal(verifyEnvelope({ ...signed, sig: 'not-base64!' }, publicKey), false);
  });
});

describe('verifyJournalLines', () => {
  it('skips only unsigned client frames, so no field can turn tampering into a skip', () => {
    const { privateKey, publicKey } = generateSigningKeys();
    const good = JSON.stringify(signEnvelope(envelope, privateKey));
    const tampered = JSON.stringify({ ...signEnvelope(envelope, privateKey), seq: 99 });
    const clientFrame = JSON.stringify({ v: 1, seq: 1, dir: 'out', frame: {} });

    assert.deepEqual(verifyJournalLines([good, clientFrame], publicKey), {
      checked: 1,
      verified: 1,
      skipped: 1,
      unattributed: 0,
    });

    // Tampered, unsigned-inbound and unparseable all count as checked-not-verified.
    assert.deepEqual(
      verifyJournalLines([good, tampered, JSON.stringify(envelope), '{oops'], publicKey),
      { checked: 4, verified: 1, skipped: 0, unattributed: 0 },
    );

    // A signed frame stays checked however its unverified fields are rewritten:
    // flipping dir to 'out' or deleting endpoint must not skip it.
    const flipped = JSON.stringify({ ...signEnvelope(envelope, privateKey), dir: 'out' });
    const { endpoint: _gone, ...stripped } = JSON.parse(good) as Record<string, unknown>;
    assert.deepEqual(verifyJournalLines([flipped, JSON.stringify(stripped)], publicKey), {
      checked: 2,
      verified: 0,
      skipped: 0,
      unattributed: 0,
    });
  });

  it('reports another companion frames as unattributed rather than skipping them', () => {
    const { privateKey, publicKey } = generateSigningKeys();
    const mine = JSON.stringify(signEnvelope(envelope, privateKey));
    const theirs = JSON.stringify(signEnvelope({ ...envelope, endpoint: 'other' }, privateKey));

    assert.deepEqual(verifyJournalLines([mine, theirs], publicKey, 'e2e'), {
      checked: 1,
      verified: 1,
      skipped: 0,
      unattributed: 1,
    });
  });
});
