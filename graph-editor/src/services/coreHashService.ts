/**
 * coreHashService.ts
 *
 * Computes the short DB core_hash (content-address) from a canonical signature string.
 *
 * Algorithm (must match Python's short_core_hash_from_canonical_signature exactly):
 *   1. Strip leading/trailing whitespace
 *   2. SHA-256 the UTF-8 bytes
 *   3. Take first 16 bytes (128 bits)
 *   4. base64url encode, no padding → ~22 chars
 *
 * This is the SOLE producer of core_hash values. The backend must never derive
 * core_hash — it receives this value from the frontend and uses it as an opaque key.
 *
 * See: docs/current/project-db/hash-fixes.md
 */

/**
 * Compute the short core_hash from a canonical signature string.
 *
 * @param canonicalSignature - The canonical signature JSON string (e.g. '{"c":"...","x":{...}}')
 * @returns The base64url-encoded (no padding) truncated SHA-256 hash (~22 chars)
 * @throws if canonicalSignature is empty or not a string
 */
export async function computeShortCoreHash(canonicalSignature: string): Promise<string> {
  if (canonicalSignature == null) {
    throw new Error('canonical_signature is required');
  }
  if (typeof canonicalSignature !== 'string') {
    throw new Error('canonical_signature must be a string');
  }
  const sig = canonicalSignature.trim();
  if (sig === '') {
    throw new Error('canonical_signature must be non-empty');
  }

  // UTF-8 encode
  const encoder = new TextEncoder();
  const data = encoder.encode(sig);

  // SHA-256 — works in both browser (crypto.subtle) and Node 18+ (globalThis.crypto)
  let hashBuffer: ArrayBuffer;
  if (typeof globalThis.crypto?.subtle?.digest === 'function') {
    hashBuffer = await globalThis.crypto.subtle.digest('SHA-256', data);
  } else {
    // Fallback for environments where crypto.subtle is unavailable (e.g. older Node / SSR)
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const nodeCrypto = await import('crypto');
    const hash = nodeCrypto.createHash('sha256').update(Buffer.from(data)).digest();
    hashBuffer = hash.buffer.slice(hash.byteOffset, hash.byteOffset + hash.byteLength);
  }

  // Take first 16 bytes
  const first16 = new Uint8Array(hashBuffer).slice(0, 16);

  // base64url encode, no padding
  // Convert bytes to a standard base64 string, then swap to URL-safe alphabet
  const binaryStr = String.fromCharCode(...first16);
  const b64 = btoa(binaryStr);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
