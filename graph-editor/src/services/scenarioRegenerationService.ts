/**
 * Scenario Regeneration Service
 * 
 * Handles the core logic for live scenario regeneration:
 * - Splitting DSL into fetch (window, context) and what-if (case, visited) parts
 * - Building DSL strings from parsed components
 * - Computing effective params with what-if overrides baked in
 * 
 * Design Reference: docs/current/project-live-scenarios/design.md §2.3, §3.4
 */

import { parseConstraints, ParsedConstraints, augmentDSLWithConstraint } from '../lib/queryDSL';
import { computeEffectiveEdgeProbability, parseWhatIfDSL } from '../lib/whatIf';
import { Graph, GraphEdge } from '../types';
import { ScenarioParams, NodeParamDiff } from '../types/scenarios';

/**
 * Fetch-related DSL parts (used for API queries)
 */
export interface FetchParts {
  window: { start?: string; end?: string } | null;
  cohort: { start?: string; end?: string } | null;
  context: Array<{ key: string; value: string }>;
  contextAny: Array<{ pairs: Array<{ key: string; value: string }> }>;
}

/**
 * What-if DSL parts (applied as overlays after fetch)
 */
export interface WhatIfParts {
  cases: Array<{ key: string; value: string }>;
  visited: string[];
  visitedAny: string[][];
  exclude: string[];
}

/**
 * Result of splitting a DSL string into fetch and what-if parts
 */
export interface SplitDSLResult {
  fetchParts: FetchParts;
  whatIfParts: WhatIfParts;
}

/**
 * Split a DSL string into fetch parts (window, context) and what-if parts (case, visited, exclude).
 * 
 * This is the core function that enables mixed DSL handling:
 * - Fetch parts are used to query the API
 * - What-if parts are applied as overlays after data is fetched
 * 
 * @param queryDSL - Full DSL string that may contain both fetch and what-if elements
 * @returns Separated fetch and what-if parts
 * 
 * @example
 * splitDSLParts("window(-30d:-1d).context(channel:google).case(my-case:treatment)")
 * // Returns:
 * // {
 * //   fetchParts: { window: { start: '-30d', end: '-1d' }, context: [{ key: 'channel', value: 'google' }], contextAny: [] },
 * //   whatIfParts: { cases: [{ key: 'my-case', value: 'treatment' }], visited: [], visitedAny: [], exclude: [] }
 * // }
 */
export function splitDSLParts(queryDSL: string | null | undefined): SplitDSLResult {
  const parsed = parseConstraints(queryDSL);
  
  return {
    fetchParts: {
      window: parsed.window,
      cohort: parsed.cohort,
      context: parsed.context,
      contextAny: parsed.contextAny,
    },
    whatIfParts: {
      cases: parsed.cases,
      visited: parsed.visited,
      visitedAny: parsed.visitedAny,
      exclude: parsed.exclude,
    },
  };
}

/**
 * Build a DSL string from fetch parts only.
 * 
 * @param parts - Fetch parts (window, context, contextAny)
 * @returns DSL string containing only fetch elements
 * 
 * @example
 * buildFetchDSL({ window: { start: '-30d', end: '-1d' }, context: [{ key: 'channel', value: 'google' }], contextAny: [] })
 * // Returns: "window(-30d:-1d).context(channel:google)"
 */
export function buildFetchDSL(parts: FetchParts): string {
  const segments: string[] = [];
  
  // Window
  if (parts.window) {
    const start = parts.window.start || '';
    const end = parts.window.end || '';
    segments.push(`window(${start}:${end})`);
  }
  
  // Cohort (date-range filter for cohort analysis)
  if (parts.cohort) {
    const start = parts.cohort.start || '';
    const end = parts.cohort.end || '';
    segments.push(`cohort(${start}:${end})`);
  }
  
  // Context (each key:value pair)
  for (const ctx of parts.context) {
    if (ctx.value) {
      segments.push(`context(${ctx.key}:${ctx.value})`);
    } else {
      // Bare key (no value) - still valid
      segments.push(`context(${ctx.key})`);
    }
  }
  
  // ContextAny
  for (const ctxAny of parts.contextAny) {
    const pairStrs = ctxAny.pairs.map(p => `${p.key}:${p.value}`);
    segments.push(`contextAny(${pairStrs.join(',')})`);
  }
  
  return segments.join('.');
}

/**
 * Build a DSL string from what-if parts only.
 * 
 * @param parts - What-if parts (cases, visited, visitedAny, exclude)
 * @returns DSL string containing only what-if elements
 * 
 * @example
 * buildWhatIfDSL({ cases: [{ key: 'my-case', value: 'treatment' }], visited: ['node-a'], visitedAny: [], exclude: [] })
 * // Returns: "case(my-case:treatment).visited(node-a)"
 */
