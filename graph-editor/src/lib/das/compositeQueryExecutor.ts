/**
 * Composite Query Executor
 * 
 * Executes inclusion-exclusion queries by running multiple sub-queries in parallel
 * and combining results with weighted coefficients.
 */

import type { DASRunner } from './DASRunner';
import { parseCompositeQuery, getExecutionTerms, type ParsedFunnel, type CompositeQueryTerm } from './compositeQueryParser';

export interface SubQueryResult {
  id: string;
  from_count: number;
  to_count: number;
  coefficient: number;
  raw_response: any;
}

export interface CombinedResult {
  n: number;
  k: number;
  p_mean: number;
  evidence: { n: number; k: number };
}

/**
 * Execute a composite query (base + minus/plus terms) via DAS Runner.
 * 
 * Returns combined n, k, p_mean using inclusion-exclusion coefficients.
 */
export async function executeCompositeQuery(
  queryString: string,
  baseDsl: any,
  connectionName: string,
  runner: DASRunner
): Promise<CombinedResult> {
  console.log(`[CompositeQuery] Parsing: ${queryString}`);
  
  // Parse the composite query
  const parsed = parseCompositeQuery(queryString);
  const terms = getExecutionTerms(parsed);
  
  console.log(`[CompositeQuery] Executing ${terms.length} terms (1 base + ${terms.length-1} minus/plus)`);
  
  // Execute all terms in parallel
  const results = await Promise.all(
    terms.map(term => executeSubQuery(term, baseDsl, connectionName, runner))
  );
  
  // Combine with weighted coefficients
  return combineInclusionExclusionResults(results);
}

/**
 * Execute a single sub-query (base, minus, or plus term).
 */
async function executeSubQuery(
  term: CompositeQueryTerm,
  baseDsl: any,
  connectionName: string,
  runner: DASRunner
): Promise<SubQueryResult> {
  const { funnel, coefficient, id } = term;
  
  // Build DSL for this funnel
  const dsl = {
    ...baseDsl,
    from: funnel.from,
    to: funnel.to,
    visited: funnel.visited || [],
    visitedAny: funnel.visitedAny || [],
    // Inherit window, mode, filters from base
    window: baseDsl.window,
    mode: baseDsl.mode || 'ordered'
  };
  
  console.log(`[SubQuery ${id}] Executing: from(${funnel.from}).to(${funnel.to}) [coeff=${coefficient>0?'+':''}${coefficient}]`);
  
  try {
    const result = await runner.execute(connectionName, dsl, {});
    
    if (!result.success) {
      throw new Error(result.error || 'Query execution failed');
    }
    
    // TypeScript narrows to ExecutionSuccess after success check
    const successResult = result as { success: true; raw: Record<string, unknown> };
    const raw = successResult.raw || {};
    const extracted = raw.extracted as any;
    
    const subResult: SubQueryResult = {
      id,
      from_count: extracted?.from_count || 0,
      to_count: extracted?.to_count || 0,
      coefficient,
      raw_response: raw.raw_response
    };
    
    console.log(`[SubQuery ${id}] Result: from=${subResult.from_count}, to=${subResult.to_count}`);
    
    return subResult;
  } catch (error) {
    console.error(`[SubQuery ${id}] Failed:`, error);
    throw new Error(`Sub-query ${id} failed: ${error}`);
  }
}

/**
 * Combine sub-query results using inclusion-exclusion with coefficients.
 * 
 * Formula: k = k_base + Σ(coefficient_i × to_count_i)
 * where coefficients are: +1 for base/plus, -1 for minus
 */
function combineInclusionExclusionResults(results: SubQueryResult[]): CombinedResult {
  if (results.length === 0) {
    throw new Error('No results to combine');
  }
  
  // First result is always the base (coefficient +1)
  const base = results[0];
  const n = base.from_count;
  const k_base = base.to_count;
  
  console.log(`[Combine] Base: n=${n}, k_base=${k_base}`);
  
  // Apply weighted sum with coefficients from inclusion-exclusion
  // k = k_base + Σ(coefficient_i * to_count_i)
  let k_adjustment = 0;
  
  for (const result of results.slice(1)) {  // Skip base
    const contrib = result.coefficient * result.to_count;
    k_adjustment += contrib;
    
    console.log(
      `[Combine] Term ${result.id}: coeff=${result.coefficient>0?'+':''}${result.coefficient}, ` +
      `to=${result.to_count}, contrib=${contrib>0?'+':''}${contrib}`
    );
  }
  
  // Final k with clamping to valid range [0, k_base]
  // Note: k_adjustment is typically negative (we're subtracting), so k_base + k_adjustment shrinks k
  const k_computed = k_base + k_adjustment;
  const k = Math.max(0, Math.min(k_base, k_computed));
  
  if (k !== k_computed) {
    console.warn(
      `[Combine] Clamped k from ${k_computed} to ${k} (range: [0, ${k_base}])`
    );
  }
  
  // Guard divide-by-zero
  const p_mean = n > 0 ? k / n : 0;
  
  console.log(
    `[Combine] Final: n=${n}, k=${k} (adjustment=${k_adjustment>0?'+':''}${k_adjustment}), p=${p_mean.toFixed(4)}`
  );
  
  return {
    n,
    k,
    p_mean,
    evidence: { n, k }
  };
}

