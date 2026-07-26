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

/** Signature tally for a journal file: unsigned and forged both count as bad. */
export function verifyJournalLines(
  lines: string[],
  publicKeyPem: string,
): { total: number; verified: number } {
  let verified = 0;
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // counted against the total: an unparseable line is not intact
    }
    if (parsed && typeof parsed === 'object' && verifyEnvelope(parsed, publicKeyPem)) verified += 1;
  }
  return { total: lines.length, verified };
}
