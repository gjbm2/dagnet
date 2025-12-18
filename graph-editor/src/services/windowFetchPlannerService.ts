/**
 * Window Fetch Planner Service
 * 
 * Centralises all fetch planning, coverage, and staleness decisions for the
 * WindowSelector component.
 * 
 * Key responsibilities:
 * 1. Analyse coverage for current query (delegate to fetchDataService)
 * 2. Assess staleness for covered items (maturity-aware)
 * 3. Produce structured result for UI decisions
 * 4. Execute fetch plans through existing infrastructure
 * 
 * Design docs:
 * - window-fetch-planner-service.md (high-level)
 * - window-fetch-planner-detailed-design.md (detailed)
 * 
 * Single code path guarantee:
 * - Coverage check delegates to fetchDataService.getItemsNeedingFetch()
 * - Execution delegates to fetchDataService.fetchItems()
 * - Planner ADDS staleness semantics but does not redefine coverage
 */

import { fileRegistry } from '../contexts/TabContext';
import { parseConstraints } from '../lib/queryDSL';
import { resolveRelativeDate, normalizeToUK } from '../lib/dateFormat';
import { 
  fetchDataService, 
  getItemsNeedingFetch,
  createFetchItem,
  type FetchItem,
} from './fetchDataService';
import { shouldRefetch, type LatencyConfig } from './fetchRefetchPolicy';
import { extractSliceDimensions, isolateSlice } from './sliceIsolation';
import { resolveMECEPartitionForImplicitUncontextedSync } from './meceSliceService';
import { hasFullSliceCoverageByHeader, isCohortModeValue, parseDate, normalizeDate } from './windowAggregationService';
import { computePathT95, getActiveEdges, type GraphForPath } from './statisticalEnhancementService';
import { computeCohortRetrievalHorizon, type CohortHorizonResult } from './cohortRetrievalHorizon';
import type { ParameterValue } from './paramRegistryService';
import { sessionLogService } from './sessionLogService';
import type { Graph, DateRange } from '../types';

// =============================================================================
// Types
// =============================================================================

/** Outcome state for UI rendering */
export type FetchOutcome = 
  | 'covered_stable'      // All fetchable items covered and mature
  | 'not_covered'         // At least one fetchable item has gaps
  | 'covered_stale';      // Covered but refresh recommended

/** Classification of a single item */
export interface PlannerItem {
  id: string;                           // Unique item ID (matches FetchItem.id pattern)
  type: 'parameter' | 'case';
  objectId: string;                     // Parameter or case file ID
  targetId: string;                     // Edge UUID or node UUID
  paramSlot?: 'p' | 'cost_gbp' | 'labour_cost';
  conditionalIndex?: number;
  /**
   * Optional per-item DSL override (currently used to treat cohort() queries as window()
   * for "simple" edges with no latency and no lagged upstream path).
   *
   * NOTE: This is purely diagnostic/UI metadata; execution already uses the same
   * single code path via fetchDataService.
   */
  targetSliceOverride?: string;
  
  /** Item classification */
  classification: 
    | 'covered_stable'    // Fully covered, mature, no action needed
    | 'needs_fetch'       // Missing coverage, requires fetch from source
    | 'stale_candidate'   // Covered but immature cohorts may have matured
    | 'file_only_gap';    // Has local data but no connection, cannot be fetched
  
  /** For needs_fetch: number of missing dates */
  missingDates?: number;
  
  /** For stale_candidate: reason for staleness */
  stalenessReason?: string;
  
  /** For stale_candidate: retrieval timestamp of existing data */
  retrievedAt?: string;
  
  /** For latency items: t95 or path_t95 used in staleness test */
  effectiveT95?: number;
  
  /** For cohort queries on latency edges: bounded retrieval window (Phase 3) */
  boundedCohortWindow?: DateRange;
  
  /** For cohort queries: horizon calculation result (for logging/debugging) */
  cohortHorizon?: CohortHorizonResult;
}

/** Analysis trigger context for logging */
export type AnalysisTrigger = 'initial_load' | 'dsl_change' | 'user_refresh' | 'post_fetch';

/** Full planner analysis result */
export interface PlannerResult {
  /** Analysis status */
  status: 'pending' | 'complete' | 'error';
  
  /** Error message if status is 'error' */
  error?: string;
  
  /** Derived outcome state */
  outcome: FetchOutcome;
  
  /** Items that can be auto-aggregated from cache */
  autoAggregationItems: PlannerItem[];
  
  /** Items that need fetching from source */
  fetchPlanItems: PlannerItem[];
  
  /** Items that are covered but potentially stale */
  staleCandidates: PlannerItem[];
  
  /** Items with gaps that cannot be fixed (no connection) */
  unfetchableGaps: PlannerItem[];
  
  /** Pre-computed message summaries */
  summaries: {
    /** Tooltip text for fetch button */
    buttonTooltip: string;
    /** Toast message (if any) */
    toastMessage?: string;
    /** Whether toast should be shown */
    showToast: boolean;
  };
  
  /** Metadata for logging */
  analysisContext: {
    trigger: AnalysisTrigger;
    dsl: string;
    timestamp: string;
    durationMs?: number;
  };
}

// =============================================================================
// Staleness check result
// =============================================================================

interface StalenessResult {
  isStale: boolean;
  reason?: string;
  retrievedAt?: string;
  effectiveT95?: number;
}

// =============================================================================
// Service Implementation
// =============================================================================

class WindowFetchPlannerService {
  private static instance: WindowFetchPlannerService;
  
