/**
 * Context Aggregation Service
 * 
 * Implements 2D grid aggregation (context × date) for contexted parameter data.
 * Handles MECE aggregation, subquery generation, and window overlap scenarios.
 */

import type { ParsedConstraints } from '../lib/queryDSL';
import type { ParameterValue } from '../types/parameterData';
import type { DateRange } from '../types';
import { contextRegistry } from './contextRegistry';
import { isolateSlice } from './sliceIsolation';
import { parseConstraints, normalizeConstraintString } from '../lib/queryDSL';
import { mergeParameterTimeSeries } from './timeSeriesUtils';

/**
 * Aggregate n/k from multiple value entries, deduplicating by date.
 * 
 * CRITICAL: When multiple value entries have overlapping dates (e.g., from
 * successive fetches), we must NOT sum the entry-level n/k fields directly
 * as that would double-count. Instead, merge the daily data and sum that.
 * 
 * For entries without daily data, fall back to entry-level n/k.
 */
function aggregateValuesWithDedup(values: ParameterValue[]): { n: number; k: number } {
  // Separate entries with daily data from those without
  const withDaily = values.filter(v => v.dates?.length && v.n_daily?.length && v.k_daily?.length);
  const withoutDaily = values.filter(v => !v.dates?.length || !v.n_daily?.length || !v.k_daily?.length);
  
  // Merge daily data from all entries (deduplicates by date - later entries win)
  const mergedTimeSeries = mergeParameterTimeSeries(...withDaily);
  
  // Sum from merged daily data
  const dailyN = mergedTimeSeries.reduce((sum, p) => sum + p.n, 0);
  const dailyK = mergedTimeSeries.reduce((sum, p) => sum + p.k, 0);
  
  // Sum from entries without daily data (can't deduplicate, just sum)
  const nonDailyN = withoutDaily.reduce((sum, v) => sum + (v.n || 0), 0);
  const nonDailyK = withoutDaily.reduce((sum, v) => sum + (v.k || 0), 0);
  
  return {
    n: dailyN + nonDailyN,
    k: dailyK + nonDailyK
  };
}

export type ContextCombination = Record<string, string>;

export interface AggregationResult {
  status: 'complete' | 'mece_aggregation' | 'partial_data' | 'prorated';
  data: { n: number; k: number; mean: number; stdev: number };
  usedWindows: ParameterValue[];
  warnings: string[];
  fetchedSubqueries?: number;
}

export interface QueryRequest {
  variable: { id: string; windows?: ParameterValue[] };
  constraints: ParsedConstraints;
  sourceType: 'daily' | 'aggregate';
}

/**
 * Determine context combinations from constraints.
 */
export function determineContextCombinations(constraints: ParsedConstraints): ContextCombination[] {
  const combos: ContextCombination[] = [];
  
  // If query has explicit context constraints
  if (constraints.context.length > 0 || constraints.contextAny.length > 0) {
    // Build combination from explicit constraints
    const combo: ContextCombination = {};
    
    // Add each context(key:value)
    for (const ctx of constraints.context) {
      combo[ctx.key] = ctx.value;
    }
    
    // For contextAny: for v1, just take first value of each key
    // (Full explosion to multiple combos deferred to future)
    for (const ctxAny of constraints.contextAny) {
      if (ctxAny.pairs.length > 0) {
        const firstPair = ctxAny.pairs[0];
        combo[firstPair.key] = firstPair.value;
      }
    }
    
    combos.push(combo);
  } else {
    // No explicit contexts: uncontexted query
    combos.push({});
  }
  
  return combos;
}

/**
 * Check if window contexts match query combo.
 */
export function contextMatches(
  windowContexts: Array<{key: string; value: string}>,
  queryCombo: ContextCombination
): boolean {
  const windowSet = new Set(windowContexts.map(c => `${c.key}:${c.value}`));
  const querySet = new Set(Object.entries(queryCombo).map(([k, v]) => `${k}:${v}`));
  
  if (windowSet.size !== querySet.size) return false;
  for (const item of querySet) {
    if (!windowSet.has(item)) return false;
  }
  return true;
}

/**
 * Build context DSL string from combination.
 */
export function buildContextDSL(contextCombo: ContextCombination): string {
  if (Object.keys(contextCombo).length === 0) {
    return ''; // Uncontexted
  }
  
  // Build context(...) clauses, alphabetically by key
  const sorted = Object.entries(contextCombo).sort(([a], [b]) => a.localeCompare(b));
  return sorted.map(([key, value]) => `context(${key}:${value})`).join('.');
}

