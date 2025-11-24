/**
 * Slice Isolation Utilities
 * 
 * Helpers to enforce slice isolation in aggregation functions.
 * Prevents accidental cross-slice aggregation (data corruption risk).
 */

import { normalizeConstraintString } from '../lib/queryDSL';

/**
 * Helper to enforce slice isolation in aggregation functions.
 * Returns filtered values for a specific slice, with validation.
 * 
 * @param values - All parameter values
 * @param targetSlice - DSL string identifying which slice to isolate (empty string = uncontexted)
 * @returns Values matching the target slice
 * @throws Error if contexted data exists but uncontexted slice requested without MECE intent
 */
export function isolateSlice<T extends { sliceDSL?: string }>(
  values: T[],
  targetSlice: string
): T[] {
  const normalized = normalizeConstraintString(targetSlice);
  const matched = values.filter(v => (v.sliceDSL ?? '') === normalized);
  
  // Validate: if file has contexts but we got nothing, that's likely a bug
  const hasContexts = values.some(v => v.sliceDSL && v.sliceDSL !== '');
  if (hasContexts && matched.length === 0 && normalized === '') {
    throw new Error(
      `Slice isolation error: file has contexted data but query requested uncontexted. ` +
      `Use MECE aggregation if intentional.`
    );
  }
  
  return matched;
}