  /** Cached result (invalidated on fetch completion or graph change) */
  private cachedResult: PlannerResult | null = null;
  private cachedDSL: string | null = null;
  private cachedGraphHash: string | null = null;
  
  /** Cached path_t95 map for the current analysis (computed on-demand, not persisted) */
  private cachedPathT95: Map<string, number> | null = null;
  private cachedPathT95GraphHash: string | null = null;
  
  private constructor() {}
  
  static getInstance(): WindowFetchPlannerService {
    if (!WindowFetchPlannerService.instance) {
      WindowFetchPlannerService.instance = new WindowFetchPlannerService();
    }
    return WindowFetchPlannerService.instance;
  }
  
  /**
   * Analyse coverage and staleness for the current query.
   * This is the main entry point for UI decisions.
   * 
   * SIDE-EFFECT FREE: Does not trigger fetches or modify state.
   * 
   * SINGLE CODE PATH: Coverage classification is delegated to
   * fetchDataService.getItemsNeedingFetch() to ensure the planner's
   * view of "needs fetch" is structurally identical to what
   * execution will actually do.
   */
  async analyse(
    graph: Graph,
    dsl: string,
    trigger: AnalysisTrigger
  ): Promise<PlannerResult> {
    const startTime = performance.now();
    const timestamp = new Date().toISOString();
    
    // Start session log operation
    const logOpId = sessionLogService.startOperation(
      'info',
      'data-fetch',
      'PLANNER_ANALYSIS',
      `Analysing fetch requirements for query`,
      { dsl, trigger, timestamp }
    );
    
    try {
      // Check cache first
      const graphHash = this.computeGraphHash(graph);
      if (this.cachedResult && this.cachedDSL === dsl && this.cachedGraphHash === graphHash) {
        sessionLogService.endOperation(logOpId, 'success', 'Using cached analysis result');
        return { ...this.cachedResult, status: 'complete' };
      }
      
      // Extract window from DSL
      const window = this.extractWindowFromDSL(dsl);
      if (!window) {
        const emptyResult = this.buildEmptyResult(dsl, trigger, 'No window in DSL');
        sessionLogService.endOperation(logOpId, 'info', 'No window in DSL');
        return emptyResult;
      }
      
      // ═══════════════════════════════════════════════════════════════════════
      // CRITICAL: Delegate coverage to existing fetchDataService
      // This ensures planner's "needs_fetch" view matches execution behaviour.
      // ═══════════════════════════════════════════════════════════════════════
      const fetchableItems = getItemsNeedingFetch(window, graph, dsl, true);  // checkCache=true
      const allConnectableItems = getItemsNeedingFetch(window, graph, dsl, false); // checkCache=false
      
      const isCohortQuery = dsl.includes('cohort(');
      
      // Build item classifications
      const items: PlannerItem[] = [];
      
      for (const connectable of allConnectableItems) {
        const needsFetch = fetchableItems.some(f => f.id === connectable.id);
        
        // Determine if file-only (has data but no connection)
        const isFileOnly = this.isFileOnlyItem(connectable, graph);
        
        if (isFileOnly) {
          // File-only items: check coverage for messaging, but never "needs_fetch"
          const hasCoverage = this.checkFileOnlyCoverage(connectable, window, dsl);
          items.push({
            ...this.toBaseItem(connectable),
            classification: hasCoverage ? 'covered_stable' : 'file_only_gap',
          });
          continue;
        }
        
        // For cohort queries on latency edges: compute bounded retrieval window
        // This uses path_t95 to limit how far back we fetch cohorts
        let cohortHorizon: CohortHorizonResult | undefined;
        if (isCohortQuery && connectable.type === 'parameter') {
          cohortHorizon = this.computeBoundedCohortWindow(connectable, window, graph);
        }
        
        if (needsFetch) {
          items.push({
            ...this.toBaseItem(connectable),
            classification: 'needs_fetch',
            missingDates: this.countMissingDates(connectable, window, dsl),
            // Include bounded window for cohort queries (Phase 3)
            boundedCohortWindow: cohortHorizon?.boundedWindow,
            cohortHorizon,
          });
          continue;
        }
        
        // Covered: check staleness
        const staleness = this.checkStaleness(connectable, window, dsl, graph, isCohortQuery);
        if (staleness.isStale) {
          items.push({
            ...this.toBaseItem(connectable),
            classification: 'stale_candidate',
            stalenessReason: staleness.reason,
            retrievedAt: staleness.retrievedAt,
            effectiveT95: staleness.effectiveT95,
            // Include bounded window for stale cohort refresh
            boundedCohortWindow: cohortHorizon?.boundedWindow,
            cohortHorizon,
          });
        } else {
          items.push({
            ...this.toBaseItem(connectable),
            classification: 'covered_stable',
          });
        }
      }
      
      // Derive outcome
      const outcome = this.deriveOutcome(items);
      
      // Categorise items
      const autoAggregationItems = items.filter(i => 
        i.classification === 'covered_stable' || i.classification === 'stale_candidate'
      );
      const fetchPlanItems = items.filter(i => i.classification === 'needs_fetch');
      const staleCandidates = items.filter(i => i.classification === 'stale_candidate');
      const unfetchableGaps = items.filter(i => i.classification === 'file_only_gap');
      
      // Build result
      const durationMs = performance.now() - startTime;
      const result: PlannerResult = {
        status: 'complete',
        outcome,
        autoAggregationItems,
        fetchPlanItems,
        staleCandidates,
        unfetchableGaps,
        summaries: {
          buttonTooltip: this.buildButtonTooltip(items, outcome),
          toastMessage: this.buildToastMessage(outcome, items),
          showToast: outcome === 'not_covered' || unfetchableGaps.length > 0,
        },
        analysisContext: { trigger, dsl, timestamp, durationMs },
      };
      
      // Cache result
      this.cachedResult = result;
      this.cachedDSL = dsl;
      this.cachedGraphHash = graphHash;
      
      // Log summary
      sessionLogService.addChild(logOpId, 'info', 'PLANNER_ITEMS',
        `Inspected ${items.length} items: ${autoAggregationItems.length - staleCandidates.length} covered, ${fetchPlanItems.length} need fetch, ${staleCandidates.length} stale, ${unfetchableGaps.length} file-only`,
        undefined,
        { itemCount: items.length, covered: autoAggregationItems.length - staleCandidates.length, needsFetch: fetchPlanItems.length, stale: staleCandidates.length, unfetchable: unfetchableGaps.length }
      );
      
      // DIAGNOSTIC: Detailed per-item coverage analysis
      if (sessionLogService.getDiagnosticLoggingEnabled() && items.length > 0) {
        try {
          this.logDetailedCoverageAnalysis(logOpId, items, window, dsl, graph);
        } catch (e) {
          // Diagnostics must never fail the planner. If anything goes wrong, degrade gracefully.
          const msg = e instanceof Error ? e.message : String(e);
          sessionLogService.addChild(
            logOpId,
            'warning',
            'PLANNER_DIAGNOSTIC_ERROR',
            'Planner diagnostic analysis failed (non-fatal)',
            msg
          );
        }
      }
      
      sessionLogService.endOperation(logOpId, 'success', `Outcome: ${outcome}`, { outcome, durationMs });
      
      return result;
      
    } catch (err: any) {
      sessionLogService.endOperation(logOpId, 'error', err.message);
      
      return {
        status: 'error',
        error: err.message,
        outcome: 'covered_stable', // Safe default
        autoAggregationItems: [],
        fetchPlanItems: [],
        staleCandidates: [],
        unfetchableGaps: [],
        summaries: {
          buttonTooltip: 'Error checking coverage. Click to retry.',
          toastMessage: `Coverage check failed: ${err.message}`,
          showToast: true,
        },
        analysisContext: { trigger, dsl, timestamp: new Date().toISOString() },
      };
    }
  }
  