export function buildWhatIfDSL(parts: WhatIfParts): string {
  const segments: string[] = [];
  
  // Cases
  for (const c of parts.cases) {
    segments.push(`case(${c.key}:${c.value})`);
  }
  
  // Visited
  if (parts.visited.length > 0) {
    segments.push(`visited(${parts.visited.join(',')})`);
  }
  
  // VisitedAny
  for (const group of parts.visitedAny) {
    segments.push(`visitedAny(${group.join(',')})`);
  }
  
  // Exclude
  if (parts.exclude.length > 0) {
    segments.push(`exclude(${parts.exclude.join(',')})`);
  }
  
  return segments.join('.');
}

/**
 * Compute effective parameters with what-if overrides "baked in".
 * 
 * This function applies what-if logic (case overrides, visited conditionals, etc.)
 * to produce a ScenarioParams object where all effects are pre-computed.
 * This is used during live scenario regeneration to store the effective state.
 * 
 * @param graph - Current graph (needed for edge/node lookups)
 * @param whatIfDSL - What-if DSL string (case, visited, exclude elements)
 * @param baseParams - Optional base params to start from (default: extract from graph)
 * @returns ScenarioParams with what-if effects baked in
 */
export async function computeEffectiveParams(
  graph: Graph,
  whatIfDSL: string | null | undefined,
  baseParams?: ScenarioParams
): Promise<ScenarioParams> {
  // Start with empty or provided base
  const effectiveEdges: Record<string, any> = {};
  const effectiveNodes: Record<string, NodeParamDiff> = {};
  
  // If no what-if DSL, return empty params (nothing to bake)
  if (!whatIfDSL || !whatIfDSL.trim()) {
    return { edges: {}, nodes: {} };
  }
  
  // Parse the what-if DSL to get case overrides
  const parsed = parseWhatIfDSL(whatIfDSL, graph);
  const caseOverrides = parsed.caseOverrides || {};
  
  // Process each edge - compute effective probability under what-if
  for (const edge of graph.edges || []) {
    const edgeKey = edge.id || edge.uuid;
    if (!edgeKey) continue;
    
    // For case variant edges, we don't modify the edge probability
    // The variant weight is handled separately in node params
    if (edge.case_variant) {
      continue;
    }
    
    // Compute effective probability considering visited conditionals
    const effectiveProb = computeEffectiveEdgeProbability(
      graph,
      edgeKey,
      { whatIfDSL },
      undefined
    );
    
    // Only store if different from base (or if we want to capture all)
    const baseMean = edge.p?.mean;
    if (baseMean !== undefined && Math.abs(effectiveProb - baseMean) > 1e-9) {
      effectiveEdges[edgeKey] = {
        p: { mean: effectiveProb }
      };
    }
  }
  
  // Process case node overrides - bake variant weights
  for (const [caseNodeRef, selectedVariant] of Object.entries(caseOverrides)) {
    // Find the case node
    const caseNode = (graph.nodes || []).find(n =>
      n.type === 'case' && (
        n.id === caseNodeRef ||
        n.uuid === caseNodeRef ||
        n.case?.id === caseNodeRef
      )
    );
    
    if (!caseNode?.case?.variants) continue;
    
    const caseNodeId = caseNode.id || caseNode.uuid;
    if (!caseNodeId) continue;
    
    // Create new variants with baked weights
    const newVariants = caseNode.case.variants.map(v => ({
      name: v.name,
      weight: v.name === selectedVariant ? 1.0 : 0.0
    }));
    
    effectiveNodes[caseNodeId] = {
      case: {
        variants: newVariants
      }
    };
  }
  
  return {
    edges: effectiveEdges,
    nodes: effectiveNodes
  };
}

/**
 * Compute the inherited DSL for a live scenario based on its position in the visible stack.
 * 
 * Live scenarios inherit DSL from:
 * 1. The base DSL (graph.baseDSL)
 * 2. All VISIBLE live scenarios BELOW this one in the visual stack
 * 
 * Visual order: index 0 = TOP of stack (furthest from Base)
 * Scenarios inherit from those BELOW them (higher indices, closer to Base)
 * 
 * Static scenarios are skipped - they don't contribute DSL.
 * 
 * @param scenarioIndex - Index of the target scenario in the VISIBLE scenarios array
 * @param scenarios - VISIBLE scenarios in visual order (index 0 = top, index N = bottom/closest to Base)
 * @param baseDSL - The graph's base DSL
 * @returns Inherited DSL string (to be merged with scenario's own queryDSL)
 */
