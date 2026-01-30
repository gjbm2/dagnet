/**
 * Signature Policy Service
 *
 * ENABLED (29-Jan-26) after implementing structured signatures with subset-aware matching.
 * 
 * The new signature system:
 * - Uses structured signatures with separate coreHash and contextDefHashes
 * - Supports subset-aware matching: cache with superset of context keys can satisfy query
 * - Fixes the bug where uncontexted queries rejected contexted MECE cache
 * 
 * @see docs/current/multi-sig-matching.md for full design specification
 */
export const SIGNATURE_CHECKING_ENABLED = true;
export const SIGNATURE_WRITING_ENABLED = true;

export function isSignatureCheckingEnabled(): boolean {
  return SIGNATURE_CHECKING_ENABLED;
}

export function isSignatureWritingEnabled(): boolean {
  return SIGNATURE_WRITING_ENABLED;
}


