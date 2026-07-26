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
    // seq would be dropped unchecked; the dedup key is a digest of the WHOLE
    // envelope, so copying a seq or sig onto rewritten bytes never inherits a
    // verdict, and full frames are not retained for the session's lifetime.
    assert.match(VIEWER_HTML, /function ingest\(e\) \{\s*checkSig\(e\);/);
    assert.match(VIEWER_HTML, /sha256hex\(JSON\.stringify\(e\)\)/);
    // Keyless frames stay unseen (judgeable later) and mark the session starved
    // so a successful key load replays it.
    assert.match(VIEWER_HTML, /if \(!sigLoaded\) \{ sigStarved = true; return; \}/);
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
