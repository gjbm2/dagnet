/**
 * Fetch Plan Builder Service
 * 
 * Pure function that builds a FetchPlan from inputs.
 * Used by planner analysis, dry-run, and live execution (single codepath).
 * 
 * Design doc: docs/current/fetch-planning-first-principles.md
 * 
 * Key principle: This builder has NO side effects.
 * - No external calls
 * - No file writes  
 * - No graph mutation
 * - Deterministic given same inputs
 */

import {
  type FetchPlan,
  type FetchPlanItem,
  type FetchWindow,
  type FetchWindowReason,
  buildItemKey,
  sortItems,
  sortWindows,
  mergeDatesToWindows,
  createFetchWindow,
  expandWindowToDates,
} from './fetchPlanTypes';
import {
  calculateIncrementalFetch,
  hasFullSliceCoverageByHeader,
  parseDate,
  normalizeDate,
  isCohortModeValue,
} from './windowAggregationService';
import {
  shouldRefetch,
  computeEffectiveCohortMaturity,
  type LatencyConfig,
  type RefetchDecision,
} from './fetchRefetchPolicy';
import { isolateSlice, extractSliceDimensions } from './sliceIsolation';
import { parseConstraints } from '../lib/queryDSL';
import { formatDateUK } from '../lib/dateFormat';
import type { Graph, DateRange } from '../types';
import type { ParameterValue } from '../types/parameterData';
import { enumerateFetchTargets } from './fetchTargetEnumerationService';
import { selectImplicitUncontextedSliceSetSync } from './meceSliceService';
import { isSignatureCheckingEnabled } from './signaturePolicyService';
import { canCacheSatisfyQuery } from './signatureMatchingService';
import { tryDimensionalReduction } from './dimensionalReductionService';

// =============================================================================
// Types
// =============================================================================

/**
 * File state accessor - abstracts file registry access for testability.
 */
export interface FileStateAccessor {
  getParameterFile(objectId: string): { data?: { values?: ParameterValue[] } } | undefined;
  getCaseFile(objectId: string): { data?: any } | undefined;
}

/**
 * Connection checker - abstracts connection registry access.
 */
export interface ConnectionChecker {
  /** Check if an edge has a connection (for parameters) */
  hasEdgeConnection(edge: any): boolean;
  /** Check if a node's case has a connection (for cases) */
  hasCaseConnection(node: any): boolean;
}

/**
 * Input to the plan builder.
 */
export interface FetchPlanBuilderInput {
  /** The graph to plan for */
  graph: Graph;
  
  /** The target DSL (e.g. 'cohort(1-Nov-25:30-Nov-25).context(channel:paid-search)') */
  dsl: string;
  
  /** Requested date range */
  window: DateRange;
  
  /** Reference "now" for staleness calculations (ISO timestamp) */
  referenceNow: string;

  /**
   * Plan creation timestamp (ISO).
   *
   * Determinism requirement: callers/tests should pass this explicitly.
   * If omitted, we default to referenceNow.
   */
  createdAt?: string;
  
  /** File state accessor */
  fileState: FileStateAccessor;
  
  /** Connection checker */
  connectionChecker: ConnectionChecker;
  
  /** Optional: bust cache (treat all as missing) */
  bustCache?: boolean;

  /**
   * Optional: per-item execution-grade query signatures, keyed by FetchPlan `itemKey`.
   * When provided AND the parameter file contains signed values, the planner will only
   * treat cache as valid if `value.query_signature === querySignatures[itemKey]`.
   */
  querySignatures?: Record<string, string>;
}

/**
 * Result from the plan builder.
 */
export interface FetchPlanBuilderResult {
  plan: FetchPlan;
  diagnostics: FetchPlanDiagnostics;
}

/**
 * Diagnostics for debugging/logging.
 */
export interface FetchPlanDiagnostics {
  /** Total items considered */
  totalItems: number;
  /** Items with fetch windows */
  itemsNeedingFetch: number;
  /** Items fully covered */
  itemsCovered: number;
  /** Items unfetchable */
  itemsUnfetchable: number;
  /** Per-item diagnostics */
  itemDiagnostics: ItemDiagnostic[];
}