export function computeInheritedDSL(
  scenarioIndex: number,
  scenarios: Array<{ meta?: { isLive?: boolean; queryDSL?: string; lastEffectiveDSL?: string } }>,
  baseDSL: string | null | undefined
): string {
  // Start with base DSL
  let inherited = baseDSL || '';
  
  // Traverse scenarios BELOW this one (higher indices = closer to Base)
  // Visual stack: [Top, ..., Bottom] where Bottom is closest to Base
  // We iterate from bottom up to (but not including) scenarioIndex
  // This builds: Base + Bottom + ... + (scenarioIndex+1)
  for (let i = scenarios.length - 1; i > scenarioIndex; i--) {
    const scenario = scenarios[i];
    if (!scenario?.meta?.isLive) continue;
    
    // Use the scenario's effective DSL if available, otherwise its queryDSL
    const scenarioDSL = scenario.meta.lastEffectiveDSL || scenario.meta.queryDSL;
    if (scenarioDSL) {
      inherited = augmentDSLWithConstraint(inherited, scenarioDSL);
    }
  }
  
  return inherited;
}

/**
 * Compute the effective fetch DSL for a live scenario.
 * 
 * This merges:
 * 1. The inherited DSL (from base + lower live scenarios)
 * 2. The scenario's own queryDSL (fetch parts only)
 * 
 * @param inheritedDSL - DSL inherited from base and lower live scenarios
 * @param scenarioQueryDSL - This scenario's queryDSL
 * @returns Effective DSL to use for data fetching
 */
export function computeEffectiveFetchDSL(
  inheritedDSL: string | null | undefined,
  scenarioQueryDSL: string | null | undefined
): string {
  // Split the scenario's DSL to get only fetch parts
  const { fetchParts } = splitDSLParts(scenarioQueryDSL);
  const scenarioFetchDSL = buildFetchDSL(fetchParts);
  
  // Merge inherited DSL with scenario's fetch DSL
  // Smart merge: same type replaces, different types combine
  return augmentDSLWithConstraint(inheritedDSL || '', scenarioFetchDSL);
}

/**
 * Check if a scenario is a live scenario.
 * 
 * @param scenario - Scenario to check
 * @returns True if scenario has queryDSL set (making it live/regenerable)
 */
export function isLiveScenario(scenario: { meta?: { queryDSL?: string; isLive?: boolean } }): boolean {
  return Boolean(scenario?.meta?.queryDSL && scenario.meta.queryDSL.trim());
}

/**
 * Generate a human-readable label from a DSL string.
 * 
 * Converts DSL syntax into friendly display text:
 * - window(2-Dec-25:20-Dec-25) → "2-Dec – 20-Dec"
 * - context(channel:google) → "Channel: Google"
 * - window(-90d:-30d) → "90d ago – 30d ago"
 * - Combined DSLs are joined with " · "
 * 
 * @param dsl - DSL string to convert
 * @returns Human-readable label
 */
export function generateSmartLabel(dsl: string | null | undefined): string {
  if (!dsl || !dsl.trim()) return '';
  
  const parsed = parseConstraints(dsl);
  const parts: string[] = [];
  
  // Format window
  if (parsed.window) {
    const start = parsed.window.start || '';
    const end = parsed.window.end || '';
    
    const formatWindowDate = (date: string): string => {
      if (!date) return '';
      
      // Relative date: -90d, -30d, etc.
      const relativeMatch = date.match(/^(-?\d+)([dwmy])$/);
      if (relativeMatch) {
        const num = Math.abs(parseInt(relativeMatch[1], 10));
        const unit = relativeMatch[2];
        const unitLabel = unit === 'd' ? 'd' : unit === 'w' ? 'w' : unit === 'm' ? 'mo' : 'y';
        return `${num}${unitLabel} ago`;
      }
      
      // Absolute date: 2-Dec-25 → "2-Dec"
      const absoluteMatch = date.match(/^(\d{1,2})-([A-Za-z]{3})-\d{2}$/);
      if (absoluteMatch) {
        return `${absoluteMatch[1]}-${absoluteMatch[2]}`;
      }
      
      return date;
    };
    
    const startLabel = formatWindowDate(start);
    const endLabel = formatWindowDate(end);
    
    if (startLabel && endLabel) {
      parts.push(`${startLabel} – ${endLabel}`);
    } else if (startLabel) {
      parts.push(`From ${startLabel}`);
    } else if (endLabel) {
      parts.push(`Until ${endLabel}`);
    }
  }
  
  // Format context(s)
  for (const ctx of parsed.context) {
    const key = ctx.key;
    const value = ctx.value;
    
    // Capitalise key nicely
    const keyLabel = key.charAt(0).toUpperCase() + key.slice(1).replace(/-/g, ' ');
    
    if (value) {
      // Capitalise value nicely
      const valueLabel = value.charAt(0).toUpperCase() + value.slice(1).replace(/-/g, ' ');
      parts.push(`${keyLabel}: ${valueLabel}`);
    } else {
      parts.push(`By ${keyLabel}`);
    }
  }
  
  // Format case overrides
  for (const c of parsed.cases) {
    const keyLabel = c.key.charAt(0).toUpperCase() + c.key.slice(1).replace(/-/g, ' ');
    const valueLabel = c.value.charAt(0).toUpperCase() + c.value.slice(1).replace(/-/g, ' ');
    parts.push(`${keyLabel}: ${valueLabel}`);
  }
  
  // Format visited
  if (parsed.visited.length > 0) {
    if (parsed.visited.length === 1) {
      parts.push(`Visited: ${parsed.visited[0]}`);
    } else {
      parts.push(`Visited: ${parsed.visited.length} nodes`);
    }
  }
  
  // If no parts, return the raw DSL truncated
  if (parts.length === 0) {
    return dsl.length > 30 ? dsl.substring(0, 27) + '...' : dsl;
  }
  
  return parts.join(' · ');
}

