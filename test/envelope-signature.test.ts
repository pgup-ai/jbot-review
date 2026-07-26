import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  generateSigningKeys,
  signEnvelope,
  verifyEnvelope,
} from '../src/shared/envelope-signature.ts';

const envelope = {
  v: 1,
  runId: 'run-1',
  sessionId: 'sess-1',
  seq: 3,
  ts: 1_700_000_000_000,
  agent: 'kilo',
  label: 'review',
  dir: 'out',
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
