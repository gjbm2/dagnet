/**
 * amplitudeFunnelBuilderService
 *
 * Constructs Amplitude front-end chart definitions from DagNet graph
 * node selections and the active queryDSL.
 *
 * This is a SEPARATE code path from the DAS adapter (connections.yaml
 * pre_request script). The DAS adapter builds per-edge REST API queries;
 * this service builds multi-step funnel chart definitions for the
 * front-end draft creation API.
 *
 * CONFORMANCE REQUIREMENT: for each constraint type (context, case,
 * exclude, visited, cohort exclusion), the output must match what the
 * DAS adapter would produce. Conformance tests verify this.
 *
 * Design reference: docs/current/amplitude-funnel-popup-design.md
 */

import { parseDSL, type ParsedFullQuery } from '../lib/queryDSL';
import { resolveVariantToBool } from '../lib/das/caseVariantHelpers';
import {
  buildContextFilters,
  resolveWindowDates,
  resolveCohortDates,
  type ContextFilterObject,
} from '../lib/das/buildDslFromEdge';
import { COHORT_CONVERSION_WINDOW_MAX_DAYS, DEFAULT_T95_DAYS } from '../constants/latency';
import { fileRegistry } from '../contexts/TabContext';
import type { AmplitudeChartDefinition } from './amplitudeBridgeService';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Amplitude built-in user properties that do NOT need the gp: prefix. */
const BUILT_IN_USER_PROPS = new Set([
  'version', 'country', 'city', 'region', 'DMA', 'language',
  'platform', 'os', 'device', 'device_type', 'device_family',
  'start_version', 'paying', 'userdata_cohort',
]);

/** DAS adapter operator mapping (must match connections.yaml). */
const OPERATOR_MAP: Record<string, string> = {
  'is': 'is',
  'is not': 'is not',
  'is any of': 'is',
  'is not any of': 'is not',
  'contains': 'contains',
  'does not contain': 'does not contain',
};