  /**
   * Execute the fetch plan.
   * 
   * IMPORTANT: Always re-runs analyse() internally to ensure
   * the fetch plan is fresh and matches what would be fetched.
   * This guarantees the single-path property between dry-run and execution.
   */
  async executeFetchPlan(
    graph: Graph,
    setGraph: (g: Graph | null) => void,
    dsl: string
  ): Promise<PlannerResult> {
    const triageLogId = sessionLogService.startOperation(
      'info',
      'data-fetch',
      'FETCH_TRIAGE',
      `Fetch triage for query`,
      { dsl }
    );
    
    try {
      // ═══════════════════════════════════════════════════════════════════════
      // CRITICAL: Re-analyse to get fresh plan.
      // Never trust a stale PlannerResult passed from the component.
      // ═══════════════════════════════════════════════════════════════════════
      const freshResult = await this.analyse(graph, dsl, 'user_refresh');
      
      const fetchItems = freshResult.fetchPlanItems;
      const staleItems = freshResult.staleCandidates;
      
      // Log triage decision
      if (fetchItems.length > 0) {
        sessionLogService.addChild(triageLogId, 'info', 'FETCH_GAPS',
          `Fetching ${fetchItems.length} items with coverage gaps`,
          undefined,
          { items: fetchItems.map(i => i.id) }
        );
      }
      
      if (staleItems.length > 0) {
        sessionLogService.addChild(triageLogId, 'info', 'FETCH_STALE',
          `Refreshing ${staleItems.length} stale items`,
          undefined,
          { items: staleItems.map(i => i.id), reasons: staleItems.map(i => i.stalenessReason) }
        );
      }
      
      if (freshResult.outcome === 'covered_stable') {
        sessionLogService.addChild(triageLogId, 'info', 'NO_FETCH_NEEDED',
          'All items covered and mature, no fetch required',
          undefined,
          { itemCount: freshResult.autoAggregationItems.length }
        );
      }
      
      // Execute fetch
      const allItemsToFetch = [...fetchItems, ...staleItems];
      if (allItemsToFetch.length > 0) {
        const fetchItemsList = allItemsToFetch.map(i => createFetchItem(
          i.type, i.objectId, i.targetId, { 
            paramSlot: i.paramSlot,
            boundedCohortWindow: i.boundedCohortWindow 
          }
        ));
        
        // Extract window for fetch
        const window = this.extractWindowFromDSL(dsl);
        if (window) {
          // CRITICAL: Track graph updates across sequential fetches
          // Without this, each item uses the stale original graph and updates are lost
          let currentGraph: Graph | null = graph;
          const trackingSetGraph = (newGraph: Graph | null) => {
            currentGraph = newGraph;
            setGraph(newGraph);
          };
          const getUpdatedGraph = () => currentGraph;
          
          await fetchDataService.fetchItems(
            fetchItemsList,
            { 
              mode: 'versioned',
              parentLogId: triageLogId,
            },
            graph,
            trackingSetGraph,
            dsl,
            getUpdatedGraph  // Pass graph tracker for sequential updates
          );
        }
      }
      
      sessionLogService.endOperation(triageLogId, 'success', 
        `Completed: ${allItemsToFetch.length} items fetched`);
      
      // Invalidate cache and return fresh analysis
      this.invalidateCache();
      return this.analyse(graph, dsl, 'post_fetch');
      
    } catch (err: any) {
      sessionLogService.endOperation(triageLogId, 'error', err.message);
      throw err;
    }
  }
  
