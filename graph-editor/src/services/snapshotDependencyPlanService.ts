/**
 * snapshotDependencyPlanService.ts
 *
 * Thin mapper: given a FetchPlan (from the existing planner) + analysis type contract
 * + scope rule + workspace identity, produces SnapshotSubjectRequest[] — the DB
 * coordinates the backend needs to retrieve historical snapshot data for analysis.
 *
 * This service does NOT duplicate fetch planning logic.  All target enumeration,
 * signature computation, MECE slice resolution, and time-bounds derivation is done
 * by the existing planner (fetchPlanBuilderService / windowFetchPlannerService).
 *
 * What this service adds:
 *   1. Scope filtering (which plan items are in-scope for this analysis type)
 *   2. core_hash computation (frontend is sole producer — see hash-fixes.md)
 *   3. read_mode + sweep bounds (from the analysis type's snapshotContract)
 *   4. Graph traversal helpers for funnel_path / reachable_from scope rules
 *
 * See: docs/current/project-db/1-reads.md
 */

import type { Graph } from '../types';
import type { FetchPlan, FetchPlanItem } from './fetchPlanTypes';
import type { SnapshotContract } from '../components/panels/analysisTypes';
import { ANALYSIS_TYPES } from '../components/panels/analysisTypes';
import { computeShortCoreHash } from './coreHashService';
import { parseDSL } from '../lib/queryDSL';
import { parseConstraints } from '../lib/queryDSL';
import { resolveRelativeDate, parseUKDate, formatDateUK } from '../lib/dateFormat';

// ============================================================
// Types
// ============================================================

export interface SnapshotSubjectRequest {
  // === Identity (frontend-computed, backend uses directly) ===

  /** Stable ID for joining results back to analysis scope */
  subject_id: string;

  /** Workspace-prefixed DB parameter identity */
  param_id: string;

  /** Full canonical signature (for audit/registry) */
  canonical_signature: string;

  /** Frontend-computed DB lookup key (see hash-fixes.md) */
  core_hash: string;

  // === Read intent ===

  read_mode: 'raw_snapshots' | 'virtual_snapshot' | 'cohort_maturity';

  // === Time bounds ===

  /** Anchor day range (ISO dates) */
  anchor_from: string;
  anchor_to: string;

  /** Point-in-time cut-off (ISO datetime; only for virtual_snapshot mode) */
  as_at?: string;

  /** Sweep range for cohort maturity mode (ISO dates) */
  sweep_from?: string;
  sweep_to?: string;

  // === Slice semantics ===

  /** Slice keys: MECE union → N keys; uncontexted → [''] */
  slice_keys: string[];

  // === Provenance (used for logging AND for graph lookups) ===

  target: {
    targetId: string;
    slot?: 'p' | 'cost_gbp' | 'labour_cost';
    conditionalIndex?: number;
  };
}

export interface ResolverResult {
  subjects: SnapshotSubjectRequest[];
  /** Subjects that were skipped (e.g. missing signature, no scope match) */
  skipped: Array<{ subjectId: string; reason: string }>;
}

// ============================================================
// Main mapper
// ============================================================

/**
 * Map a FetchPlan (from the existing planner) to SnapshotSubjectRequest[].
 *
 * @param plan          - FetchPlan built by buildFetchPlanProduction / buildFetchPlan
 * @param analysisType  - Analysis type ID (must have a snapshotContract)
 * @param graph         - The graph (needed for scope rule traversal)
 * @param selectedEdgeUuids - Currently selected edge UUIDs
 * @param workspace     - Workspace identity for param_id prefixing
 * @param queryDsl      - Raw DSL string (for time bounds + funnel_path from/to)
 *
 * @returns undefined if analysis type has no snapshotContract (standard analysis)
 */