function mapOperator(op: string): string {
  return OPERATOR_MAP[op] || 'is';
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FunnelBuildResult {
  definition: AmplitudeChartDefinition;
  /** Nodes that were included as funnel steps (in order). */
  stepsIncluded: string[];
  /** Warnings (e.g. nodes without event_id, unresolved events). */
  warnings: string[];
}

interface FunnelBuildOptions {
  /** Selected node IDs (will be topologically sorted). */
  selectedNodeIds: string[];
  /** All graph nodes. */
  graphNodes: any[];
  /** All graph edges. */
  graphEdges: any[];
  /** The effective composited queryDSL (from scenario/window selector). */
  effectiveDsl: string | null;
  /** Amplitude app/project ID. */
  appId: string;
  /** Connection defaults (for excluded_cohorts). */
  connectionDefaults?: { excluded_cohorts?: string[] };
  /** Whether to exclude test accounts (default true). */
  excludeTestAccounts?: boolean;
}

// ---------------------------------------------------------------------------
// Main builder
// ---------------------------------------------------------------------------

/**
 * Build an Amplitude chart definition from a node selection + queryDSL.
 *
 * Steps:
 * 1. Topologically sort selected nodes
 * 2. Resolve each node → event_id → Amplitude event name + filters
 * 3. Parse the effective DSL for constraints
 * 4. Build segment conditions (exclude, visited, context, case, cohort exclusions)
 * 5. Set date range (window or cohort mode)
 * 6. Assemble the chart definition
 */
export async function buildAmplitudeFunnelDefinition(options: FunnelBuildOptions): Promise<FunnelBuildResult> {
  const {
    selectedNodeIds,
    graphNodes,
    graphEdges,
    effectiveDsl,
    appId,
    connectionDefaults,
    excludeTestAccounts = true,
  } = options;

  const warnings: string[] = [];

  // --- Step 1: Topologically sort selected nodes ---
  const { sorted: sortedNodeIds, isNonLinear } = topologicalSort(selectedNodeIds, graphNodes, graphEdges);
  if (isNonLinear) {
    warnings.push('Selection is non-linear; exporting using deterministic topological order.');
  }

  // --- Step 2: Resolve events ---
  const events: Array<{ event_type: string; filters: any[]; group_by: any[] }> = [];
  const stepsIncluded: string[] = [];
  const funnelStepIds = new Set<string>();

  for (const nodeId of sortedNodeIds) {
    const node = graphNodes.find((n: any) => n.id === nodeId);
    if (!node) { warnings.push(`Node "${nodeId}" not found in graph.`); continue; }

    const eventId = (node as any).event_id;
    if (!eventId) { warnings.push(`Node "${nodeId}" has no event_id.`); continue; }

    const { amplitudeName, filters } = resolveEvent(eventId);
    events.push({ event_type: amplitudeName, filters, group_by: [] });
    stepsIncluded.push(nodeId);
    funnelStepIds.add(nodeId);
  }

  // --- Step 3: Parse DSL ---
  const parsed = parseDSL(effectiveDsl);

  // asat() is historical snapshot mode (point-in-time retrieval date).
  // Amplitude has no equivalent — it operates over event-time ranges only.
  // Strip the clause and warn; do not block.
  if (parsed.asatClausePresent) {
    warnings.push(
      `asat() removed — Amplitude can't represent historical snapshot mode. The funnel uses live Amplitude data, not a DagNet snapshot.`
    );
    parsed.asat = null;
  }
  if ((parsed.visitedAny || []).length > 0) {
    warnings.push('visitedAny() cannot be represented in Amplitude funnels and was ignored.');
  }

  // --- Step 4: Build segment conditions ---
  const conditions: any[] = [];

  // 4a. Cohort exclusions (from connection defaults)
  if (excludeTestAccounts && connectionDefaults?.excluded_cohorts) {
    for (const cohortId of connectionDefaults.excluded_cohorts) {
      conditions.push({
        type: 'property',
        prop_type: 'user',
        prop: 'userdata_cohort',
        op: 'is not',
        values: [cohortId],
        group_type: 'User',
      });
    }
  }

  // 4b. exclude() / minus() → behavioural "performed X = 0 times"
  for (const excludeNodeId of parsed.exclude) {
    if (funnelStepIds.has(excludeNodeId)) {
      warnings.push(`Contradictory constraints: exclude("${excludeNodeId}") is also a funnel step.`);
    }
    const eventId = resolveNodeEventId(excludeNodeId, graphNodes);
    if (!eventId) { warnings.push(`exclude("${excludeNodeId}"): node has no event_id.`); continue; }
    const { amplitudeName, filters } = resolveEvent(eventId);
    conditions.push({
      type: 'event',
      event_type: amplitudeName,
      filters: filters,
      op: '=',
      value: 0,
      time_type: 'rolling',
      time_value: 366,
      group_type: 'User',
    });
  }

  // 4c. visited() → only nodes NOT already in the funnel steps
  for (const visitedNodeId of parsed.visited) {
    if (funnelStepIds.has(visitedNodeId)) continue; // Implicit in funnel ordering
    const eventId = resolveNodeEventId(visitedNodeId, graphNodes);
    if (!eventId) { warnings.push(`visited("${visitedNodeId}"): node has no event_id.`); continue; }
    const { amplitudeName, filters } = resolveEvent(eventId);
    conditions.push({
      type: 'event',
      event_type: amplitudeName,
      filters: filters,
      op: '>=',
      value: 1,
      time_type: 'rolling',
      time_value: 366,
      group_type: 'User',
    });
  }

  // 4d/4e. context()/contextAny() → resolve through shared DAS context registry path
  const contextFilters = await buildContextFilters(parsed, 'amplitude');
  if (contextFilters) {
    for (const filterObj of contextFilters) {
      const prop = normalizeProp(filterObj.field);
      const values = filterObj.pattern
        ? extractLiteralAlternativesFromPattern(filterObj.pattern)
        : [...(filterObj.values || [])];
      if (values.length === 0) continue;
      conditions.push({
        type: 'property',
        prop_type: 'user',
        prop,
        op: filterObj.op,
        values,
        group_type: 'User',
      });
    }
  }

  // 4f. case() → activeGates property conditions
  for (const caseFilter of parsed.cases) {
    const gateId = caseFilter.key.replace(/-/g, '_');
    const gateValue = resolveVariantToBool(caseFilter.value);
    conditions.push({
      type: 'property',
      prop_type: 'user',
      prop: `activeGates.${gateId}`,
      op: 'is',
      values: [gateValue ? 'true' : 'false'],
      group_type: 'User',
    });
  }

  // --- Step 5: Date range ---
  // Amplitude front-end chart definitions use:
  //   start: epoch seconds (start of day, 00:00:00 UTC)
  //   end:   epoch seconds (END of day, 23:59:59 UTC)
  //   datePresetId: -1 (custom range)
  //   timezone: 'UTC'
  // When no absolute dates: range: 'Last 30 Days' (relative preset)
  let dateParams: Record<string, any> = {};

  if (parsed.cohort && (parsed.cohort.start || parsed.cohort.end)) {
    // Cohort mode
    const { startDate: cohortStartDate, endDate: cohortEndDate } = resolveCohortDates(parsed.cohort);
    if (cohortStartDate) dateParams.start = toStartOfDayEpoch(cohortStartDate);
    if (cohortEndDate) dateParams.end = toEndOfDayEpoch(cohortEndDate);
    if (cohortStartDate || cohortEndDate) {
      dateParams.datePresetId = -1;
      dateParams.timezone = 'UTC';
    }

    // Prepend anchor node as step 0 if not already the first step
    if (parsed.cohort.anchor) {
      const anchorNodeId = parsed.cohort.anchor;
      if (!funnelStepIds.has(anchorNodeId)) {
        const anchorEventId = resolveNodeEventId(anchorNodeId, graphNodes);
        if (anchorEventId) {
          const { amplitudeName, filters } = resolveEvent(anchorEventId);
          events.unshift({ event_type: amplitudeName, filters, group_by: [] });
          stepsIncluded.unshift(anchorNodeId);
          warnings.push(`Added cohort anchor "${anchorNodeId}" as first funnel step.`);
        } else {
          warnings.push(`cohort anchor "${anchorNodeId}": node has no event_id.`);
        }
      }
    }

    // Conversion window: derive from graph latency (same policy as buildDslFromEdge).
    // Policy: cs_days = ceil(max(path_t95 | t95 across graph edges)), capped at 90d.
    // Fallback: DEFAULT_T95_DAYS (30d).
    dateParams.conversionSeconds = computeCohortConversionSeconds(graphEdges);
  } else if (parsed.window && (parsed.window.start || parsed.window.end)) {
    // Window mode
    const { startDate: winStartDate, endDate: winEndDate } = resolveWindowDates(parsed.window);
    if (winStartDate) dateParams.start = toStartOfDayEpoch(winStartDate);
    if (winEndDate) dateParams.end = toEndOfDayEpoch(winEndDate);
    if (winStartDate || winEndDate) {
      dateParams.datePresetId = -1;
      dateParams.timezone = 'UTC';
    }
  } else {
    // No dates — use relative range
    dateParams.range = 'Last 30 Days';
  }

  // --- Step 6: Assemble ---
  const definition: AmplitudeChartDefinition = {
    app: appId,
    type: 'funnels',
    vis: 'bar',
    version: 41,
    name: null,
    params: {
      mode: 'ordered',
      ...dateParams,
      interval: 1,
      metric: 'CONVERSION',
      conversionSeconds: dateParams.conversionSeconds || (30 * 86400),  // Default 30d (matches DAS adapter)
      newOrActive: 'active',
      nthTimeLookbackWindow: 365,
      isFunnelPreciseComputationEnabled: false,
      countGroup: { name: 'User', is_computed: false },
      events,
      segments: [{
        name: conditions.length > 0 ? 'DagNet Constraints' : 'All Users',
        label: '',
        conditions,
      }],
      groupBy: [],
      constantProps: [],
      excludedEvents: [],
    },
  };

  return { definition, stepsIncluded, warnings };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute cohort conversion window in seconds from graph edge latency data.
 * Mirrors the logic in buildDslFromEdge.ts (lines 456-530):
 *   cs_days = ceil(max(path_t95 | t95 across all edges)), capped at 90d.
 * Falls back to DEFAULT_T95_DAYS (30d) if no latency data on any edge.
 */
export function computeCohortConversionSeconds(graphEdges: any[]): number {
  let graphMaxT95: number | undefined;
  for (const e of (graphEdges || [])) {
    const lat = e?.p?.latency;
    const v = lat?.path_t95 ?? lat?.t95;
    if (v !== undefined && v !== null && Number(v) > 0) {
      graphMaxT95 = graphMaxT95 === undefined ? Number(v) : Math.max(graphMaxT95, Number(v));
    }
  }
  const effectiveDays = graphMaxT95 ?? DEFAULT_T95_DAYS;
  const conversionWindowDays = Math.min(Math.ceil(effectiveDays), COHORT_CONVERSION_WINDOW_MAX_DAYS);
  return conversionWindowDays * 86400;
}

/** Convert a Date to start-of-day epoch seconds (00:00:00 UTC). */
function toStartOfDayEpoch(d: Date): number {
  const utc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0);
  return Math.floor(utc / 1000);
}

/** Convert a Date to end-of-day epoch seconds (23:59:59 UTC). */
function toEndOfDayEpoch(d: Date): number {
  const utc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59);
  return Math.floor(utc / 1000);
}

