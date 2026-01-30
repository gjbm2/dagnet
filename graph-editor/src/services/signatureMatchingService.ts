/**
 * Structured Query Signature Matching Service
 *
 * Provides parsing, serialisation, and subset-aware matching for structured signatures.
 *
 * The signature system splits query identity into two independent components:
 * 1. coreHash: Hash of non-context semantic inputs (connection, events, filters, etc.)
 * 2. contextDefHashes: Per-context-key definition hashes
 *
 * This enables cache sharing when:
 * - Query asks for uncontexted data but cache has contexted MECE slices
 * - Query asks for single-dimension data but cache has multi-dimensional slices
 *
 * @see docs/current/multi-sig-matching.md for full design specification
 */

export interface StructuredSignature {
  /** SHA-256 hash of non-context semantic inputs */
  coreHash: string;

  /**
   * Map from context key → SHA-256 of normalised definition.
   * Keys are sorted alphabetically.
   * Empty object {} means no context keys (uncontexted query).
   */
  contextDefHashes: Record<string, string>;
}

export interface SignatureMatchResult {
  /** Whether the cache signature can satisfy the query signature */
  compatible: boolean;

  /** If not compatible, the reason for mismatch */
  reason?:
    | 'core_mismatch'
    | `missing_context_key:${string}`
    | `context_def_mismatch:${string}`
    | `context_hash_unavailable:${string}`
    | `query_hash_unavailable:${string}`;
}

/**
 * Parse a serialised signature string into structured form.
 *
 * CRITICAL: This function MUST be defensive and never throw.
 * Legacy signatures and malformed inputs return empty structure.
 */
export function parseSignature(sig: string): StructuredSignature {
  // Guard: null/undefined/empty
  if (!sig || typeof sig !== 'string') {
    return { coreHash: '', contextDefHashes: {} };
  }

  // Guard: Legacy hex hash (64 chars, hex only)
  if (/^[a-f0-9]{64}$/i.test(sig)) {
    // Legacy signature - return empty structure (will never match)
    return { coreHash: '', contextDefHashes: {} };
  }

  // Guard: Not JSON-like
  if (!sig.startsWith('{')) {
    return { coreHash: '', contextDefHashes: {} };
  }

  try {
    const parsed = JSON.parse(sig);
    return {
      coreHash: typeof parsed.c === 'string' ? parsed.c : '',
      contextDefHashes: parsed.x && typeof parsed.x === 'object' ? parsed.x : {},
    };
  } catch {
    // Malformed JSON - return empty structure
    return { coreHash: '', contextDefHashes: {} };
  }
}

/**
 * Serialise a structured signature to string for storage.
 *
 * Uses compact keys ('c' for core, 'x' for context) to minimise storage overhead.
 */
export function serialiseSignature(sig: StructuredSignature): string {
  return JSON.stringify({
    c: sig.coreHash,
    x: sig.contextDefHashes,
  });
}

/**
 * Check if a cached signature can satisfy a query signature.
 *
 * Rules:
 * 1. Core hashes must match exactly
 * 2. For each context key in the QUERY, the cache must have that key with matching def hash
 * 3. Cache may have EXTRA context keys (superset is OK)
 * 4. 'missing' or 'error' hashes are treated as incompatible (fail-safe)
 *
 * @param cacheSig - The signature stored with cached data
 * @param querySig - The signature computed for the current query
 * @returns Whether the cache can satisfy the query, and reason if not
 */
export function signatureCanSatisfy(
  cacheSig: StructuredSignature,
  querySig: StructuredSignature
): SignatureMatchResult {
  // Rule 1: Core semantics must match
  if (cacheSig.coreHash !== querySig.coreHash) {
    return { compatible: false, reason: 'core_mismatch' };
  }

  // Rule 2: Query's context keys must be present in cache with matching hashes
  for (const [key, queryDefHash] of Object.entries(querySig.contextDefHashes)) {
    const cacheDefHash = cacheSig.contextDefHashes[key];

    // Rule 2a: Cache must have the key
    if (cacheDefHash === undefined) {
      return { compatible: false, reason: `missing_context_key:${key}` };
    }

    // Rule 2b: Treat 'missing' or 'error' hashes as non-match (fail-safe)
    // We cannot validate correctness without the actual hash
    if (cacheDefHash === 'missing' || cacheDefHash === 'error') {
      return { compatible: false, reason: `context_hash_unavailable:${key}` };
    }
    if (queryDefHash === 'missing' || queryDefHash === 'error') {
      return { compatible: false, reason: `query_hash_unavailable:${key}` };
    }

    // Rule 2c: Hashes must match
    if (cacheDefHash !== queryDefHash) {
      return { compatible: false, reason: `context_def_mismatch:${key}` };
    }
  }

  // Rule 3: Cache may have extra context keys (superset OK)
  return { compatible: true };
}

/**
 * Convenience: check if cache signature string can satisfy query signature string.
 *
 * @param cacheSigStr - Serialised signature from cached data
 * @param querySigStr - Serialised signature for current query
 * @returns true if cache can satisfy the query
 */
export function canCacheSatisfyQuery(cacheSigStr: string, querySigStr: string): boolean {
  const cacheSig = parseSignature(cacheSigStr);
  const querySig = parseSignature(querySigStr);
  return signatureCanSatisfy(cacheSig, querySig).compatible;
}

/**
 * Get the context keys that are in cache but not in query (unspecified dimensions).
 *
 * Used for determining which dimensions need MECE verification for aggregation.
 *
 * @param cacheSig - The cache's structured signature
 * @param querySig - The query's structured signature
 * @returns Array of context keys present in cache but not specified in query
 */
export function getUnspecifiedDimensions(
  cacheSig: StructuredSignature,
  querySig: StructuredSignature
): string[] {
  const queryKeys = new Set(Object.keys(querySig.contextDefHashes));
  return Object.keys(cacheSig.contextDefHashes).filter((k) => !queryKeys.has(k));
}
