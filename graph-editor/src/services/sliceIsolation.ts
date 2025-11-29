/**
 * Slice Isolation Utilities
 * 
 * Helpers to enforce slice isolation in aggregation functions.
 * Prevents accidental cross-slice aggregation (data corruption risk).
 */

import { parseConstraints } from '../lib/queryDSL';

/**
 * Extract just the context/case dimensions from a DSL string, ignoring window.
 * 
 * sliceDSL stored in files contains ONLY context dimensions (e.g., 'context(channel:google)').
 * But targetSlice from UI often includes window (e.g., 'context(channel:google).window(1-Oct-25:1-Oct-25)').
 * 
 * This function extracts just the context/case parts for matching.
 * 
 * @param dsl - Full DSL string (may include window)
 * @returns Normalized slice identifier (context/case only, no window)
 */
export function extractSliceDimensions(dsl: string): string {
  if (!dsl || !dsl.trim()) return '';
  
  const parsed = parseConstraints(dsl);
  const parts: string[] = [];
  
  // Include context dimensions (sorted for consistent matching)
  if (parsed.context.length > 0) {
    const contextParts = parsed.context
      .sort((a, b) => a.key.localeCompare(b.key))
      .map(({key, value}) => `context(${key}:${value})`);
    parts.push(...contextParts);
  }
  
  // Include case dimensions (sorted for consistent matching)
  if (parsed.cases.length > 0) {
    const caseParts = parsed.cases
      .sort((a, b) => a.key.localeCompare(b.key))
      .map(({key, value}) => `case(${key}:${value})`);
    parts.push(...caseParts);
  }
  
  // Note: We intentionally EXCLUDE window - it's not a slice dimension
  // Window is used for temporal filtering, not slice identification
  
  return parts.join('.');
}

/**
 * Helper to enforce slice isolation in aggregation functions.
 * Returns filtered values for a specific slice, with validation.
 * 
 * IMPORTANT: This compares only context/case dimensions, NOT window.
 * - File stores: sliceDSL = 'context(channel:google)'
 * - Query may be: targetSlice = 'context(channel:google).window(1-Oct-25:1-Oct-25)'
 * - Match: YES (window is ignored for slice matching)
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
  // Extract just the slice dimensions (context/case), ignoring window
  const normalizedTarget = extractSliceDimensions(targetSlice);
  
  // Match values where sliceDSL matches the extracted dimensions
  const matched = values.filter(v => {
    const valueSlice = extractSliceDimensions(v.sliceDSL ?? '');
    return valueSlice === normalizedTarget;
  });
  
  // Validate: if file has contexts but we got nothing, that's likely a bug
  const hasContexts = values.some(v => v.sliceDSL && v.sliceDSL !== '');
  if (hasContexts && matched.length === 0 && normalizedTarget === '') {
    throw new Error(
      `Slice isolation error: file has contexted data but query requested uncontexted. ` +
      `Use MECE aggregation if intentional.`
    );
  }
  
  return matched;
}