export interface ItemDiagnostic {
  itemKey: string;
  objectId: string;
  mode: 'window' | 'cohort';
  missingDates: number;
  staleDates: number;
  totalFetchDates: number;
  refetchDecision?: string;
  classification: string;
  notes: string[];
}

// =============================================================================
// Main Builder Function
// =============================================================================

/**
 * Build a FetchPlan from the given inputs.
 * 
 * This is a PURE function - no side effects, deterministic output.
 */
export function buildFetchPlan(input: FetchPlanBuilderInput): FetchPlanBuilderResult {
  const {
    graph,
    dsl,
    window,
    referenceNow,
    createdAt,
    fileState,
    connectionChecker,
    bustCache = false,
    querySignatures,
  } = input;
  
  const referenceDate = new Date(referenceNow);
  const isCohortQuery = dsl.includes('cohort(');
  const targetSlice = extractSliceDimensions(dsl);
  
  // Collect all items from graph
  const rawItems = collectAllItems(graph);
  
  // Build plan items
  const planItems: FetchPlanItem[] = [];
  const itemDiagnostics: ItemDiagnostic[] = [];
  
  for (const raw of rawItems) {
    const result = buildPlanItem(raw, {
      window,
      dsl,
      targetSlice,
      isCohortQuery,
      referenceDate,
      fileState,
      connectionChecker,
      graph,
      bustCache,
      querySignatures,
    });
    
    planItems.push(result.item);
    itemDiagnostics.push(result.diagnostic);
  }
  
  // Sort items by key
  const sortedItems = sortItems(planItems);
  
  const plan: FetchPlan = {
    version: 1,
    createdAt: createdAt ?? referenceNow,
    referenceNow,
    dsl,
    items: sortedItems,
  };
  
  const diagnostics: FetchPlanDiagnostics = {
    totalItems: planItems.length,
    itemsNeedingFetch: planItems.filter(i => i.classification === 'fetch').length,
    itemsCovered: planItems.filter(i => i.classification === 'covered').length,
    itemsUnfetchable: planItems.filter(i => i.classification === 'unfetchable').length,
    itemDiagnostics,
  };
  
  return { plan, diagnostics };
}

// =============================================================================
// Item Collection
// =============================================================================

interface RawItem {
  type: 'parameter' | 'case';
  objectId: string;
  targetId: string;
  slot?: 'p' | 'cost_gbp' | 'labour_cost';
  conditionalIndex?: number;
  edge?: any;
  node?: any; // For cases: the node containing the case
}

/**
 * Collect all fetchable items from a graph.
 */
function collectAllItems(graph: Graph): RawItem[] {
  return enumerateFetchTargets(graph).map((t): RawItem => ({
    type: t.type,
    objectId: t.objectId,
    targetId: t.targetId,
    slot: t.paramSlot,
    conditionalIndex: t.conditionalIndex,
    edge: t.edge,
    node: t.node,
  }));
}

// =============================================================================
// Per-Item Plan Building
// =============================================================================

interface BuildPlanItemContext {
  window: DateRange;
  dsl: string;
  targetSlice: string;
  isCohortQuery: boolean;
  referenceDate: Date;
  fileState: FileStateAccessor;
  connectionChecker: ConnectionChecker;
  graph: Graph;
  bustCache: boolean;
  querySignatures?: Record<string, string>;
}

interface BuildPlanItemResult {
  item: FetchPlanItem;
  diagnostic: ItemDiagnostic;
}