export async function mapFetchPlanToSnapshotSubjects(args: {
  plan: FetchPlan;
  analysisType: string;
  graph: Graph;
  selectedEdgeUuids: string[];
  workspace: { repository: string; branch: string };
  queryDsl: string;
}): Promise<ResolverResult | undefined> {
  const { plan, analysisType, graph, selectedEdgeUuids, workspace, queryDsl } = args;

  // 1. Look up contract
  const meta = ANALYSIS_TYPES.find(t => t.id === analysisType);
  if (!meta?.snapshotContract) return undefined;
  const contract = meta.snapshotContract;

  // 2. Derive time bounds from DSL
  const timeBounds = deriveTimeBounds(contract, queryDsl);
  if (!timeBounds) {
    return { subjects: [], skipped: [{ subjectId: '*', reason: 'Could not derive time bounds from DSL' }] };
  }

  // 3. Filter plan items by scope rule
  const parameterItems = plan.items.filter(item => item.type === 'parameter');
  const inScopeItems = applyScopeRule(contract.scopeRule, parameterItems, selectedEdgeUuids, graph, queryDsl);

  // 4. Map each in-scope item to a SnapshotSubjectRequest
  const subjects: SnapshotSubjectRequest[] = [];
  const skipped: Array<{ subjectId: string; reason: string }> = [];

  for (const item of inScopeItems) {
    // Skip items without a query signature (means no data has been fetched yet)
    if (!item.querySignature) {
      skipped.push({ subjectId: item.itemKey, reason: 'No query signature on plan item' });
      continue;
    }

    // Compute core_hash from signature (frontend is sole producer)
    let coreHash: string;
    try {
      coreHash = await computeShortCoreHash(item.querySignature);
    } catch {
      skipped.push({ subjectId: item.itemKey, reason: 'Failed to compute core_hash' });
      continue;
    }

    // Workspace-prefixed param_id
    const paramId = `${workspace.repository}-${workspace.branch}-${item.objectId}`;

    // Slice keys:
    // sliceFamily encodes only the CONTEXT/CASE axis (e.g. "context(channel:google)").
    // The temporal MODE (window vs cohort) is part of slice identity for snapshot reads.
    const modeClause = item.mode === 'cohort' ? 'cohort()' : 'window()';
    const sliceKey = item.sliceFamily ? `${item.sliceFamily}.${modeClause}` : modeClause;
    const sliceKeys = [sliceKey];

    subjects.push({
      subject_id: item.itemKey,
      param_id: paramId,
      canonical_signature: item.querySignature,
      core_hash: coreHash,
      read_mode: contract.readMode,
      anchor_from: timeBounds.anchorFrom,
      anchor_to: timeBounds.anchorTo,
      ...(timeBounds.asAt ? { as_at: timeBounds.asAt } : {}),
      ...(timeBounds.sweepFrom ? { sweep_from: timeBounds.sweepFrom } : {}),
      ...(timeBounds.sweepTo ? { sweep_to: timeBounds.sweepTo } : {}),
      slice_keys: sliceKeys,
      target: {
        targetId: item.targetId,
        ...(item.slot ? { slot: item.slot } : {}),
        ...(item.conditionalIndex !== undefined ? { conditionalIndex: item.conditionalIndex } : {}),
      },
    });
  }

  return { subjects, skipped };
}

// ============================================================
// Scope Rules
// ============================================================

function applyScopeRule(
  rule: SnapshotContract['scopeRule'],
  items: FetchPlanItem[],
  selectedEdgeUuids: string[],
  graph: Graph,
  queryDsl?: string,
): FetchPlanItem[] {
  switch (rule) {
    case 'selection_edge':
    case 'selection_edges':
      return items.filter(item => selectedEdgeUuids.includes(item.targetId));

    case 'all_graph_parameters':
      return items;

    case 'funnel_path': {
      const edgeUuids = resolveFunnelPathEdges(graph, queryDsl);
      return items.filter(item => edgeUuids.has(item.targetId));
    }

    case 'reachable_from': {
      const edgeUuids = resolveReachableEdges(graph, selectedEdgeUuids);
      return items.filter(item => edgeUuids.has(item.targetId));
    }

    default:
      return [];
  }
}

// ============================================================
// Graph Traversal Helpers
// ============================================================

/**
 * Resolve funnel path edges: all edges on any path from `from` to `to`.
 * Exported for testing.
 *
 * Uses backward BFS from `to` to find all nodes that can reach `to`,
 * intersected with forward BFS from `from` to find all nodes reachable from
 * `from`. Edges whose both endpoints are in the intersection are on a valid path.
 */
export function resolveFunnelPathEdges(graph: Graph, queryDsl?: string): Set<string> {
  if (!queryDsl) return new Set();

  const parsed = parseDSL(queryDsl);
  const fromNodeHrn = parsed.from;
  const toNodeHrn = parsed.to;
  if (!fromNodeHrn || !toNodeHrn) return new Set();

  const nodes = graph.nodes || [];
  const edges = (graph as any).edges || [];

  // Resolve human-readable IDs to UUIDs
  const fromUuid = nodes.find((n: any) => n.id === fromNodeHrn)?.uuid;
  const toUuid = nodes.find((n: any) => n.id === toNodeHrn)?.uuid;
  if (!fromUuid || !toUuid) return new Set();

  // Build adjacency lists
  const forwardAdj = new Map<string, string[]>();
  const backwardAdj = new Map<string, string[]>();

  for (const edge of edges) {
    const f = edge.from as string;
    const t = edge.to as string;
    if (!f || !t) continue;

    if (!forwardAdj.has(f)) forwardAdj.set(f, []);
    forwardAdj.get(f)!.push(t);

    if (!backwardAdj.has(t)) backwardAdj.set(t, []);
    backwardAdj.get(t)!.push(f);
  }

  // Forward BFS from fromUuid, backward BFS from toUuid
  const reachableFromStart = bfs(fromUuid, forwardAdj);
  const reachableToEnd = bfs(toUuid, backwardAdj);

  // Intersection: nodes on a valid from→to path
  const onPath = new Set<string>();
  for (const n of reachableFromStart) {
    if (reachableToEnd.has(n)) onPath.add(n);
  }

  // Collect edges whose both endpoints are on a valid path
  const result = new Set<string>();
  for (const edge of edges) {
    if (onPath.has(edge.from) && onPath.has(edge.to)) {
      result.add(edge.uuid);
    }
  }

  return result;
}

