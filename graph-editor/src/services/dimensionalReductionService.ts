/**
 * Dimensional Reduction Service
 *
 * Handles multi-dimensional context aggregation when query specifies fewer
 * dimensions than cache contains.
 *
 * Principles:
 * - Only aggregate when ALL unspecified dimensions are MECE-verified
 * - Sum n_daily/k_daily across slices (correct for count-based metrics)
 * - Preserve date alignment (all slices must have same date coverage)
 *
 * @see docs/current/multi-sig-matching.md §7 for full design specification
 */

import type { ParameterValue } from '../types/parameterData';
import { parseConstraints } from '../lib/queryDSL';
import { extractSliceDimensions } from './sliceIsolation';
import { contextRegistry } from './contextRegistry';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface DimensionalReductionResult {
  kind: 'reduced' | 'not_reducible';
  reason?: string;
  aggregatedValues?: ParameterValue[];
  diagnostics: {
    specifiedDimensions: string[];
    unspecifiedDimensions: string[];
    slicesUsed: number;
    meceVerification: Record<string, { isComplete: boolean; canAggregate: boolean; values: string[] }>;
    warnings: string[];
  };
}

export interface MECEVerificationResult {
  isMECE: boolean;
  isComplete: boolean;
  canAggregate: boolean;
  valuesPresent: string[];
  missingValues: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Context Map Extraction (with memoisation per H2)
// ─────────────────────────────────────────────────────────────────────────────

const contextMapCache = new Map<string, Map<string, string>>();

/**
 * Extract context dimensions from a sliceDSL string.
 * Returns a map of key → value for all context() clauses.
 *
 * Performance: O(1) for repeated calls with the same DSL string (memoised).
 */
export function extractContextMap(sliceDSL: string): Map<string, string> {
  const key = sliceDSL ?? '';

  const cached = contextMapCache.get(key);
  if (cached !== undefined) {
    return cached;
  }

  // Actual parsing logic
  const dims = extractSliceDimensions(key);
  if (!dims) {
    const empty = new Map<string, string>();
    contextMapCache.set(key, empty);
    return empty;
  }

  try {
    const parsed = parseConstraints(dims);
    const map = new Map<string, string>();
    for (const ctx of parsed.context) {
      map.set(ctx.key, ctx.value);
    }

    contextMapCache.set(key, map);
    return map;
  } catch {
    // Parsing failed - return empty map
    const empty = new Map<string, string>();
    contextMapCache.set(key, empty);
    return empty;
  }
}

/**
 * Clear the context map cache (e.g., after workspace switch).
 */
export function clearContextMapCache(): void {
  contextMapCache.clear();
}

// ─────────────────────────────────────────────────────────────────────────────
// Dimension Matching
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if a slice matches ALL specified dimension values.
 */
export function matchesSpecifiedDimensions(
  sliceContextMap: Map<string, string>,
  specifiedDimensions: Map<string, string>
): boolean {
  for (const [key, value] of specifiedDimensions) {
    if (sliceContextMap.get(key) !== value) return false;
  }
  return true;
}

/**
 * Identify unspecified dimensions (keys in slice but not in query).
 */
export function getUnspecifiedDimensionsFromMaps(
  sliceContextMap: Map<string, string>,
  queryContextMap: Map<string, string>
): string[] {
  const unspecified: string[] = [];
  for (const key of sliceContextMap.keys()) {
    if (!queryContextMap.has(key)) {
      unspecified.push(key);
    }
  }
  return unspecified.sort();
}

// ─────────────────────────────────────────────────────────────────────────────
// MECE Verification
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Verify MECE for a specific dimension within filtered slices.
 */
export function verifyMECEForDimension(
  slices: ParameterValue[],
  dimensionKey: string
): MECEVerificationResult {
  // Extract all values for this dimension from slices
  const valuesPresent = new Set<string>();
  for (const slice of slices) {
    const ctxMap = extractContextMap(slice.sliceDSL ?? '');
    const value = ctxMap.get(dimensionKey);
    if (value) valuesPresent.add(value);
  }

  // Check against context definition
  const meceResult = contextRegistry.detectMECEPartitionSync(
    Array.from(valuesPresent).map((v) => ({ sliceDSL: `context(${dimensionKey}:${v})` })),
    dimensionKey
  );

  return {
    isMECE: meceResult.isMECE,
    isComplete: meceResult.isComplete,
    canAggregate: meceResult.canAggregate,
    valuesPresent: Array.from(valuesPresent).sort(),
    missingValues: meceResult.missingValues,
  };
}

/**
 * Verify all combinations exist for multi-dimensional MECE (H4 bounded implementation).
 */
export function verifyAllCombinationsExist(
  slices: ParameterValue[],
  unspecifiedDimensions: string[]
): { complete: boolean; missingCombinations: string[] } {
  // Fast path: single dimension doesn't need combination check
  if (unspecifiedDimensions.length <= 1) {
    return { complete: true, missingCombinations: [] };
  }

  // Guard: Limit dimensionality to prevent combinatorial explosion
  // Real-world queries rarely exceed 3 dimensions
  if (unspecifiedDimensions.length > 4) {
    console.warn(
      `verifyAllCombinationsExist: ${unspecifiedDimensions.length} dimensions, skipping full verification`
    );
    return { complete: false, missingCombinations: ['too_many_dimensions'] };
  }

  // Build set of actual combinations (O(n) where n = slices.length)
  const actualCombinations = new Set<string>();
  for (const slice of slices) {
    const ctxMap = extractContextMap(slice.sliceDSL ?? '');
    const combo = unspecifiedDimensions
      .map((d) => `${d}:${ctxMap.get(d) ?? ''}`)
      .sort()
      .join('|');
    actualCombinations.add(combo);
  }

  // Collect dimension values (O(n))
  const dimensionValues: Map<string, Set<string>> = new Map();
  for (const dimKey of unspecifiedDimensions) {
    dimensionValues.set(dimKey, new Set());
  }
  for (const slice of slices) {
    const ctxMap = extractContextMap(slice.sliceDSL ?? '');
    for (const dimKey of unspecifiedDimensions) {
      const v = ctxMap.get(dimKey);
      if (v) dimensionValues.get(dimKey)!.add(v);
    }
  }

  // Calculate expected count without generating all combinations
  let expectedCount = 1;
  for (const values of dimensionValues.values()) {
    expectedCount *= values.size;
  }

  // Fast check: if actual count equals expected, we're complete
  if (actualCombinations.size === expectedCount) {
    return { complete: true, missingCombinations: [] };
  }

  // Slow path: find missing combinations (only if incomplete)
  // Limit to reporting first 10 missing for diagnostics
  const missing: string[] = [];
  const arrays = unspecifiedDimensions.map((d) => Array.from(dimensionValues.get(d)!).sort());

  function* generateCombinations(index: number, current: string[]): Generator<string[]> {
    if (index === arrays.length) {
      yield [...current];
      return;
    }
    for (const v of arrays[index]) {
      current.push(v);
      yield* generateCombinations(index + 1, current);
      current.pop();
    }
  }

  for (const combo of generateCombinations(0, [])) {
    const key = unspecifiedDimensions
      .map((d, i) => `${d}:${combo[i]}`)
      .sort()
      .join('|');
    if (!actualCombinations.has(key)) {
      missing.push(key);
      if (missing.length >= 10) break; // Limit diagnostic output
    }
  }

  return { complete: false, missingCombinations: missing };
}

// ─────────────────────────────────────────────────────────────────────────────
// Slice Deduplication (H6)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Deduplicate slices before aggregation to prevent double-counting.
 *
 * Dedupes by (sliceDSL, query_signature, window_from, window_to).
 * If duplicates exist (e.g. file corruption), keeps the one with most recent retrieved_at.
 */
export function dedupeSlices(slices: ParameterValue[]): ParameterValue[] {
  const byKey = new Map<string, ParameterValue>();

  for (const slice of slices) {
    const key = [
      slice.sliceDSL ?? '',
      (slice as any).query_signature ?? '',
      slice.window_from ?? '',
      slice.window_to ?? '',
    ].join('|');

    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, slice);
    } else {
      // Keep fresher slice (use data_source.retrieved_at for timestamp)
      const existingTs = existing.data_source?.retrieved_at ? new Date(existing.data_source.retrieved_at).getTime() : 0;
      const newTs = slice.data_source?.retrieved_at ? new Date(slice.data_source.retrieved_at).getTime() : 0;
      if (newTs > existingTs) {
        byKey.set(key, slice);
      }
    }
  }

  return Array.from(byKey.values());
}

