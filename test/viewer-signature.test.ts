import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { VIEWER_HTML } from '../src/gateway/viewer.ts';
import { generateSigningKeys, signEnvelope } from '../src/shared/envelope-signature.ts';

describe('viewer signature check', () => {
  it('ships the verification path with its regex escaping intact', () => {
    // The page is a template literal, so `\s` collapses unless doubled — the
    // browser would then strip literal "s" from a PEM and fail every key.
    assert.match(VIEWER_HTML, /replace\(\/\\s\+\/g, ''\)/);
    assert.match(VIEWER_HTML, /name: 'Ed25519'/);
    // Checked before the seq dedup, or a tampered frame carrying a replayed
    // seq would be dropped unchecked; checkSig dedups itself so a reconnect
    // replay still counts each frame once.
    assert.match(VIEWER_HTML, /function ingest\(e\) \{\s*checkSig\(e\);/);
    assert.match(VIEWER_HTML, /if \(sigSeen\[id\]\) return;/);
  });

  it('verifies a companion signature through the browser primitives', async () => {
    // Same steps the page takes — SPKI import, drop `sig`, re-serialize —
    // against a real signature, since none of that is exercised in Node.
    const { privateKey, publicKey } = generateSigningKeys();
    const signed = JSON.parse(
      JSON.stringify(
        signEnvelope(
          { v: 1, runId: 'r', sessionId: 's', seq: 1, ts: 2, endpoint: 'e2e', frame: { x: 1 } },
          privateKey,
        ),
      ),
    ) as Record<string, unknown>;

    const der = Uint8Array.from(
      atob(publicKey.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')),
      (c) => c.charCodeAt(0),
    );
    const key = await crypto.subtle.importKey('spki', der, { name: 'Ed25519' }, false, ['verify']);
    const rest: Record<string, unknown> = {};
    for (const k in signed) if (k !== 'sig') rest[k] = signed[k];
    const signature = Uint8Array.from(atob(String(signed.sig)), (c) => c.charCodeAt(0));
    const bytes = (value: object) => new TextEncoder().encode(JSON.stringify(value));

    assert.equal(await crypto.subtle.verify('Ed25519', key, signature, bytes(rest)), true);
    assert.equal(
      await crypto.subtle.verify('Ed25519', key, signature, bytes({ ...rest, seq: 99 })),
      false,
    );
  });
});
