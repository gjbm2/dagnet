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
  /**
   * Context axis (MECE).
   * - inherit: no context clause emitted (inherit from below)
   * - set: emit one or more context(key[:value]) entries
   * - clear: emit explicit empty `context()` to clear inherited context
   */
  contextClause: 'inherit' | 'set' | 'clear';
  context: Array<{ key: string; value: string }>;
  /**
   * ContextAny axis (MECE).
   * - inherit: no contextAny clause emitted (inherit from below)
   * - set: emit one or more contextAny(...) entries
   * - clear: emit explicit empty `contextAny()` to clear inherited contextAny
   */
  contextAnyClause: 'inherit' | 'set' | 'clear';
  contextAny: Array<{ pairs: Array<{ key: string; value: string }> }>;
  /**
   * Historical snapshot cut-off (UK date token, e.g. `5-Nov-25` or relative like `-7d`).
   * Treated as a fetch-time clause (like window/cohort), not a what-if overlay.
   */
  asatClause: 'inherit' | 'set' | 'clear';
  asat: string | null;
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
 * Internal sentinel used to represent a "live scenario with no diff".
 *
 * Why:
 * - Many parts of the codebase treat empty queryDSL as "not live".
 * - We want to support "differences" scenarios whose DSL diff can be empty,
 *   without changing that existing contract everywhere.
 */