/** Resolve a node's event_id from the graph. */
function resolveNodeEventId(nodeId: string, graphNodes: any[]): string | null {
  const node = graphNodes.find((n: any) => n.id === nodeId);
  return (node as any)?.event_id || null;
}

/**
 * Resolve an event_id to Amplitude event name + filters.
 * Uses FileRegistry to look up event definition files.
 * Must match the DAS adapter's getEventInfo + buildEventStepFromId logic.
 */
export function resolveEvent(eventId: string): { amplitudeName: string; filters: any[] } {
  const eventFile = fileRegistry.getFile(`event-${eventId}`);
  const amplitudeName = eventFile?.data?.provider_event_names?.amplitude || eventId;
  const rawFilters: any[] = eventFile?.data?.amplitude_filters || [];

  const filters = rawFilters.map((f: any) => ({
    subprop_type: 'event',
    subprop_key: f.property,
    subprop_op: mapOperator(f.operator),
    subprop_value: f.values,
    group_type: 'User',
    subfilters: [],
  }));

  return { amplitudeName, filters };
}

/**
 * Normalise a property name to Amplitude format.
 * Built-in user props are bare; custom props get gp: prefix.
 * Must match the DAS adapter's normalizeProp logic.
 */
export function normalizeProp(prop: string): string {
  if (!prop) return prop;
  if (BUILT_IN_USER_PROPS.has(prop)) return prop;
  if (prop.startsWith('gp:')) return prop;
  return `gp:${prop}`;
}