// ─────────────────────────────────────────────────────────────────────────────
// Slice Aggregation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Aggregate slices by summing n_daily/k_daily arrays.
 * All slices must have same date arrays (verified by caller).
 *
 * IMPORTANT: Call dedupeSlices() before this function to prevent double-counting.
 */
export function aggregateSlices(slices: ParameterValue[]): ParameterValue | null {
  if (slices.length === 0) return null;
  if (slices.length === 1) return slices[0];

  // Use first slice as template
  const template = slices[0];
  const dates = template.dates;
  if (!dates || dates.length === 0) return null;

  // Verify all slices have same dates
  for (const slice of slices) {
    if (!slice.dates || slice.dates.length !== dates.length) {
      return null; // Date arrays don't match
    }
    for (let i = 0; i < dates.length; i++) {
      if (slice.dates[i] !== dates[i]) return null;
    }
  }

  // Sum n_daily and k_daily
  const n_daily = new Array(dates.length).fill(0);
  const k_daily = new Array(dates.length).fill(0);

  for (const slice of slices) {
    for (let i = 0; i < dates.length; i++) {
      n_daily[i] += slice.n_daily?.[i] ?? 0;
      k_daily[i] += slice.k_daily?.[i] ?? 0;
    }
  }

  // Compute aggregate statistics
  const n = n_daily.reduce((sum, v) => sum + v, 0);
  const k = k_daily.reduce((sum, v) => sum + v, 0);

  return {
    ...template,
    sliceDSL: '', // Becomes uncontexted after full reduction
    n,
    k,
    mean: n > 0 ? k / n : 0,
    n_daily,
    k_daily,
    dates,
    // Preserve data_source from template (aggregation metadata not tracked in type)
    data_source: template.data_source,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Entry Point: Dimensional Reduction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Attempt dimensional reduction for a query over multi-dimensional cache.
 *
 * This function:
 * 1. Parses query dimensions
 * 2. Filters slices to those matching specified dimensions
 * 3. Identifies unspecified dimensions
 * 4. Verifies MECE for each unspecified dimension
 * 5. Aggregates slices if all checks pass
 *
 * @param allSlices - All cached slices to consider
 * @param queryDSL - The query DSL string (e.g., 'context(channel:google)')
 * @returns Result indicating whether reduction was possible and the aggregated values
 */
export function tryDimensionalReduction(
  allSlices: ParameterValue[],
  queryDSL: string
): DimensionalReductionResult {
  const warnings: string[] = [];

  // Parse query dimensions
  const queryDims = extractSliceDimensions(queryDSL);
  const queryContextMap = new Map<string, string>();

  if (queryDims) {
    try {
      const queryParsed = parseConstraints(queryDims);
      for (const ctx of queryParsed.context) {
        queryContextMap.set(ctx.key, ctx.value);
      }
    } catch {
      // Query parsing failed - treat as uncontexted
    }
  }

  // Find slices that match specified dimensions (but may have extras)
  const matchingSlices: ParameterValue[] = [];
  let unspecifiedDimensions: string[] | null = null;

  for (const slice of allSlices) {
    const sliceContextMap = extractContextMap(slice.sliceDSL ?? '');

    if (matchesSpecifiedDimensions(sliceContextMap, queryContextMap)) {
      matchingSlices.push(slice);

      // Determine unspecified dimensions from first matching slice
      if (unspecifiedDimensions === null) {
        unspecifiedDimensions = getUnspecifiedDimensionsFromMaps(sliceContextMap, queryContextMap);
      }
    }
  }

  if (matchingSlices.length === 0) {
    return {
      kind: 'not_reducible',
      reason: 'no_matching_slices',
      diagnostics: {
        specifiedDimensions: Array.from(queryContextMap.keys()),
        unspecifiedDimensions: [],
        slicesUsed: 0,
        meceVerification: {},
        warnings: ['No slices match the specified dimension values'],
      },
    };
  }

  unspecifiedDimensions = unspecifiedDimensions ?? [];

  if (unspecifiedDimensions.length === 0) {
    // No dimensional reduction needed - exact match
    return {
      kind: 'reduced',
      aggregatedValues: matchingSlices,
      diagnostics: {
        specifiedDimensions: Array.from(queryContextMap.keys()),
        unspecifiedDimensions: [],
        slicesUsed: matchingSlices.length,
        meceVerification: {},
        warnings: [],
      },
    };
  }

  // Verify MECE for each unspecified dimension
  const meceVerification: Record<
    string,
    { isComplete: boolean; canAggregate: boolean; values: string[] }
  > = {};

  for (const dimKey of unspecifiedDimensions) {
    const meceCheck = verifyMECEForDimension(matchingSlices, dimKey);
    meceVerification[dimKey] = {
      isComplete: meceCheck.isComplete,
      canAggregate: meceCheck.canAggregate,
      values: meceCheck.valuesPresent,
    };

    if (!meceCheck.isMECE) {
      return {
        kind: 'not_reducible',
        reason: `dimension_not_mece:${dimKey}`,
        diagnostics: {
          specifiedDimensions: Array.from(queryContextMap.keys()),
          unspecifiedDimensions,
          slicesUsed: matchingSlices.length,
          meceVerification,
          warnings: [
            `Dimension '${dimKey}' is not MECE (missing: ${meceCheck.missingValues.join(', ')})`,
          ],
        },
      };
    }

    if (!meceCheck.canAggregate) {
      return {
        kind: 'not_reducible',
        reason: `dimension_not_aggregatable:${dimKey}`,
        diagnostics: {
          specifiedDimensions: Array.from(queryContextMap.keys()),
          unspecifiedDimensions,
          slicesUsed: matchingSlices.length,
          meceVerification,
          warnings: [`Dimension '${dimKey}' policy does not allow aggregation`],
        },
      };
    }

    if (!meceCheck.isComplete) {
      warnings.push(
        `Dimension '${dimKey}' is incomplete but aggregatable (missing: ${meceCheck.missingValues.join(', ')})`
      );
    }
  }

  // Verify all combinations exist for multi-dimensional MECE
  if (unspecifiedDimensions.length > 1) {
    const combosCheck = verifyAllCombinationsExist(matchingSlices, unspecifiedDimensions);
    if (!combosCheck.complete) {
      return {
        kind: 'not_reducible',
        reason: 'incomplete_combinations',
        diagnostics: {
          specifiedDimensions: Array.from(queryContextMap.keys()),
          unspecifiedDimensions,
          slicesUsed: matchingSlices.length,
          meceVerification,
          warnings: [
            ...warnings,
            `Missing combinations: ${combosCheck.missingCombinations.slice(0, 5).join(', ')}${combosCheck.missingCombinations.length > 5 ? '...' : ''}`,
          ],
        },
      };
    }
  }

  // Dedupe before aggregation (H6)
  const dedupedSlices = dedupeSlices(matchingSlices);

  // Aggregate slices
  const aggregated = aggregateSlices(dedupedSlices);

  if (!aggregated) {
    return {
      kind: 'not_reducible',
      reason: 'aggregation_failed',
      diagnostics: {
        specifiedDimensions: Array.from(queryContextMap.keys()),
        unspecifiedDimensions,
        slicesUsed: matchingSlices.length,
        meceVerification,
        warnings: [...warnings, 'Failed to aggregate slices (date arrays may not align)'],
      },
    };
  }

  // Update sliceDSL to reflect remaining dimensions only
  const remainingDims = Array.from(queryContextMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `context(${k}:${v})`)
    .join('.');
  aggregated.sliceDSL = remainingDims || undefined;

  return {
    kind: 'reduced',
    aggregatedValues: [aggregated],
    diagnostics: {
      specifiedDimensions: Array.from(queryContextMap.keys()),
      unspecifiedDimensions,
      slicesUsed: dedupedSlices.length,
      meceVerification,
      warnings,
    },
  };
}