export const LIVE_EMPTY_DIFF_DSL = '__DAGNET_LIVE_EMPTY_DIFF__';

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
  // Treat the internal sentinel as an empty/no-op DSL.
  if (queryDSL === LIVE_EMPTY_DIFF_DSL) {
    return {
      fetchParts: {
        window: null,
        cohort: null,
        contextClause: 'inherit',
        context: [],
        contextAnyClause: 'inherit',
        contextAny: [],
        asatClause: 'inherit',
        asat: null,
      },
      whatIfParts: { cases: [], visited: [], visitedAny: [], exclude: [] },
    };
  }
  const parsed = parseConstraints(queryDSL);
  
  return {
    fetchParts: {
      window: parsed.window,
      cohort: parsed.cohort,
      contextClause: parsed.contextClausePresent
        ? (parsed.context.length > 0 ? 'set' : 'clear')
        : 'inherit',
      context: parsed.context,
      contextAnyClause: parsed.contextAnyClausePresent
        ? (parsed.contextAny.length > 0 ? 'set' : 'clear')
        : 'inherit',
      contextAny: parsed.contextAny,
      asatClause: parsed.asatClausePresent
        ? (parsed.asat ? 'set' : 'clear')
        : 'inherit',
      asat: parsed.asat,
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
  
  // Context (MECE axis)
  if (parts.contextClause === 'clear') {
    segments.push('context()');
  } else if (parts.contextClause === 'set') {
    for (const ctx of parts.context) {
      if (ctx.value) {
        segments.push(`context(${ctx.key}:${ctx.value})`);
      } else {
        // Bare key (no value) - still valid
        segments.push(`context(${ctx.key})`);
      }
    }
  }
  
  // ContextAny (MECE axis)
  if (parts.contextAnyClause === 'clear') {
    segments.push('contextAny()');
  } else if (parts.contextAnyClause === 'set') {
    for (const ctxAny of parts.contextAny) {
      const pairStrs = ctxAny.pairs.map(p => `${p.key}:${p.value}`);
      segments.push(`contextAny(${pairStrs.join(',')})`);
    }
  }

  // asat() (historical cut-off) — MECE axis with explicit clear support via empty `asat()`.
  if (parts.asatClause === 'clear') {
    segments.push('asat()');
  } else if (parts.asatClause === 'set') {
    if (parts.asat && String(parts.asat).trim()) {
      segments.push(`asat(${String(parts.asat).trim()})`);
    }
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
 * Derive a base DSL for "re-base" operations.
 *
 * UX principle:
 * - Base should normally carry the *date range* (window/cohort) for the current view.
 * - Context-value scenarios should then be created WITHOUT date ranges (so they inherit from base),
 *   which preserves the scenario system’s "build from base" semantics and avoids confusing users.
 */
export function deriveBaseDSLForRebase(currentDSL: string | null | undefined): string {
  const { fetchParts } = splitDSLParts(currentDSL);
  const windowCohortOnly: FetchParts = {
    window: fetchParts.window,
    cohort: fetchParts.cohort,
    contextClause: 'inherit',
    context: [],
    contextAnyClause: 'inherit',
    contextAny: [],
    asatClause: fetchParts.asat ? 'set' : 'inherit',
    asat: fetchParts.asat,
  };
  return buildFetchDSL(windowCohortOnly);
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
 * Compute the minimal query DSL fragment that, when layered on top of baseDSL, yields currentDSL.
 *
 * Notes:
 * - This is used for "Live scenario (differences)".
 * - It's intentionally conservative: it only emits clauses that exist in currentDSL and differ from baseDSL.
 * - If currentDSL equals baseDSL (for the parts we track), this returns an empty string.
 */
export function diffQueryDSLFromBase(
  baseDSL: string | null | undefined,
  currentDSL: string | null | undefined
): string {
  const base = splitDSLParts(baseDSL);
  const cur = splitDSLParts(currentDSL);

  const deltaFetch: FetchParts = {
    window: null,
    cohort: null,
    contextClause: 'inherit',
    context: [],
    contextAnyClause: 'inherit',
    contextAny: [],
    asatClause: 'inherit',
    asat: null,
  };

  // Window/cohort: include only if changed relative to base.
  const baseWindow = base.fetchParts.window;
  const curWindow = cur.fetchParts.window;
  if (
    curWindow &&
    (!baseWindow || baseWindow.start !== curWindow.start || baseWindow.end !== curWindow.end)
  ) {
    deltaFetch.window = curWindow;
  }

  const baseCohort = base.fetchParts.cohort;
  const curCohort = cur.fetchParts.cohort;
  if (
    curCohort &&
    (!baseCohort || baseCohort.start !== curCohort.start || baseCohort.end !== curCohort.end)
  ) {
    deltaFetch.cohort = curCohort;
  }

  // Context pairs: include those present in current but not in base (exact match).
  const baseCtxSet = new Set((base.fetchParts.context || []).map(c => `${c.key}:${c.value || ''}`));
  for (const c of cur.fetchParts.context || []) {
    const key = `${c.key}:${c.value || ''}`;
    if (!baseCtxSet.has(key)) deltaFetch.context.push(c);
  }
  if (deltaFetch.context.length > 0) deltaFetch.contextClause = 'set';

  // ContextAny: best-effort compare by serialised pair list.
  const normaliseCtxAny = (x: FetchParts['contextAny'][number]) =>
    (x.pairs || []).map(p => `${p.key}:${p.value}`).join(',');
  const baseCtxAnySet = new Set((base.fetchParts.contextAny || []).map(normaliseCtxAny));
  for (const grp of cur.fetchParts.contextAny || []) {
    const key = normaliseCtxAny(grp);
    if (!baseCtxAnySet.has(key)) deltaFetch.contextAny.push(grp);
  }
  if (deltaFetch.contextAny.length > 0) deltaFetch.contextAnyClause = 'set';

  // asat(): include only if present in current and changed relative to base.
  // Note: We currently do not represent "removal" (base has asat, current does not) as a diff.
  const baseAsat = base.fetchParts.asat;
  const curAsat = cur.fetchParts.asat;
  if (cur.fetchParts.asatClause === 'set' && curAsat && curAsat !== baseAsat) {
    deltaFetch.asatClause = 'set';
    deltaFetch.asat = curAsat;
  }
  if (cur.fetchParts.asatClause === 'clear' && base.fetchParts.asat) {
    deltaFetch.asatClause = 'clear';
    deltaFetch.asat = null;
  }

  const deltaWhatIf: WhatIfParts = {
    cases: [],
    visited: [],
    visitedAny: [],
    exclude: [],
  };

  // What-if: include only those present in current but not base (exact match).
  const baseCaseSet = new Set((base.whatIfParts.cases || []).map(c => `${c.key}:${c.value}`));
  for (const c of cur.whatIfParts.cases || []) {
    const key = `${c.key}:${c.value}`;
    if (!baseCaseSet.has(key)) deltaWhatIf.cases.push(c);
  }

  const baseVisitedSet = new Set(base.whatIfParts.visited || []);
  for (const v of cur.whatIfParts.visited || []) {
    if (!baseVisitedSet.has(v)) deltaWhatIf.visited.push(v);
  }

  const baseVisitedAnySet = new Set((base.whatIfParts.visitedAny || []).map(g => g.join(',')));
  for (const g of cur.whatIfParts.visitedAny || []) {
    const key = g.join(',');
    if (!baseVisitedAnySet.has(key)) deltaWhatIf.visitedAny.push(g);
  }

  const baseExcludeSet = new Set(base.whatIfParts.exclude || []);
  for (const e of cur.whatIfParts.exclude || []) {
    if (!baseExcludeSet.has(e)) deltaWhatIf.exclude.push(e);
  }

  const fetchDSL = buildFetchDSL(deltaFetch);
  const whatIfDSL = buildWhatIfDSL(deltaWhatIf);
  if (fetchDSL && whatIfDSL) return `${fetchDSL}.${whatIfDSL}`;
  const out = fetchDSL || whatIfDSL || '';
  return out.trim().length > 0 ? out : LIVE_EMPTY_DIFF_DSL;
}

/**
 * Compute the query DSL fragment for "create live scenario from Current".
 *
 * Design:
 * - When the user clicks "+", we create a scenario whose queryDSL is the MECE delta between:
 *   - S: the effective fetch DSL of the currently-visible stack (Base + visible live scenarios, excluding Current)
 *   - C: the Current DSL
 *
 * The delta includes only the axes that differ:
 * A) window/cohort (mutually exclusive)
 * B) context/contextAny (MECE axis; empty `context()` / `contextAny()` means explicit clear)
 * C) asat (MECE axis; empty `asat()` means explicit clear)
 *
 * Clause order is irrelevant.
 */
export function deriveScenarioCreateDeltaDSL(
  stackEffectiveFetchDSL: string | null | undefined,
  currentDSL: string | null | undefined
): string {
  const s = splitDSLParts(stackEffectiveFetchDSL).fetchParts;
  const c = splitDSLParts(currentDSL).fetchParts;

  const delta: FetchParts = {
    window: null,
    cohort: null,
    contextClause: 'inherit',
    context: [],
    contextAnyClause: 'inherit',
    contextAny: [],
    asatClause: 'inherit',
    asat: null,
  };

  // === Axis A: window/cohort (mutually exclusive) ===
  const sMode: QueryDateMode | null = s.cohort ? 'cohort' : (s.window ? 'window' : null);
  const cMode: QueryDateMode | null = c.cohort ? 'cohort' : (c.window ? 'window' : null);

  if (cMode === 'cohort' && c.cohort) {
    const changed =
      sMode !== 'cohort' ||
      !s.cohort ||
      s.cohort.start !== c.cohort.start ||
      s.cohort.end !== c.cohort.end;
    if (changed) delta.cohort = c.cohort;
  } else if (cMode === 'window' && c.window) {
    const changed =
      sMode !== 'window' ||
      !s.window ||
      s.window.start !== c.window.start ||
      s.window.end !== c.window.end;
    if (changed) delta.window = c.window;
  }

  // === Axis B: context ===
  const normaliseContext = (x: FetchParts['context']) => {
    const m = new Map<string, string>();
    for (const kv of x || []) m.set(kv.key, kv.value || '');
    return m;
  };
  const ctxS = normaliseContext(s.context);
  const ctxC = normaliseContext(c.context);
  const ctxSEmpty = ctxS.size === 0;
  const ctxCEmpty = ctxC.size === 0;
  const ctxEqual = (() => {
    if (ctxSEmpty && ctxCEmpty) return true;
    if (ctxS.size !== ctxC.size) return false;
    for (const [k, v] of ctxC.entries()) {
      if (ctxS.get(k) !== v) return false;
    }
    return true;
  })();

  if (!ctxEqual) {
    if (ctxCEmpty) {
      // Current has no context; if stack has any, we must explicitly clear.
      if (!ctxSEmpty) delta.contextClause = 'clear';
    } else {
      delta.contextClause = 'set';
      delta.context = Array.from(ctxC.entries()).map(([key, value]) => ({ key, value }));
    }
  }

  // === Axis B: contextAny ===
  const normaliseContextAny = (x: FetchParts['contextAny']) => {
    const set = new Set<string>();
    for (const grp of x || []) {
      const key = (grp.pairs || []).map(p => `${p.key}:${p.value}`).sort().join(',');
      if (key) set.add(key);
    }
    return set;
  };
  const caS = normaliseContextAny(s.contextAny);
  const caC = normaliseContextAny(c.contextAny);
  const caSEmpty = caS.size === 0;
  const caCEmpty = caC.size === 0;
  const caEqual = (() => {
    if (caSEmpty && caCEmpty) return true;
    if (caS.size !== caC.size) return false;
    for (const k of caC.values()) if (!caS.has(k)) return false;
    return true;
  })();

  if (!caEqual) {
    if (caCEmpty) {
      if (!caSEmpty) delta.contextAnyClause = 'clear';
    } else {
      delta.contextAnyClause = 'set';
      delta.contextAny = Array.from(caC.values()).map((keyStr) => ({
        pairs: keyStr.split(',').map((kv) => {
          const i = kv.indexOf(':');
          return { key: kv.slice(0, i), value: kv.slice(i + 1) };
        }),
      }));
    }
  }

  // === Axis C: asat ===
  const sAsat = s.asat ? String(s.asat).trim() : '';
  const cAsat = c.asat ? String(c.asat).trim() : '';
  if (sAsat !== cAsat) {
    if (!cAsat) {
      if (sAsat) delta.asatClause = 'clear';
    } else {
      delta.asatClause = 'set';
      delta.asat = cAsat;
    }
  }

  return buildFetchDSL(delta);
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
  if (dsl === LIVE_EMPTY_DIFF_DSL) return 'No overrides';
  
  const parsed = parseConstraints(dsl);
  const parts: string[] = [];
  
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

  // Format window
  if (parsed.window) {
    const start = parsed.window.start || '';
    const end = parsed.window.end || '';
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

  // Format cohort (entry window)
  if (parsed.cohort) {
    const start = parsed.cohort.start || '';
    const end = parsed.cohort.end || '';
    const startLabel = formatWindowDate(start);
    const endLabel = formatWindowDate(end);

    const prefix = parsed.cohort.anchor ? `Cohort(${parsed.cohort.anchor})` : 'Cohort';

    if (startLabel && endLabel) {
      parts.push(`${prefix}: ${startLabel} – ${endLabel}`);
    } else if (startLabel) {
      parts.push(`${prefix}: From ${startLabel}`);
    } else if (endLabel) {
      parts.push(`${prefix}: Until ${endLabel}`);
    } else {
      parts.push(prefix);
    }
  }

  // Format asat() (historical cut-off)
  if (parsed.asat) {
    const asatLabel = formatWindowDate(parsed.asat);
    parts.push(`As-at: ${asatLabel}`);
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

export type QueryDateMode = 'window' | 'cohort';

/**
 * Infer whether a DSL is "window mode" or "cohort mode".
 *
 * NOTE: If both are present, cohort wins (we treat this as cohort mode for safety),
 * but callers should ideally normalise to avoid mixed-mode DSLs.
 */
export function inferDateModeFromDSL(dsl: string | null | undefined): QueryDateMode {
  const s = (dsl || '').trim();
  if (!s) return 'window';
  if (s.includes('cohort(')) return 'cohort';
  return 'window';
}

/**
 * Normalise a candidate scenario DSL so it does NOT mix `window()` and `cohort()`.
 *
 * Why:
 * - WindowSelector is either window() OR cohort() mode (single source of truth).
 * - Mixed-mode DSLs like `cohort(...).window(...)` lead to cache misses and, worse,
 *   ambiguous/ignored date ranges in downstream fetch/aggregation.
 *
 * Behaviour:
 * - If `mode === 'cohort'`: prefer `cohort()`, convert any `window()` range into `cohort()`, and drop `window()`.
 * - If `mode === 'window'`: prefer `window()`, convert any `cohort()` range into `window()`, and drop `cohort()`.
 * - Preserve context / contextAny and all what-if clauses.
 */
export function normaliseScenarioDateRangeDSL(candidateDSL: string, mode: QueryDateMode): string {
  const { fetchParts, whatIfParts } = splitDSLParts(candidateDSL);

  const nextFetch: FetchParts = {
    window: fetchParts.window,
    cohort: fetchParts.cohort,
    contextClause: fetchParts.contextClause,
    context: fetchParts.context,
    contextAnyClause: fetchParts.contextAnyClause,
    contextAny: fetchParts.contextAny,
    asatClause: fetchParts.asatClause,
    asat: fetchParts.asat,
  };

  if (mode === 'cohort') {
    if (!nextFetch.cohort && nextFetch.window) {
      nextFetch.cohort = { start: nextFetch.window.start, end: nextFetch.window.end };
    }
    nextFetch.window = null;
  } else {
    if (!nextFetch.window && nextFetch.cohort) {
      nextFetch.window = { start: nextFetch.cohort.start, end: nextFetch.cohort.end };
    }
    nextFetch.cohort = null;
  }

  const fetchDSL = buildFetchDSL(nextFetch);
  const whatIfDSL = buildWhatIfDSL(whatIfParts);
  if (fetchDSL && whatIfDSL) return `${fetchDSL}.${whatIfDSL}`;
  return fetchDSL || whatIfDSL || '';
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