/**
 * Topologically sort a subset of node IDs using the graph's edges.
 * Falls back to original order if graph structure doesn't determine order.
 */
function topologicalSort(
  nodeIds: string[],
  graphNodes: any[],
  graphEdges: any[]
): { sorted: string[]; isNonLinear: boolean } {
  if (nodeIds.length <= 1) return { sorted: [...nodeIds], isNonLinear: false };

  // Build UUID → human-readable ID map
  const uuidToId = new Map<string, string>();
  for (const node of graphNodes) {
    if (node.uuid && node.id) uuidToId.set(node.uuid, node.id);
    if (node.id) uuidToId.set(node.id, node.id);
  }

  // Normalise edges to human-readable IDs
  const edges = graphEdges.map((e: any) => ({
    source: uuidToId.get(e.source || e.from) || e.source || e.from,
    target: uuidToId.get(e.target || e.to) || e.target || e.to,
  }));

  const nodeSet = new Set(nodeIds);
  const relevant = edges.filter((e: any) => nodeSet.has(e.source) && nodeSet.has(e.target));
  // If selected nodes are not connected as a single linear path, we still proceed
  // but report a warning to users for interpretability.
  const undirectedAdj = new Map<string, Set<string>>();
  for (const id of nodeIds) undirectedAdj.set(id, new Set<string>());
  for (const e of relevant) {
    undirectedAdj.get(e.source)?.add(e.target);
    undirectedAdj.get(e.target)?.add(e.source);
  }
  const visitedUndirected = new Set<string>();
  let components = 0;
  for (const id of nodeIds) {
    if (visitedUndirected.has(id)) continue;
    components += 1;
    const queue = [id];
    visitedUndirected.add(id);
    while (queue.length) {
      const cur = queue.shift()!;
      for (const n of undirectedAdj.get(cur) || []) {
        if (visitedUndirected.has(n)) continue;
        visitedUndirected.add(n);
        queue.push(n);
      }
    }
  }

  const adjList = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  for (const id of nodeIds) { adjList.set(id, []); inDegree.set(id, 0); }
  for (const e of relevant) {
    adjList.get(e.source)?.push(e.target);
    inDegree.set(e.target, (inDegree.get(e.target) || 0) + 1);
  }

  const queue: string[] = [];
  for (const id of nodeIds) { if (inDegree.get(id) === 0) queue.push(id); }
  queue.sort(); // deterministic tie-break for non-linear selections

  const sorted: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    sorted.push(current);
    for (const neighbour of (adjList.get(current) || [])) {
      const newDeg = (inDegree.get(neighbour) || 0) - 1;
      inDegree.set(neighbour, newDeg);
      if (newDeg === 0) {
        queue.push(neighbour);
        queue.sort();
      }
    }
  }

  // Add any remaining (cycles or disconnected)
  for (const id of nodeIds) { if (!sorted.includes(id)) sorted.push(id); }

  const outDegree = new Map<string, number>();
  for (const id of nodeIds) outDegree.set(id, 0);
  for (const e of relevant) outDegree.set(e.source, (outDegree.get(e.source) || 0) + 1);
  const hasBranch = nodeIds.some((id) => (inDegree.get(id) || 0) > 1 || (outDegree.get(id) || 0) > 1);
  const isNonLinear = components > 1 || hasBranch;

  return { sorted, isNonLinear };
}

