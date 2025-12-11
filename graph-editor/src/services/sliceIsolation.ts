/**
 * Slice Isolation Utilities
 * 
 * Helpers to enforce slice isolation in aggregation functions.
 * Prevents accidental cross-slice aggregation (data corruption risk).
 */

import { parseConstraints, type ParsedConstraints } from '../lib/queryDSL';

/**
 * Expand contextAny into individual context slice identifiers.
 * 
 * contextAny(channel:google,channel:influencer) expands to:
 *   ['context(channel:google)', 'context(channel:influencer)']
 * 
 * @param parsed - Parsed constraints object
 * @returns Array of individual context slice identifiers
 */
export function expandContextAny(parsed: ParsedConstraints): string[] {
  const parts: string[] = [];
  for (const ctxAny of parsed.contextAny) {
    for (const pair of ctxAny.pairs) {
      parts.push(`context(${pair.key}:${pair.value})`);
    }
  }
  return parts.sort();
}

/**
 * Check if a DSL string contains contextAny (multi-slice query).
 */
export function hasContextAny(dsl: string): boolean {
  if (!dsl || !dsl.trim()) return false;
  const parsed = parseConstraints(dsl);
  return parsed.contextAny.length > 0;
}

/**
 * Extract just the context/case dimensions from a DSL string, ignoring window.
 * 
 * sliceDSL stored in files contains ONLY context dimensions (e.g., 'context(channel:google)').
 * But targetSlice from UI often includes window (e.g., 'context(channel:google).window(1-Oct-25:1-Oct-25)').
 * 
 * This function extracts just the context/case parts for matching.
 * 
 * NOTE: For contextAny queries, use expandContextAny() instead - this function
 * returns a SINGLE slice identifier, not suitable for multi-slice matching.
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
  
  // Note: contextAny is NOT included here - use expandContextAny() for multi-slice queries
  
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
 * For contextAny queries (multi-slice):
 * - Query: targetSlice = 'contextAny(channel:google,channel:influencer).window(...)'
 * - Matches: sliceDSL = 'context(channel:google)' OR 'context(channel:influencer)'
 * - Returns values from ALL matching component slices
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
  const parsed = parseConstraints(targetSlice);
  
  // Handle contextAny: match ANY of the component slices
  if (parsed.contextAny.length > 0) {
    const expandedSlices = expandContextAny(parsed);
    
    // Also include any explicit context() dimensions
    if (parsed.context.length > 0) {
      const explicitContexts = parsed.context
        .sort((a, b) => a.key.localeCompare(b.key))
        .map(({key, value}) => `context(${key}:${value})`);
      expandedSlices.push(...explicitContexts);
    }
    
    // Match values where sliceDSL is ANY of the expanded slices
    const matched = values.filter(v => {
      const valueSlice = extractSliceDimensions(v.sliceDSL ?? '');
      return expandedSlices.includes(valueSlice);
    });
    
    return matched;
  }
  
  // Standard path: single slice matching
  // Extract just the slice dimensions (context/case), ignoring window
  const normalizedTarget = extractSliceDimensions(targetSlice);
  
  // Determine if target requires a specific slice TYPE (window vs cohort)
  // This prevents mixing data from different slice types, but still allows
  // legacy / untyped slices to participate.
  const targetIsWindow = targetSlice.includes('window(');
  const targetIsCohort = targetSlice.includes('cohort(');
  
  // Match values where sliceDSL matches the extracted dimensions
  // AND (if target specifies a type) we do NOT cross-contaminate:
  // - window() target must not pull from explicit cohort() slices
  // - cohort() target must not pull from explicit window() slices
  // - untyped slices (no window()/cohort()) are allowed in both modes
  const matched = values.filter(v => {
    const valueSlice = extractSliceDimensions(v.sliceDSL ?? '');
    if (valueSlice !== normalizedTarget) return false;
    
    const valueSliceDSL = v.sliceDSL ?? '';
    const valueIsWindow = valueSliceDSL.includes('window(');
    const valueIsCohort = valueSliceDSL.includes('cohort(');
    
    if (targetIsWindow && valueIsCohort) return false;
    if (targetIsCohort && valueIsWindow) return false;
    
    return true;
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