/**
 * Resolve reachable edges: BFS from selected nodes (resolved from edge endpoints)
 * to collect all downstream edges.
 * Exported for testing.
 */
export function resolveReachableEdges(graph: Graph, selectedEdgeUuids: string[]): Set<string> {
  const edges = (graph as any).edges || [];

  // Find starting nodes: the "from" endpoints of selected edges
  const startNodes = new Set<string>();
  for (const edge of edges) {
    if (selectedEdgeUuids.includes(edge.uuid)) {
      startNodes.add(edge.from as string);
    }
  }

  if (startNodes.size === 0) return new Set();

  // Build forward adjacency
  const forwardAdj = new Map<string, string[]>();
  for (const edge of edges) {
    const f = edge.from as string;
    const t = edge.to as string;
    if (!f || !t) continue;
    if (!forwardAdj.has(f)) forwardAdj.set(f, []);
    forwardAdj.get(f)!.push(t);
  }

  // BFS from all start nodes
  const reachable = new Set<string>();
  for (const start of startNodes) {
    for (const n of bfs(start, forwardAdj)) {
      reachable.add(n);
    }
  }

  // Collect edges whose "from" node is reachable
  const result = new Set<string>();
  for (const edge of edges) {
    if (reachable.has(edge.from as string)) {
      result.add(edge.uuid);
    }
  }

  return result;
}

/**
 * Simple BFS from a start node using an adjacency list. Returns all reachable nodes
 * (including the start node).
 */
function bfs(start: string, adj: Map<string, string[]>): Set<string> {
  const visited = new Set<string>();
  const queue = [start];
  visited.add(start);

  while (queue.length > 0) {
    const current = queue.shift()!;
    const neighbours = adj.get(current) || [];
    for (const n of neighbours) {
      if (!visited.has(n)) {
        visited.add(n);
        queue.push(n);
      }
    }
  }

  return visited;
}

// ============================================================
// Time Bounds (snapshot-specific: sweep range for cohort_maturity)
// ============================================================

interface TimeBounds {
  anchorFrom: string;  // ISO date
  anchorTo: string;    // ISO date
  asAt?: string;       // ISO datetime
  sweepFrom?: string;  // ISO date (cohort_maturity mode)
  sweepTo?: string;    // ISO date (cohort_maturity mode)
}

/**
 * Derive snapshot-specific time bounds from DSL.
 *
 * The anchor_from/to come from window() or cohort() in the DSL — same as
 * the planner's extractWindowFromDSL, just converted to ISO.
 * sweep_from/to are only set for cohort_maturity read mode.
 */
function deriveTimeBounds(contract: SnapshotContract, queryDsl: string): TimeBounds | null {
  if (contract.timeBoundsSource !== 'query_dsl_window') return null;

  const parsed = parseConstraints(queryDsl);
  const dateRange = parsed.cohort || parsed.window;
  if (!dateRange) return null;

  const startStr = ('start' in dateRange ? dateRange.start : undefined) ?? '';
  const endStr = ('end' in dateRange ? dateRange.end : undefined) ?? '';
  if (!startStr) return null;

  const resolvedStart = resolveRelativeDate(startStr);
  const resolvedEnd = endStr ? resolveRelativeDate(endStr) : formatDateUK(new Date());

  let anchorFromISO: string;
  let anchorToISO: string;
  try {
    anchorFromISO = parseUKDate(resolvedStart).toISOString().split('T')[0];
    anchorToISO = parseUKDate(resolvedEnd).toISOString().split('T')[0];
  } catch {
    return null;
  }

  const result: TimeBounds = { anchorFrom: anchorFromISO, anchorTo: anchorToISO };

  // asat() → point-in-time cut-off (for virtual_snapshot and sweep upper bound)
  if (parsed.asat) {
    try {
      const resolvedAsAt = resolveRelativeDate(parsed.asat);
      result.asAt = parseUKDate(resolvedAsAt).toISOString();
    } catch {
      // Non-fatal: proceed without as_at
    }
  }

  if (contract.readMode === 'cohort_maturity') {
    result.sweepFrom = anchorFromISO;
    // sweep_to = asat() date if user is doing a historical view, otherwise today
    if (result.asAt) {
      result.sweepTo = result.asAt.split('T')[0];
    } else {
      result.sweepTo = new Date().toISOString().split('T')[0];
    }
  }

  return result;
}