/**
 * Try to aggregate across a MECE partition when query has no context constraints.
 * Handles mixed MECE/non-MECE keys correctly.
 */
export async function tryMECEAggregationAcrossContexts(
  perContextResults: Array<{ n: number; k: number; contextCombo: ContextCombination }>,
  variable: { id: string; windows?: ParameterValue[] }
): Promise<AggregationResult> {
  
  // Group results by single context key
  const singleKeyGroups: Record<string, typeof perContextResults> = {};
  
  for (const result of perContextResults) {
    const keys = Object.keys(result.contextCombo);
    
    // Only group if exactly one context key
    if (keys.length === 1) {
      const key = keys[0];
      if (!singleKeyGroups[key]) singleKeyGroups[key] = [];
      singleKeyGroups[key].push(result);
    }
  }
  
  // For each key group, check if it's MECE and can aggregate
  const aggregatableCandidates: Array<{
    key: string;
    results: typeof perContextResults;
    meceCheck: Awaited<ReturnType<typeof contextRegistry.detectMECEPartition>>;
  }> = [];
  
  for (const [key, results] of Object.entries(singleKeyGroups)) {
    // Build mock windows for MECE check
    const mockWindows = results.map(r => ({
      sliceDSL: buildContextDSL(r.contextCombo)
    }));
    
    const meceCheck = await contextRegistry.detectMECEPartition(mockWindows, key);
    
    // Can we aggregate across this key?
    if (meceCheck.canAggregate) {
      aggregatableCandidates.push({ key, results, meceCheck });
    }
  }
  
  // If exactly one MECE key found, aggregate across it
  if (aggregatableCandidates.length === 1) {
    const { key, results, meceCheck } = aggregatableCandidates[0];
    
    const totalN = results.reduce((sum, r) => sum + r.n, 0);
    const totalK = results.reduce((sum, r) => sum + r.k, 0);
    const mean = totalN > 0 ? totalK / totalN : 0;
    const stdev = Math.sqrt(mean * (1 - mean) / totalN); // Binomial stdev
    
    if (meceCheck.isComplete) {
      return {
        status: 'mece_aggregation',
        data: { n: totalN, k: totalK, mean, stdev },
        usedWindows: [],
        warnings: [`Aggregated across MECE partition of '${key}' (complete coverage)`]
      };
    } else {
      return {
        status: 'partial_data',
        data: { n: totalN, k: totalK, mean, stdev },
        usedWindows: [],
        warnings: [
          `Partial MECE aggregation across '${key}': missing ${meceCheck.missingValues.join(', ')}`,
          'Result represents subset of data; fetch missing values for complete picture'
        ]
      };
    }
  }
  
  // If multiple MECE keys available, prefer complete partition
  if (aggregatableCandidates.length > 1) {
    const completeCandidate = aggregatableCandidates.find(c => c.meceCheck.isComplete);
    const chosen = completeCandidate || aggregatableCandidates[0];
    
    const totalN = chosen.results.reduce((sum, r) => sum + r.n, 0);
    const totalK = chosen.results.reduce((sum, r) => sum + r.k, 0);
    const mean = totalN > 0 ? totalK / totalN : 0;
    const stdev = Math.sqrt(mean * (1 - mean) / totalN);
    
    const otherKeys = aggregatableCandidates
      .filter(c => c.key !== chosen.key)
      .map(c => c.key)
      .join(', ');
    
    return {
      status: 'mece_aggregation',
      data: { n: totalN, k: totalK, mean, stdev },
      usedWindows: [],
      warnings: [
        `Aggregated across MECE partition of '${chosen.key}'`,
        `Note: Also have MECE keys {${otherKeys}}`
      ]
    };
  }
  
  // Check if we have uncontexted data
  const uncontextedResult = perContextResults.find(r => Object.keys(r.contextCombo).length === 0);
  if (uncontextedResult) {
    const mean = uncontextedResult.n > 0 ? uncontextedResult.k / uncontextedResult.n : 0;
    const stdev = Math.sqrt(mean * (1 - mean) / uncontextedResult.n);
    
    return {
      status: 'complete',
      data: { n: uncontextedResult.n, k: uncontextedResult.k, mean, stdev },
      usedWindows: [],
      warnings: []
    };
  }
  
  // No MECE partition and no uncontexted data: aggregate what we have with warning
  const totalN = perContextResults.reduce((sum, r) => sum + r.n, 0);
  const totalK = perContextResults.reduce((sum, r) => sum + r.k, 0);
  const mean = totalN > 0 ? totalK / totalN : 0;
  const stdev = Math.sqrt(mean * (1 - mean) / totalN);
  
  return {
    status: 'partial_data',
    data: { n: totalN, k: totalK, mean, stdev },
    usedWindows: [],
    warnings: [
      'Aggregated across NON-MECE context slices; result represents only a subset',
      'Add a context constraint or ensure MECE configuration for complete total'
    ]
  };
}

