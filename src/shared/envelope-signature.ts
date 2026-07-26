import { createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';

/**
 * Ed25519 signing for relayed envelopes (M2d). The companion signs what it
 * emits, so the journal is tamper-evident against the relay itself: the gateway
 * stores and fans out frames it cannot forge, which is what keeps the pipe dumb
 * rather than trusted.
 */

/** Signed line as it travels: the envelope's own fields plus `sig`, always last. */
const SIGNATURE_FIELD = 'sig';

/**
 * Bytes covered by a signature: the line minus its signature. `sig` is appended
 * last on the wire, so deleting it and re-serializing reproduces exactly what
 * the signer hashed — JSON.parse preserves the key order of the text it read.
 */
function signedPayload(line: object): string {
  const { [SIGNATURE_FIELD]: _signature, ...rest } = line as Record<string, unknown>;
  return JSON.stringify(rest);
}

/** PEM keypair for a companion. The private half never leaves its machine. */
export function generateSigningKeys(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

/** The public half of a stored private key, so only the private one is kept. */
export function publicKeyFrom(privateKeyPem: string): string {
  return createPublicKey(privateKeyPem).export({ type: 'spki', format: 'pem' }).toString();
}

/** Returns the line with its signature appended, ready to serialize. */
export function signEnvelope<T extends object>(
  envelope: T,
  privateKeyPem: string,
): T & { sig: string } {
  const signature = sign(null, Buffer.from(signedPayload(envelope)), privateKeyPem);
  return { ...envelope, [SIGNATURE_FIELD]: signature.toString('base64') } as T & { sig: string };
}

/**
 * Whether `line` carries a signature made by `publicKeyPem`. False for an
 * unsigned line, a malformed signature, or a key that cannot be read — a
 * verifier must not have to distinguish "unsigned" from "forged".
 */
export function verifyEnvelope(line: object, publicKeyPem: string): boolean {
  const signature = (line as Record<string, unknown>)[SIGNATURE_FIELD];
  if (typeof signature !== 'string') return false;
  try {
    return verify(
      null,
      Buffer.from(signedPayload(line)),
      publicKeyPem,
      Buffer.from(signature, 'base64'),
    );
  } catch {
    return false;
  }
}

/**
 * Tally over a journal. Client frames (unsigned `dir: 'out'`) pass through
 * unsigned by design and are skipped; everything else is checked, so deleting
 * `endpoint` from a signed frame makes it fail rather than disappear. Pass
 * `endpoint` to scope a pass to one companion — its signed frames elsewhere are
 * reported as `unattributed`, never silently dropped.
 *
 * `breaks` counts violations of the signed sequence: the companion numbers its
 * frames 1,2,3… per session inside the signed payload, so among the frames that
 * VERIFY the run must climb by exactly one from 1. A deletion leaves a gap no
 * rewriting can hide — the survivors' signatures pin their seqs — and a
 * duplicate or reorder breaks the climb. This is what still catches a signed
 * frame whose signature was stripped and direction flipped to look like a
 * client frame: the frame itself skips, its seq vanishes, the run breaks.
 * Limits: truncation at the tail, and deletion of every signed frame at once,
 * leave no survivors to break against.
 */
export function verifyJournalLines(
  lines: string[],
  publicKeyPem: string,
  endpoint?: string,
): { checked: number; verified: number; skipped: number; unattributed: number; breaks: number } {
  let checked = 0;
  let verified = 0;
  let skipped = 0;
  let unattributed = 0;
  let breaks = 0;
  let lastSeq = 0;
  for (const line of lines) {
    let parsed: Record<string, unknown> | undefined;
    try {
      const value: unknown = JSON.parse(line);
      if (value && typeof value === 'object') parsed = value as Record<string, unknown>;
    } catch {
      /* left undefined */
    }
    const signed = typeof parsed?.sig === 'string';
    if (!signed && parsed?.dir === 'out') {
      skipped += 1;
      continue;
    }
    if (signed && endpoint !== undefined && parsed?.endpoint !== endpoint) {
      unattributed += 1;
      continue;
    }
    checked += 1;
    if (parsed && verifyEnvelope(parsed, publicKeyPem)) {
      verified += 1;
      if (parsed.seq !== lastSeq + 1) breaks += 1;
      if (typeof parsed.seq === 'number') lastSeq = parsed.seq;
    }
  }
  return { checked, verified, skipped, unattributed, breaks };
}