  /**
   * Invalidate cached analysis (called after fetch or graph change).
   */
  invalidateCache(): void {
    this.cachedResult = null;
    this.cachedDSL = null;
    this.cachedGraphHash = null;
    this.cachedPathT95 = null;
    this.cachedPathT95GraphHash = null;
  }
  
  // ===========================================================================
  // Private helpers
  // ===========================================================================
  
  /**
   * Extract date range from DSL, handling both window() and cohort() clauses.
   */
  private extractWindowFromDSL(dsl: string): DateRange | null {
    try {
      const constraints = parseConstraints(dsl);
      
      // Handle cohort() queries
      if (constraints.cohort && constraints.cohort.start) {
        const start = resolveRelativeDate(constraints.cohort.start);
        const end = constraints.cohort.end 
          ? resolveRelativeDate(constraints.cohort.end)
          : this.getTodayUK();
        return { start, end };
      }
      
      // Handle window() queries
      if (constraints.window && constraints.window.start) {
        const start = resolveRelativeDate(constraints.window.start);
        const end = constraints.window.end 
          ? resolveRelativeDate(constraints.window.end)
          : this.getTodayUK();
        return { start, end };
      }
      
      return null;
    } catch (e) {
      console.warn('[windowFetchPlannerService] Failed to parse DSL:', e);
      return null;
    }
  }
  
  /**
   * Get path_t95 for a specific edge.
   * 
   * If the edge already has path_t95 computed (from a recent fetch), use it.
   * Otherwise, compute path_t95 on-demand for all edges (cached per analysis).
   * 
   * path_t95 is the cumulative latency from the anchor to this edge, used for
   * cohort retrieval horizon decisions. For non-cohort queries, edge-local t95
   * is sufficient.
   */
  private getPathT95ForEdge(edge: any, graph: Graph): number | undefined {
    // If edge already has path_t95, use it (set by fetchDataService after fetch)
    if (edge.p?.latency?.path_t95 !== undefined) {
      return edge.p.latency.path_t95;
    }
    
    // Compute on-demand if not already cached for this graph
    const graphHash = this.computeGraphHash(graph);
    if (this.cachedPathT95 === null || this.cachedPathT95GraphHash !== graphHash) {
      this.cachedPathT95 = this.computePathT95ForGraph(graph);
      this.cachedPathT95GraphHash = graphHash;
    }
    
    // Look up edge in computed map
    const edgeId = edge.uuid || edge.id || `${edge.from}->${edge.to}`;
    return this.cachedPathT95.get(edgeId);
  }
  
  /**
   * Compute path_t95 for all edges in the graph.
   * This is a pure function that does not modify the graph.
   */
  private computePathT95ForGraph(graph: Graph): Map<string, number> {
    if (!graph?.edges?.length) return new Map();
    
    // Build GraphForPath representation
    const graphForPath: GraphForPath = {
      nodes: (graph.nodes || []).map(n => ({
        id: n.id || n.uuid || '',
        type: n.type,
      })),
      edges: (graph.edges || []).map(e => ({
        id: e.id,
        uuid: e.uuid,
        from: e.from,
        to: e.to,
        p: e.p ? {
          latency: e.p.latency ? {
            latency_parameter: e.p.latency.latency_parameter,
            t95: e.p.latency.t95,
            path_t95: e.p.latency.path_t95,
          } : undefined,
          mean: e.p.mean,
        } : undefined,
      })),
    };
    
    // Get active edges (edges with non-zero probability)
    const activeEdges = getActiveEdges(graphForPath);
    if (activeEdges.size === 0) return new Map();
    
    // Compute path_t95
    return computePathT95(graphForPath, activeEdges);
  }
  
  private getTodayUK(): string {
    const now = new Date();
    const day = now.getDate();
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const month = monthNames[now.getMonth()];
    const year = now.getFullYear() % 100;
    return `${day}-${month}-${year}`;
  }
  
  /**
   * Check if an item is file-only (has data but no external connection).
   */
  private isFileOnlyItem(item: FetchItem, graph: Graph): boolean {
    if (item.type === 'parameter') {
      const paramFile = item.objectId ? fileRegistry.getFile(`parameter-${item.objectId}`) : null;
      const edge = graph.edges?.find((e: any) => e.uuid === item.targetId || e.id === item.targetId);
      const param = edge?.[item.paramSlot || 'p'];
      
      const hasFileData = !!paramFile?.data;
      const hasConnection = !!paramFile?.data?.connection || !!param?.connection;
      
      return hasFileData && !hasConnection;
    } else if (item.type === 'case') {
      const caseFile = fileRegistry.getFile(`case-${item.objectId}`);
      const node = graph.nodes?.find((n: any) => n.uuid === item.targetId || n.id === item.targetId);
      
      const hasFileData = !!caseFile?.data;
      const hasConnection = !!caseFile?.data?.connection || !!node?.case?.connection;
      
      return hasFileData && !hasConnection;
    }
    return false;
  }
  