/**
 * Main aggregation entry point with contexts support.
 * 
 * For v1: Simplified implementation that handles basic context isolation.
 * Full 2D grid with subquery generation deferred to future iterations.
 */
export async function aggregateWindowsWithContexts(
  request: QueryRequest
): Promise<AggregationResult> {
  
  const { variable, constraints } = request;
  
  // Determine context combinations
  const contextCombos = determineContextCombinations(constraints);
  
  // For v1: Only handle single context combo (no subquery generation yet)
  if (contextCombos.length === 1) {
    const combo = contextCombos[0];
    const sliceDSL = buildContextDSL(combo);
    
    // Isolate values for this slice
    const allValues = (variable.windows || []) as ParameterValue[];
    const sliceValues = isolateSlice(allValues, sliceDSL);
    
    if (sliceValues.length === 0) {
      // No data for this slice
      return {
        status: 'partial_data',
        data: { n: 0, k: 0, mean: 0, stdev: 0 },
        usedWindows: [],
        warnings: [`No data found for slice: ${sliceDSL || '(uncontexted)'}`]
      };
    }
    
    // Aggregate values for this slice (with deduplication for overlapping dates)
    const { n: totalN, k: totalK } = aggregateValuesWithDedup(sliceValues);
    const mean = totalN > 0 ? totalK / totalN : 0;
    const stdev = totalN > 0 ? Math.sqrt(mean * (1 - mean) / totalN) : 0;
    
    return {
      status: 'complete',
      data: { n: totalN, k: totalK, mean, stdev },
      usedWindows: sliceValues,
      warnings: []
    };
  }
  
  // If no context constraints, try MECE aggregation
  if (constraints.context.length === 0 && constraints.contextAny.length === 0) {
    // Collect all contexted windows
    const allValues = (variable.windows || []) as ParameterValue[];
    const contextedValues = allValues.filter(v => v.sliceDSL && v.sliceDSL !== '');
    
    if (contextedValues.length === 0) {
      // No contexted data, use uncontexted
      const uncontextedValues = isolateSlice(allValues, '');
      const { n: totalN, k: totalK } = aggregateValuesWithDedup(uncontextedValues);
      const mean = totalN > 0 ? totalK / totalN : 0;
      const stdev = totalN > 0 ? Math.sqrt(mean * (1 - mean) / totalN) : 0;
      
      return {
        status: 'complete',
        data: { n: totalN, k: totalK, mean, stdev },
        usedWindows: uncontextedValues,
        warnings: []
      };
    }
    
    // Parse context combos from existing windows
    const perContextResults: Array<{ n: number; k: number; contextCombo: ContextCombination }> = [];
    const seenCombos = new Set<string>();
    
    for (const value of contextedValues) {
      const parsed = parseConstraints(value.sliceDSL || '');
      const combo: ContextCombination = {};
      for (const ctx of parsed.context) {
        combo[ctx.key] = ctx.value;
      }
      
      const comboKey = JSON.stringify(combo);
      if (!seenCombos.has(comboKey)) {
        seenCombos.add(comboKey);
        
        // Get all values for this combo (with deduplication for overlapping dates)
        const comboValues = isolateSlice(allValues, buildContextDSL(combo));
        const { n, k } = aggregateValuesWithDedup(comboValues);
        
        perContextResults.push({ n, k, contextCombo: combo });
      }
    }
    
    // Try MECE aggregation
    return await tryMECEAggregationAcrossContexts(perContextResults, variable);
  }
  
  // Multiple combos not supported in v1
  return {
    status: 'partial_data',
    data: { n: 0, k: 0, mean: 0, stdev: 0 },
    usedWindows: [],
    warnings: ['Multiple context combinations not yet supported']
  };
}