function extractLiteralAlternativesFromPattern(pattern: string): string[] {
  let s = String(pattern || '');
  s = s.replace(/^\^/, '').replace(/\$$/, '');
  if (s.startsWith('(') && s.endsWith(')')) s = s.slice(1, -1);
  const parts = s.split('|').map((p) => p.trim()).filter(Boolean);
  const literalish = parts.filter((p) => !/[\\[\]().*+?^${}]/.test(p));
  return Array.from(new Set(literalish));
}

// ---------------------------------------------------------------------------
// Chart definition → REST API query params converter
// ---------------------------------------------------------------------------

/**
 * Convert an AmplitudeChartDefinition to the equivalent REST API query
 * parameters for GET /api/2/funnels.
 *
 * The chart definition (front-end API format) uses JSON objects with epoch
 * seconds for dates. The REST API uses URL query params with YYYYMMDD dates.
 *
 * This is used by roundtrip conformance tests to verify the funnel builder
 * produces semantically equivalent queries to the DAS adapter.
 */
export function chartDefinitionToRestParams(def: AmplitudeChartDefinition): string {
  const p = def.params as any;
  const parts: string[] = [];

  // Events → repeated e= params
  for (const evt of (p.events || [])) {
    const eventObj: any = { event_type: evt.event_type };
    if (evt.filters && evt.filters.length > 0) eventObj.filters = evt.filters;
    if (evt.group_by && evt.group_by.length > 0) eventObj.group_by = evt.group_by;
    parts.push('e=' + encodeURIComponent(JSON.stringify(eventObj)));
  }

  // Dates → YYYYMMDD
  if (p.start && typeof p.start === 'number') {
    parts.push('start=' + epochSecondsToYYYYMMDD(p.start));
  }
  if (p.end && typeof p.end === 'number') {
    parts.push('end=' + epochSecondsToYYYYMMDD(p.end));
  }

  // Conversion seconds
  if (p.conversionSeconds) {
    parts.push('cs=' + String(p.conversionSeconds));
  }

  // Mode
  if (p.mode) {
    parts.push('mode=' + encodeURIComponent(p.mode));
  }

  // New or active
  if (p.newOrActive) {
    parts.push('n=' + encodeURIComponent(p.newOrActive));
  }

  // Segments → s= param (conditions from first segment)
  const conditions = p.segments?.[0]?.conditions;
  if (conditions && conditions.length > 0) {
    parts.push('s=' + encodeURIComponent(JSON.stringify(conditions)));
  }

  return parts.join('&');
}

function epochSecondsToYYYYMMDD(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}