  /**
   * Check if a file-only item has coverage for the requested window.
   */
  private checkFileOnlyCoverage(item: FetchItem, window: DateRange, dsl: string): boolean {
    // For file-only items, we must check coverage for the *requested window*,
    // not just "file has some data".
    //
    // Behaviour:
    // - Parameter: use hasFullSliceCoverageByHeader to see if any slice header
    //   fully covers the requested window for this DSL (window() or cohort()).
    // - Case: if there is any case data at all, treat as "covered" (cases are
    //   schedule-based and not window-sliced in the same way as parameters).
    if (item.type === 'parameter') {
      const paramFile = fileRegistry.getFile(`parameter-${item.objectId}`);
      if (!paramFile?.data) return false;
      return hasFullSliceCoverageByHeader(paramFile.data, window, dsl);
    } else if (item.type === 'case') {
      const caseFile = fileRegistry.getFile(`case-${item.objectId}`);
      return !!caseFile?.data?.case;
    }
    return false;
  }
  
  /**
   * Count missing dates for a parameter item.
   */
  private countMissingDates(item: FetchItem, window: DateRange, dsl: string): number {
    // This is a rough estimate - the actual calculation would require
    // calling calculateIncrementalFetch, but we want to avoid that overhead.
    // For now, estimate based on window size.
    try {
      const start = parseDate(window.start);
      const end = parseDate(window.end);
      const days = Math.ceil((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)) + 1;
      return Math.max(1, days);
    } catch {
      return 1;
    }
  }
  
