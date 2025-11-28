/**
 * Composite Query Executor
 * 
 * Executes inclusion-exclusion queries by running multiple sub-queries in parallel
 * and combining results with weighted coefficients.
 */

import type { DASRunner } from './DASRunner';
import { parseCompositeQuery, getExecutionTerms, type ParsedFunnel, type CompositeQueryTerm } from './compositeQueryParser';
import { isNodeUpstream } from './buildDslFromEdge';

export interface SubQueryResult {
  id: string;
  from_count: number;
  to_count: number;
  coefficient: number;
  raw: any;  // Full raw result (includes time_series, from_count, to_count, etc.)
}

export interface CombinedResult {
  n: number;
  k: number;
  p_mean: number;
  evidence: { 
    n: number; 
    k: number;
    time_series?: Array<{ date: string; n: number; k: number; p: number }>;
  };
}

/**
 * Execute a composite query (base + minus/plus terms) via DAS Runner.
 * 
 * Returns combined n, k, p_mean using inclusion-exclusion coefficients.
 * 
 * @param queryString - The composite query string (with minus/plus terms)
 * @param baseDsl - Base DSL with from/to already mapped to provider event names
 * @param connectionName - Connection name (e.g., 'amplitude')
 * @param runner - DAS runner instance
 * @param graph - Optional graph for upstream/between categorization of visited nodes
 * @param eventDefinitions - Event definitions for translating event_ids to provider event names
 */
export async function executeCompositeQuery(
  queryString: string,
  baseDsl: any,
  connectionName: string,
  runner: DASRunner,
  graph?: any,
  eventDefinitions?: Record<string, any>
): Promise<CombinedResult> {
  console.log(`[CompositeQuery] Parsing: ${queryString}`);
  
  try {
    // Parse the composite query
    const parsed = parseCompositeQuery(queryString);
    console.log(`[CompositeQuery] Parsed successfully:`, {
      baseFrom: parsed.base.from,
      baseTo: parsed.base.to,
      minusTermsCount: parsed.minusTerms.length,
      plusTermsCount: parsed.plusTerms.length,
      minusTerms: parsed.minusTerms,
      plusTerms: parsed.plusTerms
    });
    
    const terms = getExecutionTerms(parsed);
    console.log(`[CompositeQuery] Generated ${terms.length} execution terms:`, terms.map(t => ({id: t.id, coeff: t.coefficient, from: t.funnel.from, to: t.funnel.to, visited: t.funnel.visited})));
    
    console.log(`[CompositeQuery] Executing ${terms.length} terms (1 base + ${terms.length-1} minus/plus)`);
  
    // Execute all terms in parallel
    const results = await Promise.all(
      terms.map(term => executeSubQuery(term, baseDsl, connectionName, runner, graph, eventDefinitions))
    );
    
    console.log(`[CompositeQuery] All sub-queries completed, combining results...`);
    
    // Combine with weighted coefficients
    const combined = combineInclusionExclusionResults(results);
    console.log(`[CompositeQuery] Combined result:`, combined);
    return combined;
    
  } catch (error) {
    console.error(`[CompositeQuery] PARSING/EXECUTION FAILED:`, error);
    console.error(`[CompositeQuery] Query string was:`, queryString);
    console.error(`[CompositeQuery] baseDsl was:`, baseDsl);
    throw error; // Re-throw to be caught by dataOperationsService
  }
}

/**
 * Execute a single sub-query (base, minus, or plus term).
 * 
 * CRITICAL: Categorizes visited nodes as upstream vs between based on graph topology.
 * - visited_upstream: nodes that must occur BEFORE 'from' (for super-funnel construction)
 * - visited: nodes that must occur BETWEEN 'from' and 'to' (standard funnel)
 */
