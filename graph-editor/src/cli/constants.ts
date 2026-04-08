/**
 * CLI constants — colours, cache settings, and other shared values.
 */

/** Default colour palette for scenario visualisation. */
export const SCENARIO_COLOURS = [
  '#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6',
  '#ec4899', '#06b6d4', '#84cc16', '#f97316', '#6366f1',
];

/** Number of hex characters to use when truncating SHA-256 hashes for cache filenames. */
export const CACHE_HASH_LENGTH = 12;

/** Number of hex characters for the fingerprint hash (source mtime tracking). */
export const FINGERPRINT_HASH_LENGTH = 32;