function buildPlanItem(raw: RawItem, ctx: BuildPlanItemContext): BuildPlanItemResult {
  const itemKey = buildItemKey(raw);
  const notes: string[] = [];
  
  // Determine mode
  const mode: 'window' | 'cohort' = ctx.isCohortQuery ? 'cohort' : 'window';
  
  // Check if item has a connection (different check for parameters vs cases)
  const hasConnection = raw.type === 'case'
    ? (raw.node ? ctx.connectionChecker.hasCaseConnection(raw.node) : false)
    : (raw.edge ? ctx.connectionChecker.hasEdgeConnection(raw.edge) : false);
  
  // Get file data
  const file = raw.type === 'parameter'
    ? ctx.fileState.getParameterFile(raw.objectId)
    : ctx.fileState.getCaseFile(raw.objectId);
  
  const hasFileData = !!(file?.data);
  
  // Handle cases specially (simpler coverage check)
  if (raw.type === 'case') {
    return buildCasePlanItem(raw, itemKey, hasConnection, hasFileData, ctx, notes);
  }
  
  // Parameter: compute missing and stale dates
  return buildParameterPlanItem(raw, itemKey, hasConnection, file, ctx, notes);
}

function buildCasePlanItem(
  raw: RawItem,
  itemKey: string,
  hasConnection: boolean,
  hasFileData: boolean,
  ctx: BuildPlanItemContext,
  notes: string[]
): BuildPlanItemResult {
  // Cases: simple coverage check (has file data or not)
  const classification = hasFileData ? 'covered' : (hasConnection ? 'fetch' : 'unfetchable');
  
  const item: FetchPlanItem = {
    itemKey,
    type: 'case',
    objectId: raw.objectId,
    targetId: raw.targetId,
    mode: ctx.isCohortQuery ? 'cohort' : 'window',
    sliceFamily: ctx.targetSlice,
    querySignature: '', // Cases don't have query signatures
    classification,
    unfetchableReason: classification === 'unfetchable' ? 'no_connection_and_no_file' : undefined,
    windows: classification === 'fetch' ? [createFetchWindow(ctx.window.start, ctx.window.end, 'missing')] : [],
  };
  
  const diagnostic: ItemDiagnostic = {
    itemKey,
    objectId: raw.objectId,
    mode: ctx.isCohortQuery ? 'cohort' : 'window',
    missingDates: classification === 'fetch' ? 1 : 0, // Treat case as single "unit"
    staleDates: 0,
    totalFetchDates: classification === 'fetch' ? 1 : 0,
    classification,
    notes,
  };
  
  return { item, diagnostic };
}