async function executeSubQuery(
  term: CompositeQueryTerm,
  baseDsl: any,
  connectionName: string,
  runner: DASRunner,
  graph?: any,
  eventDefinitions?: Record<string, any>
): Promise<SubQueryResult> {
  const { funnel, coefficient, id } = term;
  
  // Map node IDs to provider event names for visited nodes
  // AND categorize as upstream vs between based on graph topology
  // (baseDsl already has from/to mapped, so we only need to map visited)
  const mappedVisited: string[] = [];
  const mappedVisitedUpstream: string[] = [];
  
  if (funnel.visited && funnel.visited.length > 0) {
    const { fileRegistry } = await import('../../contexts/TabContext');
    const provider = connectionName?.includes('amplitude') ? 'amplitude' : 'statsig';
    
    // Get the 'from' node ID from baseDsl (it's the provider event name, need to reverse-lookup)
    // Actually, we have the original node IDs in funnel.from, use those with graph
    const fromNodeId = funnel.from;
    
    for (const nodeId of funnel.visited) {
      try {
        const eventFile = fileRegistry.getFile(`event-${nodeId}`);
        const event = eventFile?.data;
        const providerEventName = event?.provider_event_names?.[provider] || nodeId;
        
        // CRITICAL: Categorize as upstream vs between
        // If graph is provided and node is upstream of 'from', put in visited_upstream
        let isUpstream = false;
        if (graph && fromNodeId) {
          isUpstream = isNodeUpstream(nodeId, fromNodeId, graph);
        }
        
        if (isUpstream) {
          mappedVisitedUpstream.push(providerEventName);
          console.log(`[SubQuery ${id}] Mapped visited UPSTREAM node: ${nodeId} → ${providerEventName}`);
        } else {
          mappedVisited.push(providerEventName);
          console.log(`[SubQuery ${id}] Mapped visited BETWEEN node: ${nodeId} → ${providerEventName}`);
        }
      } catch (error) {
        console.warn(`[SubQuery ${id}] Failed to load event ${nodeId}, using raw ID:`, error);
        // Default to between if we can't determine
        mappedVisited.push(nodeId);
      }
    }
  }
  
  // Build query payload for this funnel
  // CRITICAL: DON'T override from/to (they're already correct in baseDsl with provider event names)
  // Include both visited (between) and visited_upstream for super-funnel construction
  const subQueryPayload = {
    ...baseDsl,
    visited: mappedVisited.length > 0 ? mappedVisited : undefined,
    visited_upstream: mappedVisitedUpstream.length > 0 ? mappedVisitedUpstream : undefined,
    visitedAny: (funnel.visitedAny && funnel.visitedAny.length > 0) ? funnel.visitedAny : undefined,
    // Explicitly preserve window and mode
    window: baseDsl.window,
    mode: baseDsl.mode || 'ordered'
  };
  
  const visitedStr = mappedVisited.length > 0 ? `.visited(${mappedVisited.join(',')})` : '';
  const upstreamStr = mappedVisitedUpstream.length > 0 ? `.visited_upstream(${mappedVisitedUpstream.join(',')})` : '';
  console.log(`[SubQuery ${id}] Executing: from(${baseDsl.from}).to(${baseDsl.to})${upstreamStr}${visitedStr} [coeff=${coefficient>0?'+':''}${coefficient}] (mode=${subQueryPayload.mode})`);
  
  try {
    // CRITICAL: Pass window and context mode so sub-queries can return daily time-series
    // Also pass eventDefinitions so adapter can translate event_ids to provider event names
    const result = await runner.execute(connectionName, subQueryPayload, {
      window: baseDsl.window,
      context: { mode: subQueryPayload.mode },  // Pass 'daily' or 'aggregate' mode to adapter
      eventDefinitions  // Event definitions for event_id → provider event name translation
    });
    
    if (!result.success) {
      throw new Error(result.error || 'Query execution failed');
    }
    
    // TypeScript narrows to ExecutionSuccess after success check
    const successResult = result as { success: true; raw: Record<string, unknown> };
    const raw = successResult.raw || {};
    
    // DIAGNOSTIC: Show what we actually received
    console.log(`[SubQuery ${id}] Raw result structure:`, {
      hasRaw: !!raw,
      rawKeys: Object.keys(raw),
      from_count_in_raw: raw.from_count,
      to_count_in_raw: raw.to_count,
      hasExtracted: !!raw.extracted,
      from_count_in_extracted: (raw.extracted as any)?.from_count
    });
    
    // CRITICAL FIX: DASRunner puts counts directly in raw, NOT under raw.extracted
    // Try raw.from_count first, fall back to raw.extracted.from_count for compatibility
    const from_count = (raw.from_count as number) || (raw.extracted as any)?.from_count || 0;
    const to_count = (raw.to_count as number) || (raw.extracted as any)?.to_count || 0;
    
    const subResult: SubQueryResult = {
      id,
      from_count,
      to_count,
      coefficient,
      raw  // Store FULL raw result (includes time_series, from_count, to_count, etc.)
    };
    
    console.log(`[SubQuery ${id}] Result: from=${subResult.from_count}, to=${subResult.to_count}, hasTimeSeries=${!!raw.time_series}`);
    
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
  
  // CRITICAL: Combine time-series data (if present in all sub-queries)
  let time_series: Array<{ date: string; n: number; k: number; p: number }> | undefined;
  
  // Check if ALL sub-queries have time-series
  const allHaveTimeSeries = results.every(r => 
    r.raw?.time_series && Array.isArray(r.raw.time_series) && r.raw.time_series.length > 0
  );
  
  if (allHaveTimeSeries) {
    console.log(`[Combine] Combining time-series from ${results.length} sub-queries`);
    
    // Extract base time-series (from first query)
    const baseTimeSeries: Array<{ date: string; n: number; k: number }> = base.raw.time_series;
    
    // Build date map: date -> {n, k}
    const dateMap = new Map<string, { n: number; k: number }>();
    
    // Start with base time-series
    for (const point of baseTimeSeries) {
      dateMap.set(point.date, { n: point.n, k: point.k });
    }
    
    // Apply inclusion-exclusion to each date's k value
    for (const result of results.slice(1)) {
      const timeSeries = result.raw.time_series as Array<{ date: string; n: number; k: number }>;
      
      for (const point of timeSeries) {
        const existing = dateMap.get(point.date);
        if (existing) {
          // Apply coefficient to k (inclusion-exclusion)
          // k_adjusted = k_base + coefficient * k_term
          existing.k = existing.k + (result.coefficient * point.k);
        }
      }
    }
    
    // Convert map back to array, clamping k to valid range [0, n]
    time_series = Array.from(dateMap.entries()).map(([date, data]) => {
      const k_clamped = Math.max(0, Math.min(data.n, data.k));
      const p = data.n > 0 ? k_clamped / data.n : 0;
      return {
        date,
        n: data.n,
        k: k_clamped,
        p
      };
    });
    
    // Sort by date
    time_series.sort((a, b) => a.date.localeCompare(b.date));
    
    console.log(`[Combine] Combined time-series: ${time_series.length} days`);
  } else {
    console.log(`[Combine] No time-series to combine (not all sub-queries returned daily data)`);
  }
  
  return {
    n,
    k,
    p_mean,
    evidence: { 
      n, 
      k,
      time_series // Include combined time-series (if available)
    }
  };
}