/**
 * Minimal scenario interface for batch preparation
 */
export interface ScenarioForBatch {
  id: string;
  meta?: {
    isLive?: boolean;
    queryDSL?: string;
    lastEffectiveDSL?: string;
  };
}

/**
 * Result of preparing a scenario for batch regeneration
 */
export interface PreparedScenario {
  id: string;
  queryDSL: string;
  inheritedDSL: string;
  effectiveFetchDSL: string;
  fetchParts: FetchParts;
  whatIfParts: WhatIfParts;
}

/**
 * Prepare scenarios for batch regeneration.
 * 
 * This function calculates the inherited DSL and effective DSL for each scenario
 * in the correct order (bottom to top in visual stack), updating lastEffectiveDSL
 * as it goes so subsequent scenarios inherit correctly.
 * 
 * @param scenarios - All scenarios (will be filtered to live only)
 * @param visibleOrder - Visual order of scenario IDs (index 0 = top, N = bottom)
 * @param baseDSL - Base DSL to inherit from
 * @returns Array of prepared scenarios ready for regeneration
 */
export function prepareScenariosForBatch(
  scenarios: ScenarioForBatch[],
  visibleOrder: string[],
  baseDSL: string
): PreparedScenario[] {
  // Filter to visible live scenarios only
  const visibleLiveScenarios: ScenarioForBatch[] = [];
  for (const id of visibleOrder) {
    if (id === 'base' || id === 'current') continue;
    const scenario = scenarios.find(s => s.id === id);
    if (scenario?.meta?.isLive && scenario.meta.queryDSL) {
      visibleLiveScenarios.push(scenario);
    }
  }
  
  if (visibleLiveScenarios.length === 0) {
    return [];
  }
  
  // Process from bottom to top (reverse of visual order)
  // Visual order: [top, ..., bottom] -> Process: [bottom, ..., top]
  const processingOrder = [...visibleLiveScenarios].reverse();
  
  // Create a working copy to track lastEffectiveDSL updates
  const workingScenarios: ScenarioForBatch[] = JSON.parse(JSON.stringify(scenarios));
  
  const prepared: PreparedScenario[] = [];
  
  for (const scenario of processingOrder) {
    if (!scenario.meta?.queryDSL) continue;
    
    // Find this scenario's index in the visible list for inheritance calculation
    const visibleIndex = visibleLiveScenarios.findIndex(s => s.id === scenario.id);
    
    // Get working copy for inheritance (has updated lastEffectiveDSL from previous iterations)
    const workingVisible = visibleOrder
      .filter(id => id !== 'base' && id !== 'current')
      .map(id => workingScenarios.find(s => s.id === id))
      .filter((s): s is ScenarioForBatch => s !== undefined);
    
    // Compute inherited DSL
    const inheritedDSL = computeInheritedDSL(visibleIndex, workingVisible, baseDSL);
    
    // Compute effective fetch DSL
    const { fetchParts, whatIfParts } = splitDSLParts(scenario.meta.queryDSL);
    const scenarioFetchDSL = buildFetchDSL(fetchParts);
    const effectiveFetchDSL = computeEffectiveFetchDSL(inheritedDSL, scenarioFetchDSL);
    
    // Update working copy's lastEffectiveDSL for next iteration
    const workingScenario = workingScenarios.find(s => s.id === scenario.id);
    if (workingScenario) {
      if (!workingScenario.meta) workingScenario.meta = {};
      workingScenario.meta.lastEffectiveDSL = effectiveFetchDSL;
    }
    
    prepared.push({
      id: scenario.id,
      queryDSL: scenario.meta.queryDSL,
      inheritedDSL,
      effectiveFetchDSL,
      fetchParts,
      whatIfParts,
    });
  }
  
  return prepared;
}