  /**
   * DIAGNOSTIC: Log detailed per-item coverage analysis to session log.
   * 
   * This helps debug cache miss scenarios by showing exactly why each item
   * was classified as needing a fetch or not.
   */
  private logDetailedCoverageAnalysis(
    logOpId: string,
    items: PlannerItem[],
    window: DateRange,
    dsl: string,
    graph: Graph
  ): void {
    const windowDesc = `${normalizeToUK(window.start)} → ${normalizeToUK(window.end)}`;
    
    for (const item of items) {
      if (item.type !== 'parameter') continue;

      const requestedIsCohort = dsl.includes('cohort(');
      const requestedQueryType = requestedIsCohort ? 'cohort' : 'window';

      // The effective DSL for this item may differ from the UI DSL (e.g. cohort-mode overridden to window-mode
      // for non-latency edges). Use the effective DSL for diagnostics so logs reflect reality.
      const effectiveDSL = item.targetSliceOverride ?? dsl;
      const isCohortQuery = effectiveDSL.includes('cohort(');
      const queryType = isCohortQuery ? 'cohort' : 'window';
      
      const fileId = `parameter-${item.objectId}`;
      const file = fileRegistry.getFile(fileId);
      const edge = graph.edges?.find(e => (e.uuid || e.id) === item.targetId);
      
      // Build diagnostic details
      const details: string[] = [];
      let coverageStatus = 'UNKNOWN';
      
      // Check file existence
      if (!file?.data) {
        details.push('NO_FILE: Parameter file does not exist');
        coverageStatus = 'NO_FILE';
      } else {
        const values = file.data.values ?? [];
        details.push(`FILE_EXISTS: ${values.length} value entries`);
        
        // Check connection
        const param = edge?.p;
        const hasConnection = !!file.data.connection || !!param?.connection;
        if (!hasConnection) {
          details.push('FILE_ONLY: No connection configured (read-only from file)');
        } else {
          details.push(`CONNECTION: ${file.data.connection?.id || param?.connection || 'edge-defined'}`);
        }
        
        // Analyse slice coverage.
        //
        // IMPORTANT: Uncontexted queries are allowed to be satisfied from a MECE partition of contexted slices.
        // isolateSlice is intentionally conservative and can throw in that case; treat that as an advisory
        // condition and fall back to MECE resolution for diagnostics rather than failing the entire planner run.
        let sliceValues: ParameterValue[] = [];
        try {
          sliceValues = isolateSlice(values, effectiveDSL) as any;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg.includes('Slice isolation error') && msg.includes('MECE aggregation')) {
            const modeFilteredValues = values.filter(v => {
              if (isCohortQuery) return isCohortModeValue(v);
              return !isCohortModeValue(v);
            });
            const mece = resolveMECEPartitionForImplicitUncontextedSync(modeFilteredValues as any);
            if (mece.kind === 'mece_partition' && mece.canAggregate) {
              sliceValues = mece.values;
              details.push(
                `IMPLICIT_UNCONTEXTED: using MECE partition (key=${mece.key}, complete=${mece.isComplete})`
              );
            } else {
              details.push('UNCONTEXTED_WITH_CONTEXTED_DATA: no explicit uncontexted slice and MECE partition not resolvable');
            }
          } else {
            // Unexpected isolation failure: surface the message but keep planner analysis running.
            details.push(`SLICE_MATCH_ERROR: ${msg}`);
          }
        }
        details.push(`SLICE_MATCH: ${sliceValues.length}/${values.length} entries match DSL context`);
        
        if (sliceValues.length === 0) {
          coverageStatus = 'NO_SLICE_MATCH';
          details.push('⚠ No cached entries match the query context/slice');
        } else {
          // Check coverage by parsing sliceDSL (the canonical source of truth)
          const coveredSlices: string[] = [];
          const uncoveredSlices: string[] = [];
          const queryMode = isCohortQuery ? 'cohort' : 'window';
          
          for (const slice of sliceValues) {
            const sliceDSL = slice.sliceDSL ?? '';
            
            // Parse date range from sliceDSL
            const windowMatch = sliceDSL.match(/window\(([^:]+):([^)]+)\)/);
            const cohortMatch = sliceDSL.match(/cohort\(([^:]+):([^)]+)\)/);
            const match = isCohortQuery ? cohortMatch : windowMatch;
            
            if (!match) {
              // Check if it's the wrong mode
              if (isCohortQuery && windowMatch) {
                uncoveredSlices.push(`[window slice, need cohort]`);
              } else if (!isCohortQuery && cohortMatch) {
                uncoveredSlices.push(`[cohort slice, need window]`);
              } else {
                uncoveredSlices.push(`[no ${queryMode} range in sliceDSL]`);
              }
              continue;
            }
            
            const sliceFrom = normalizeDate(match[1]);
            const sliceTo = normalizeDate(match[2]);
            const sliceRange = `${sliceFrom} → ${sliceTo}`;
            
            // Check if this slice covers the requested window
            try {
              const sliceStartDate = parseDate(sliceFrom);
              const sliceEndDate = parseDate(sliceTo);
              const queryStartDate = parseDate(window.start);
              const queryEndDate = parseDate(window.end);
              
              const coversStart = sliceStartDate <= queryStartDate;
              const coversEnd = sliceEndDate >= queryEndDate;
              
              if (coversStart && coversEnd) {
                coveredSlices.push(`✓ ${sliceRange} (FULL)`);
              } else if (coversStart || coversEnd) {
                const missing = !coversStart ? 'start' : 'end';
                uncoveredSlices.push(`◐ ${sliceRange} (PARTIAL - missing ${missing})`);
              } else {
                uncoveredSlices.push(`✗ ${sliceRange} (NO coverage)`);
              }
            } catch {
              uncoveredSlices.push(`? ${sliceRange} (parse error)`);
            }
          }
          
          if (coveredSlices.length > 0) {
            coverageStatus = 'COVERED';
            details.push(`SLICES: ${coveredSlices.join('; ')}`);
          } else {
            coverageStatus = 'SLICE_GAP';
            details.push(`SLICES: ${uncoveredSlices.join('; ')}`);
          }
        }
      }
      
      // Final classification reason
      const classificationReason = item.classification === 'needs_fetch'
        ? `NEEDS_FETCH (${coverageStatus})`
        : item.classification === 'covered_stable'
          ? `COVERED_STABLE`
          : item.classification === 'stale_candidate'
            ? `STALE (${item.stalenessReason})`
            : `${item.classification.toUpperCase()}`;
      
      sessionLogService.addChild(
        logOpId,
        item.classification === 'needs_fetch' ? 'warning' : 'info',
        'COVERAGE_DETAIL',
        `${item.objectId}: ${classificationReason}`,
        `Requested DSL: ${requestedQueryType}(${windowDesc})\n` +
          `Effective DSL: ${queryType}(${windowDesc})${item.targetSliceOverride ? ` (override=${item.targetSliceOverride})` : ''}\n` +
          `${details.join('\n')}`,
        {
          itemId: item.objectId,
          classification: item.classification,
          coverageStatus,
          hasFile: !!file?.data,
          sliceCount: file?.data?.values?.length ?? 0,
        }
      );
    }
  }
  
  /**
   * Compute bounded cohort retrieval window for a parameter item.
   * 
   * For cohort queries on latency edges, we use path_t95 (or t95 fallback)
   * to bound how far back we retrieve cohorts. This prevents refetching
   * mature historical cohorts that won't meaningfully change.
   * 
   * @param item - The fetch item (parameter only)
   * @param window - The user's requested cohort window
   * @param graph - The graph (for edge lookup and path_t95)
   * @returns Cohort horizon result, or undefined if not applicable
   */
  private computeBoundedCohortWindow(
    item: FetchItem,
    window: DateRange,
    graph: Graph
  ): CohortHorizonResult | undefined {
    if (item.type !== 'parameter') return undefined;
    
    const edge = graph.edges?.find(e => (e.uuid || e.id) === item.targetId);
    if (!edge) return undefined;
    
    const latencyConfig = edge.p?.latency;
    
    // Get path_t95 (computed on-demand if not present on edge)
    // This is the key classification: edges with path_t95 > 0 are "behind a lagged path"
    // and should use cohort-based retrieval with bounded horizon.
    const pathT95 = this.getPathT95ForEdge(edge, graph);
    
    // COHORT-VIEW: Use path_t95 to classify edges, not just local latencyConfig.
    // If path_t95 > 0, this edge is downstream of latency edges and needs
    // cohort-based treatment. If path_t95 = 0 (or undefined on first run),
    // treat as simple edge with no bounding.
    const hasLocalLatency = latencyConfig?.latency_parameter === true || !!latencyConfig?.t95;
    const isBehindLaggedPath = (pathT95 ?? 0) > 0;
    
    if (!hasLocalLatency && !isBehindLaggedPath) {
      // Truly simple edge: no latency config AND no upstream lag
      // No bounding needed - use window-style retrieval
      return undefined;
    }
    
    // Get existing coverage from file
    const file = fileRegistry.getFile(`parameter-${item.objectId}`);
    const existingDates = file?.data?.values?.[0]?.dates || [];
    const retrievedAt = file?.data?.values?.[0]?.data_source?.retrieved_at;
    
    return computeCohortRetrievalHorizon({
      requestedWindow: window,
      pathT95,
      edgeT95: latencyConfig?.t95,
      existingCoverage: {
        dates: existingDates,
        retrievedAt,
      },
    });
  }
  
  /**
   * Check staleness for a covered item.
   * Pattern from dataOperationsService.ts lines 3646-3657.
   */
  private checkStaleness(
    item: FetchItem,
    window: DateRange,
    dsl: string,
    graph: Graph,
    isCohortQuery: boolean
  ): StalenessResult {
    // Case staleness: simple >1 day rule
    if (item.type === 'case') {
      return this.checkCaseStaleness(item);
    }
    
    // Parameter staleness
    const edge = graph.edges?.find(e => (e.uuid || e.id) === item.targetId);
    const latencyConfig = edge?.p?.latency as LatencyConfig | undefined;
    
    // No latency tracking: not stale by default
    const isLatencyEnabled = latencyConfig?.latency_parameter === true || !!latencyConfig?.t95;
    if (!isLatencyEnabled) {
      return { isStale: false };
    }
    
    // Get file and existing slice (matching pattern from dataOperationsService lines 3646-3657)
    const file = fileRegistry.getFile(`parameter-${item.objectId}`);
    if (!file?.data?.values) {
      return { isStale: false }; // No data to assess
    }
    
    const existingSlice = this.findMatchingSlice(file.data.values, dsl, isCohortQuery);
    if (!existingSlice) {
      return { isStale: false }; // No matching slice
    }
    
    // Use existing refetch policy for cohort immaturity check
    const refetchDecision = shouldRefetch({
      existingSlice,
      latencyConfig,
      requestedWindow: window,
      isCohortQuery,
      referenceDate: new Date(),
    });
    
    // If refetch policy says replace_slice or partial, it's stale
    if (refetchDecision.type === 'replace_slice' && refetchDecision.hasImmatureCohorts) {
      return {
        isStale: true,
        reason: refetchDecision.reason || 'immature_cohorts',
        retrievedAt: existingSlice.data_source?.retrieved_at,
      };
    }
    
    if (refetchDecision.type === 'partial') {
      return {
        isStale: true,
        reason: `Immature dates after ${refetchDecision.matureCutoff}`,
        retrievedAt: existingSlice.data_source?.retrieved_at,
      };
    }
    
    // ═══════════════════════════════════════════════════════════════════════
    // ADDITIONAL STALENESS TEST: retrieval timestamp + t95/path_t95
    // 
    // High-level design §5.2:
    // - If more than 1 day has passed since retrieval AND
    // - Query horizon is still within t95/path_t95 (cohorts may be maturing)
    // → Treat as refresh candidate
    // 
    // - Once query horizon is beyond t95/path_t95
    // → Treat as "reasonably mature" (covered_stable)
    // 
    // Phase 1: path_t95 is now computed on-demand for cohort queries,
    // giving cumulative latency from the anchor rather than just edge-local t95.
    // ═══════════════════════════════════════════════════════════════════════
    if (refetchDecision.type === 'use_cache') {
      const retrievedAt = existingSlice.data_source?.retrieved_at;
      if (!retrievedAt) {
        return { isStale: false };
      }
      
      const retrievedDate = new Date(retrievedAt);
      const daysSinceRetrieval = (Date.now() - retrievedDate.getTime()) / (24 * 60 * 60 * 1000);
      
      // Select effective t95 based on query mode
      // For cohort queries: use path_t95 (cumulative from anchor) if available
      // For window queries: use edge-local t95
      let effectiveT95: number;
      if (isCohortQuery) {
        // Try to get path_t95 (computed on-demand if not present on edge)
        const pathT95 = this.getPathT95ForEdge(edge, graph);
        effectiveT95 = pathT95 ?? latencyConfig?.t95 ?? 0;
      } else {
        effectiveT95 = latencyConfig?.t95 ?? 0;
      }
      
      // Get query end date
      const queryEnd = window.end;
      if (!queryEnd) {
        return { isStale: false, effectiveT95 };
      }
      
      const queryEndDate = parseDate(queryEnd);
      const daysFromQueryEndToNow = (Date.now() - queryEndDate.getTime()) / (24 * 60 * 60 * 1000);
      
      // Staleness test
      if (daysSinceRetrieval > 1 && daysFromQueryEndToNow < effectiveT95) {
        return {
          isStale: true,
          reason: `Data retrieved ${Math.floor(daysSinceRetrieval)}d ago, cohorts may have matured (t95=${effectiveT95.toFixed(1)}d)`,
          retrievedAt,
          effectiveT95,
        };
      }
      
      return { isStale: false, effectiveT95 };
    }
    
    return { isStale: false };
  }
  
  /**
   * Check case staleness: simple >1 day rule.
   */
  private checkCaseStaleness(item: FetchItem): StalenessResult {
    const caseFile = fileRegistry.getFile(`case-${item.objectId}`);
    if (!caseFile?.data) {
      return { isStale: false }; // No data to assess
    }
    
    // Find most recent schedule's retrieved_at
    const schedules = caseFile.data.case?.schedules || [];
    const retrievedAt = this.getMostRecentCaseRetrievedAt(schedules);
    
    if (!retrievedAt) {
      // No retrieval timestamp: cannot assess staleness
      // Treat as stale to be safe (will refresh on next fetch)
      return { 
        isStale: true, 
        reason: 'No retrieval timestamp on case schedules',
      };
    }
    
    const retrievedDate = new Date(retrievedAt);
    const daysSinceRetrieval = (Date.now() - retrievedDate.getTime()) / (24 * 60 * 60 * 1000);
    
    // Simple 1-day threshold
    if (daysSinceRetrieval > 1) {
      return {
        isStale: true,
        reason: `Case retrieved ${Math.floor(daysSinceRetrieval)}d ago`,
        retrievedAt,
      };
    }
    
    return { isStale: false, retrievedAt };
  }
  
  /**
   * Get the most recent retrieved_at from case schedules.
   */
  private getMostRecentCaseRetrievedAt(schedules: any[]): string | undefined {
    if (!schedules || schedules.length === 0) return undefined;
    
    let mostRecent: string | undefined;
    for (const schedule of schedules) {
      const retrievedAt = schedule.retrieved_at;
      if (retrievedAt && (!mostRecent || retrievedAt > mostRecent)) {
        mostRecent = retrievedAt;
      }
    }
    return mostRecent;
  }
  
  /**
   * Find matching slice in parameter values.
   * Pattern from dataOperationsService.ts lines 3646-3657.
   */
  private findMatchingSlice(
    values: ParameterValue[] | undefined,
    dsl: string,
    isCohortQuery: boolean
  ): ParameterValue | undefined {
    if (!values || values.length === 0) return undefined;
    
    const targetDims = extractSliceDimensions(dsl);
    
    return values.find(v => {
      // Must match mode (cohort vs window)
      const isCorrectMode = isCohortQuery 
        ? isCohortModeValue(v) 
        : !isCohortModeValue(v);
      if (!isCorrectMode) return false;
      
      // Must match context/case dimensions
      const valueDims = extractSliceDimensions(v.sliceDSL || '');
      return targetDims === valueDims;
    });
  }
  
  /**
   * Convert FetchItem to base PlannerItem properties.
   */
  private toBaseItem(item: FetchItem): Omit<PlannerItem, 'classification'> {
    return {
      id: item.id,
      type: item.type as 'parameter' | 'case',
      objectId: item.objectId,
      targetId: item.targetId,
      paramSlot: item.paramSlot,
      conditionalIndex: item.conditionalIndex,
      targetSliceOverride: item.targetSliceOverride,
    };
  }
  
  /**
   * Derive overall outcome from item classifications.
   */
  private deriveOutcome(items: PlannerItem[]): FetchOutcome {
    // Only fetchable items (not file_only_gap) contribute to outcome
    const fetchableItems = items.filter(i => i.classification !== 'file_only_gap');
    
    const hasNeedsFetch = fetchableItems.some(i => i.classification === 'needs_fetch');
    const hasStale = fetchableItems.some(i => i.classification === 'stale_candidate');
    
    if (hasNeedsFetch) {
      return 'not_covered';
    }
    
    if (hasStale) {
      return 'covered_stale';
    }
    
    return 'covered_stable';
  }
  
  /**
   * Build human-readable tooltip for fetch button.
   */
  private buildButtonTooltip(items: PlannerItem[], outcome: FetchOutcome): string {
    if (outcome === 'covered_stable') {
      return 'All data is up to date for this query.';
    }
    
    const fetchItems = items.filter(i => i.classification === 'needs_fetch');
    const staleItems = items.filter(i => i.classification === 'stale_candidate');
    
    const parts: string[] = [];
    
    if (fetchItems.length > 0) {
      const totalMissing = fetchItems.reduce((sum, i) => sum + (i.missingDates ?? 0), 0);
      if (totalMissing > 0) {
        parts.push(`Fetch ${totalMissing} missing date${totalMissing > 1 ? 's' : ''} for ${fetchItems.length} item${fetchItems.length > 1 ? 's' : ''}`);
      } else {
        parts.push(`Fetch ${fetchItems.length} item${fetchItems.length > 1 ? 's' : ''} from source`);
      }
    }
    
    if (staleItems.length > 0) {
      // Distinguish between stale parameters (maturing cohorts) and stale cases (>1 day old)
      const staleParams = staleItems.filter(i => i.type === 'parameter');
      const staleCases = staleItems.filter(i => i.type === 'case');
      
      if (staleParams.length > 0) {
        parts.push(`Refresh ${staleParams.length} param${staleParams.length > 1 ? 's' : ''} with maturing cohorts`);
      }
      if (staleCases.length > 0) {
        parts.push(`Refresh ${staleCases.length} case${staleCases.length > 1 ? 's' : ''} (>1 day old)`);
      }
    }
    
    return parts.join('; ');
  }
  
  /**
   * Build toast message based on outcome.
   */
  private buildToastMessage(outcome: FetchOutcome, items: PlannerItem[]): string | undefined {
    const unfetchable = items.filter(i => i.classification === 'file_only_gap');
    
    if (outcome === 'not_covered') {
      const fetchItems = items.filter(i => i.classification === 'needs_fetch');
      return `${fetchItems.length} item${fetchItems.length > 1 ? 's' : ''} need fetching. Click Fetch to retrieve data.`;
    }
    
    if (outcome === 'covered_stable' && unfetchable.length > 0) {
      return `No cached data for ${unfetchable.length} file-only item${unfetchable.length > 1 ? 's' : ''} in this window. Try a different date range.`;
    }
    
    // No toast for covered_stale (user can see the Refresh button)
    return undefined;
  }
  
  /**
   * Build empty result for edge cases (no window in DSL, etc.)
   */
  private buildEmptyResult(dsl: string, trigger: AnalysisTrigger, reason: string): PlannerResult {
    return {
      status: 'complete',
      outcome: 'covered_stable',
      autoAggregationItems: [],
      fetchPlanItems: [],
      staleCandidates: [],
      unfetchableGaps: [],
      summaries: {
        buttonTooltip: reason,
        showToast: false,
      },
      analysisContext: {
        trigger,
        dsl,
        timestamp: new Date().toISOString(),
      },
    };
  }
  
  /**
   * Compute hash of graph structure for cache invalidation.
   */
  private computeGraphHash(graph: Graph): string {
    const edgeIds = (graph.edges || []).map(e => e.uuid || e.id).sort().join(',');
    const nodeIds = (graph.nodes || []).map(n => n.uuid || n.id).sort().join(',');
    return `${edgeIds}|${nodeIds}`;
  }
}

// =============================================================================
// Export singleton instance
// =============================================================================

export const windowFetchPlannerService = WindowFetchPlannerService.getInstance();