function buildParameterPlanItem(
  raw: RawItem,
  itemKey: string,
  hasConnection: boolean,
  file: { data?: { values?: ParameterValue[] } } | undefined,
  ctx: BuildPlanItemContext,
  notes: string[]
): BuildPlanItemResult {
  const { window, dsl, isCohortQuery, referenceDate, bustCache } = ctx;
  
  // Get latency config from edge
  const latencyConfig = raw.edge?.p?.latency as LatencyConfig | undefined;
  
  // Get all values from file
  const allValues = file?.data?.values ?? [];
  
  // Filter to mode-appropriate values
  const modeFilteredValues = allValues.filter(v => {
    if (isCohortQuery) return isCohortModeValue(v);
    return !isCohortModeValue(v);
  });
  
  // Determine slice-set for staleness evaluation.
  // For implicit uncontexted queries, reuse the same MECE selection primitive as coverage logic.
  // For explicit contexted slices, isolate directly.
  const targetDims = extractSliceDimensions(dsl);
  const hasAnyContextedData = modeFilteredValues.some(v => extractSliceDimensions(v.sliceDSL ?? '') !== '');
  const hasAnyUncontextedData = modeFilteredValues.some(v => extractSliceDimensions(v.sliceDSL ?? '') === '');
  const isImplicitUncontextedMECE = targetDims === '' && hasAnyContextedData && !hasAnyUncontextedData;

  let existingSlice: ParameterValue | undefined;
  if (targetDims === '' && hasAnyContextedData && !hasAnyUncontextedData) {
    const sel = selectImplicitUncontextedSliceSetSync({ candidateValues: modeFilteredValues, requireCompleteMECE: true });
    if (sel.kind === 'explicit_uncontexted') {
      existingSlice = sel.values[0];
    } else if (sel.kind === 'mece_partition') {
      // Dataset freshness for MECE = stalest member (conservative for staleness/cooldown).
      existingSlice = sel.values.reduce((best, cur) => {
        const bestAt = best?.data_source?.retrieved_at || '';
        const curAt = cur?.data_source?.retrieved_at || '';
        return curAt < bestAt ? cur : best;
      }, sel.values[0]);
      if (sel.diagnostics.warnings?.length) {
        notes.push(...sel.diagnostics.warnings);
      }
    } else {
      notes.push(`Implicit uncontexted not resolvable: ${sel.reason}`);
      if (sel.diagnostics?.warnings?.length) notes.push(...sel.diagnostics.warnings);
    }
  } else {
    // Contexted/explicit slice: isolate. This can throw; treat as no coverage if it does.
    let sliceValues: ParameterValue[] = [];
    try {
      sliceValues = isolateSlice(modeFilteredValues, dsl);
      
      // NEW: If isolateSlice returns empty but we have values, try dimensional reduction
      // (e.g., query asks for channel:google but cache has channel+device)
      if (sliceValues.length === 0 && modeFilteredValues.length > 0 && targetDims !== '') {
        const dimReductionResult = tryDimensionalReduction(modeFilteredValues, dsl);
        
        if (dimReductionResult.kind === 'reduced' && dimReductionResult.aggregatedValues) {
          sliceValues = dimReductionResult.aggregatedValues;
          notes.push(`Dimensional reduction: aggregated ${dimReductionResult.diagnostics.slicesUsed} slices across [${dimReductionResult.diagnostics.unspecifiedDimensions.join(', ')}]`);
        }
      }
    } catch (e) {
      notes.push(`Slice isolation failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    existingSlice =
      sliceValues.length > 0
        ? sliceValues.reduce((best, cur) => {
            const bestKey = best?.data_source?.retrieved_at || best?.cohort_to || best?.window_to || '';
            const curKey = cur?.data_source?.retrieved_at || cur?.cohort_to || cur?.window_to || '';
            return curKey > bestKey ? cur : best;
          })
        : undefined;
  }
  
  // Compute refetch decision
  const refetchDecision = shouldRefetch({
    existingSlice,
    latencyConfig,
    requestedWindow: window,
    isCohortQuery,
    referenceDate,
  });
  
  // Compute missing dates using calculateIncrementalFetch
  const hasAnySignedValuesInFile = modeFilteredValues.some(v => !!(v as any).query_signature);
  const currentSignature = ctx.querySignatures?.[itemKey];

  // If the file is signed AND we have an execution-grade signature for this item,
  // only treat matching-signature values as cache for both header coverage and gap detection.
  //
  // Signature isolation applies whenever we have an execution-grade signature and signed cache exists.
  //
  // With correct signature semantics (context VALUE excluded; context DEFINITION included),
  // implicit-uncontexted MECE fulfilment remains compatible with signature isolation.
  const shouldFilterBySignature =
    isSignatureCheckingEnabled() &&
    hasAnySignedValuesInFile &&
    typeof currentSignature === 'string' &&
    currentSignature.length > 0;
  const signatureForCoverage =
    shouldFilterBySignature && typeof currentSignature === 'string' ? currentSignature : undefined;
  const valuesForCoverage = shouldFilterBySignature
    ? modeFilteredValues.filter((v) => {
        const cacheSig = (v as any).query_signature;
        if (!cacheSig || !currentSignature) return false;
        // Use subset-aware matching: cache signature can satisfy query if cache has superset of context keys
        return canCacheSatisfyQuery(cacheSig, currentSignature);
      })
    : modeFilteredValues;
  // IMPORTANT: Coverage in the planner must match the UI/Fetch-button coverage semantics.
  // Those semantics are **header-based** (window_from/to or cohort_from/to), and explicitly ignore
  // per-day sparsity / n_daily/k_daily gaps.
  //
  // This avoids a class of real regressions where:
  // - COVERAGE_DETAIL says "FULL" (header contains requested window)
  // - but calculateIncrementalFetch reports "missing days" (because daily arrays are absent/sparse)
  // - and the planner wrongly demands a fetch.
  const hasFullHeaderCoverage =
    !bustCache && hasFullSliceCoverageByHeader({ values: valuesForCoverage }, window, dsl);

  const incrementalResult = hasFullHeaderCoverage
    ? {
        existingDates: new Set<string>(),
        missingDates: [],
        fetchWindows: [],
        fetchWindow: null,
        needsFetch: false,
        totalDays: 0,
        daysAvailable: 0,
        daysToFetch: 0,
      }
    : calculateIncrementalFetch(
        { values: valuesForCoverage },
        window,
        signatureForCoverage,
        bustCache,
        dsl
      );
  
  const missingDates = new Set<string>();
  if (incrementalResult.needsFetch && incrementalResult.fetchWindows) {
    for (const fw of incrementalResult.fetchWindows) {
      for (const d of generateDatesInRange(fw.start, fw.end)) {
        missingDates.add(d);
      }
    }
  }
  
  // Compute stale dates based on refetch decision
  const staleDates = new Set<string>();
  computeStaleDates(
    refetchDecision,
    window,
    latencyConfig,
    referenceDate,
    missingDates,
    staleDates,
    notes
  );
  
  // Merge missing + stale into fetch set F
  const fetchDates = new Set<string>([...missingDates, ...staleDates]);
  
  // Determine classification
  let classification: 'fetch' | 'covered' | 'unfetchable';
  let unfetchableReason: string | undefined;
  
  if (fetchDates.size === 0) {
    classification = 'covered';
  } else if (!hasConnection && allValues.length === 0) {
    classification = 'unfetchable';
    unfetchableReason = 'no_connection_and_no_file';
  } else if (!hasConnection) {
    // Has file data but no connection - can't fetch missing
    classification = 'unfetchable';
    unfetchableReason = 'no_connection';
  } else {
    classification = 'fetch';
  }
  
  // Build minimal windows from fetch dates
  const missingWindows = mergeDatesToWindows(Array.from(missingDates), 'missing');
  const staleOnlyDates = Array.from(staleDates).filter(d => !missingDates.has(d));
  const staleWindows = mergeDatesToWindows(staleOnlyDates, 'stale');
  const allWindows = sortWindows([...missingWindows, ...staleWindows]);
  
  const item: FetchPlanItem = {
    itemKey,
    type: 'parameter',
    objectId: raw.objectId,
    targetId: raw.targetId,
    slot: raw.slot,
    conditionalIndex: raw.conditionalIndex,
    mode: isCohortQuery ? 'cohort' : 'window',
    sliceFamily: extractSliceDimensions(dsl),
    querySignature: shouldFilterBySignature && typeof currentSignature === 'string' ? currentSignature : '',
    classification,
    unfetchableReason,
    windows: classification === 'fetch' ? allWindows : [],
  };
  
  const diagnostic: ItemDiagnostic = {
    itemKey,
    objectId: raw.objectId,
    mode: isCohortQuery ? 'cohort' : 'window',
    missingDates: missingDates.size,
    staleDates: staleDates.size,
    totalFetchDates: fetchDates.size,
    refetchDecision: refetchDecision.type,
    classification,
    notes,
  };
  
  return { item, diagnostic };
}

// =============================================================================
// Stale Date Computation
// =============================================================================

/**
 * Compute stale dates based on refetch decision.
 * 
 * Converts the refetch policy output (decision type + optional window)
 * to a per-date stale set, as required by first-principles design.
 */
function computeStaleDates(
  decision: RefetchDecision,
  requestedWindow: DateRange,
  latencyConfig: LatencyConfig | undefined,
  referenceDate: Date,
  missingDates: Set<string>,
  staleDates: Set<string>,
  notes: string[]
): void {
  switch (decision.type) {
    case 'use_cache':
      // No stale dates
      break;
      
    case 'gaps_only':
      // No stale dates (only missing gaps)
      // But if cooldown was applied, note it
      if (decision.cooldownApplied) {
        notes.push(`Cooldown applied: recent fetch ${decision.lastRetrievedAgeMinutes?.toFixed(0)}min ago`);
      }
      break;
      
    case 'partial':
      // Window mode with latency: stale dates are the immature portion
      if (decision.refetchWindow) {
        for (const d of generateDatesInRange(decision.refetchWindow.start, decision.refetchWindow.end)) {
          if (!missingDates.has(d)) {
            staleDates.add(d);
          }
        }
        notes.push(`Partial refetch: immature dates after ${decision.matureCutoff}`);
      }
      break;
      
    case 'replace_slice':
      // Cohort mode: stale dates are dates within maturity horizon
      // Per design: S = { d : d in requestedRange and (now - d) < effective_t95 }
      const effectiveT95 = computeEffectiveCohortMaturity(latencyConfig);
      const maturityCutoffMs = referenceDate.getTime() - (effectiveT95 * 24 * 60 * 60 * 1000);
      
      for (const d of generateDatesInRange(requestedWindow.start, requestedWindow.end)) {
        const dateMs = parseDate(d).getTime();
        if (dateMs >= maturityCutoffMs && !missingDates.has(d)) {
          staleDates.add(d);
        }
      }
      notes.push(`Replace slice: ${decision.reason}, maturity=${effectiveT95}d`);
      break;
  }
}

// =============================================================================
// Date Utilities
// =============================================================================

/**
 * Generate all dates in a range (inclusive).
 */
function generateDatesInRange(start: string, end: string): string[] {
  const dates: string[] = [];
  const startDate = parseDate(start);
  const endDate = parseDate(end);
  
  const current = new Date(startDate);
  while (current <= endDate) {
    dates.push(normalizeDate(current.toISOString()));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  
  return dates;
}

// =============================================================================
// Factory for Production Use
// =============================================================================

import { fileRegistry } from '../contexts/TabContext';

/**
 * Create a FileStateAccessor that uses the production fileRegistry.
 */
export function createProductionFileStateAccessor(): FileStateAccessor {
  return {
    getParameterFile(objectId: string) {
      return fileRegistry.getFile(`parameter-${objectId}`);
    },
    getCaseFile(objectId: string) {
      return fileRegistry.getFile(`case-${objectId}`);
    },
  };
}

/**
 * Create a ConnectionChecker that uses edge.connection for parameters and node.case.connection for cases.
 */
export function createProductionConnectionChecker(): ConnectionChecker {
  return {
    hasEdgeConnection(edge: any): boolean {
      // Connections are attached to parameter objects (slot-level), not to the edge itself.
      // This must mirror how execution resolves providers in DataOperationsService.
      if (!edge || typeof edge !== 'object') return false;

      // Standard slots
      if (edge.p?.connection) return true;
      if (edge.cost_gbp?.connection) return true;
      if (edge.labour_cost?.connection) return true;

      // Conditional probabilities: edge.conditional_p[i].p.connection
      if (Array.isArray(edge.conditional_p)) {
        for (const cond of edge.conditional_p) {
          if (cond?.p?.connection) return true;
        }
      }

      return false;
    },
    hasCaseConnection(node: any): boolean {
      // Cases have their connection at node.case.connection
      return !!node?.case?.connection;
    },
  };
}

/**
 * Build a FetchPlan using production dependencies.
 */
export function buildFetchPlanProduction(
  graph: Graph,
  dsl: string,
  window: DateRange,
  options?: { bustCache?: boolean; referenceNow?: string; querySignatures?: Record<string, string> }
): FetchPlanBuilderResult {
  return buildFetchPlan({
    graph,
    dsl,
    window,
    referenceNow: options?.referenceNow ?? new Date().toISOString(),
    fileState: createProductionFileStateAccessor(),
    connectionChecker: createProductionConnectionChecker(),
    bustCache: options?.bustCache,
    querySignatures: options?.querySignatures,
  });
}

