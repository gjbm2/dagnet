import type { GraphData } from '../types';
import { fileRegistry } from '../contexts/TabContext';
import { parseConstraints } from '../lib/queryDSL';
import { extractSliceDimensions, hasContextAny } from './sliceIsolation';
import { parseSignature } from './signatureMatchingService';
import { computeQuerySignature } from './dataOperationsService';
import {
  getBatchInventoryV2,
  querySnapshotRetrievals,
  type QuerySnapshotRetrievalsParams,
  type QuerySnapshotRetrievalsResult
} from './snapshotWriteService';
import { db } from '../db/appDatabase';
import { getClosureSet } from './hashMappingsService';

const providerByConnection = new Map<string, string>();

async function resolveProviderForConnection(connectionName: string): Promise<string | undefined> {
  const key = String(connectionName || '');
  if (!key) return undefined;
  if (providerByConnection.has(key)) return providerByConnection.get(key);

  // Prefer connections.yaml (DAS runner) as the source of truth.
  try {
    const { createDASRunner } = await import('../lib/das');
    const runner = createDASRunner();
    const conn = await (runner as any).connectionProvider.getConnection(key);
    const provider = conn?.provider;
    if (provider) {
      providerByConnection.set(key, provider);
      return provider;
    }
  } catch {
    // Ignore and fall back to inference (keeps Phase 2 UI working in test/dev environments).
  }

  // Conservative inference fallback (mirrors plannerQuerySignatureService behaviour).
  const lower = key.toLowerCase();
  const inferred =
    lower.includes('amplitude') ? 'amplitude'
    : lower.includes('sheets') || lower.includes('google') ? 'sheets'
    : lower.includes('statsig') ? 'statsig'
    : lower.includes('optimizely') ? 'optimizely'
    : undefined;

  if (inferred) providerByConnection.set(key, inferred);
  return inferred;
}

function extractContextKeysFromConstraints(constraints?: {
  context?: Array<{ key: string }>;
  contextAny?: Array<{ pairs: Array<{ key: string }> }>;
}): string[] {
  const keys = new Set<string>();
  for (const c of constraints?.context || []) keys.add(c.key);
  for (const ca of constraints?.contextAny || []) for (const p of ca.pairs || []) keys.add(p.key);
  return Array.from(keys);
}

function stripAsatClause(dsl: string): string {
  return (dsl || '').replace(/\.?(?:asat|at)\([^)]+\)/g, '').replace(/^\./, '');
}


export async function buildSnapshotRetrievalsQueryForEdge(args: {
  graph: GraphData;
  edgeId: string;
  effectiveDSL: string;
  workspace?: { repository: string; branch: string };
}): Promise<QuerySnapshotRetrievalsParams | null> {
  const { graph, edgeId, effectiveDSL, workspace } = args;
  const edge: any = graph?.edges?.find((e: any) => e?.uuid === edgeId || e?.id === edgeId);
  if (!edge) return null;

  const paramId: string | undefined = edge?.p?.id || edge?.p?.parameter_id;
  if (!paramId) return null;

  const paramFile = fileRegistry.getFile(`parameter-${paramId}`);
  // Prefer the parameter file's workspace when available (it is the source of truth for param_id prefixing).
  // Fall back to the caller-provided workspace only when the param file is not loaded in FileRegistry.
  const workspaceRepo = paramFile?.source?.repository ?? workspace?.repository;
  const workspaceBranch = paramFile?.source?.branch ?? workspace?.branch;
  if (!workspaceRepo || !workspaceBranch) return null;

  const dbParamId = `${workspaceRepo}-${workspaceBranch}-${paramId}`;

  const dslWithoutAsat = stripAsatClause(effectiveDSL);
  const constraintsWithoutAsat = parseConstraints(dslWithoutAsat);

  // NOTE: We intentionally do NOT send anchor_from/anchor_to to the retrievals
  // endpoint.  The @ calendar answers "was a snapshot retrieved on this day?" —
  // it doesn't matter whether the anchor_days in that retrieval happen to
  // overlap the user's current query window.  Filtering by anchor range caused
  // incremental fetches (which only cover new days) to be invisible in the
  // calendar even though the retrieval genuinely exists.

  // Slice filter:
  // The DB stores `slice_key` as a FULL clause string including BOTH:
  // - context dimensions, e.g. "context(channel:influencer)"
  // - temporal mode + date-range template, e.g. ".window(-100d:)" or ".cohort(1-Nov-25:15-Dec-25)"
  //
  // So we MUST send EXACT `slice_key` strings that exist in the DB — not a derived DSL from the
  // current query's date bounds (which often differ from what was written historically).
  //
  // The DB has sufficient information to do this: we query snapshot inventory V2 for the
  // matched signature family, then filter its `by_slice_key[].slice_key` entries by context dims.
  const contextDims = extractSliceDimensions(dslWithoutAsat);

  // Compute signature (core_hash) via the existing code path.
  // For uncontexted queries, include pinned context keys (graph.dataInterestsDSL) so
  // the signature remains stable for MECE slice aggregation.
  const connectionName =
    edge?.p?.connection ||
    edge?.cost_gbp?.connection ||
    edge?.labour_cost?.connection ||
    'amplitude';

  const { buildDslFromEdge } = await import('../lib/das/buildDslFromEdge');
  const connectionProvider = await resolveProviderForConnection(connectionName);
  // IMPORTANT:
  // We must compute the signature using the same event-definition inputs as the write path,
  // otherwise `core_hash` won't match and the calendar will show no highlighted days even
  // when snapshots exist.
  const eventLoader = async (eventId: string) => {
    const fileId = `event-${eventId}`;

    // Prefer fileRegistry (already hydrated during normal app flow).
    const frFile: any = fileRegistry.getFile(fileId);
    if (frFile?.data) return frFile.data;

    // Fall back to IndexedDB (source of truth) if not hydrated in FileRegistry.
    try {
      const dbFile: any = await db.files.get(fileId);
      if (dbFile?.data) return dbFile.data;
    } catch {
      // ignore DB errors, will throw below
    }

    // HARD FAIL: Event files MUST be available. If not, this is a bug.
    throw new Error(`[snapshotRetrievalsService] Event file "${eventId}" not found in fileRegistry or IndexedDB. This indicates a workspace/clone issue.`);
  };

  const { queryPayload, eventDefinitions } = await buildDslFromEdge(
    edge,
    graph,
    connectionProvider,
    eventLoader,
    constraintsWithoutAsat
  );

  const contextKeys = (() => {
    const explicit = extractContextKeysFromConstraints(constraintsWithoutAsat);
    if (explicit.length > 0) return explicit;
    try {
      const pinnedDsl = (graph as any)?.dataInterestsDSL || '';
      if (!pinnedDsl) return [];
      return extractContextKeysFromConstraints(parseConstraints(pinnedDsl));
    } catch {
      return [];
    }
  })();

  const signature = await computeQuerySignature(
    queryPayload,
    connectionName,
    graph,
    edge,
    contextKeys,
    { repository: workspaceRepo, branch: workspaceBranch },
    eventDefinitions
  );

  const sigParsed = parseSignature(signature);
  if (!sigParsed.coreHash) return null;

  let slice_keys: string[] | undefined;
  const wantSliceFilter = !!contextDims && !hasContextAny(dslWithoutAsat);
  if (wantSliceFilter) {
    try {
      const closureSet = getClosureSet(sigParsed.coreHash!);
      const inv = await getBatchInventoryV2([dbParamId], {
        current_signatures: { [dbParamId]: signature },
        ...(closureSet.length > 0
          ? { equivalent_hashes_by_param: { [dbParamId]: closureSet } }
          : {}),
        // We want a reliable slice listing for this family; clamp is 2000 server-side.
        limit_families_per_param: 50,
        limit_slices_per_family: 2000,
      });

      const pidInv = inv?.[dbParamId];
      const matchedFamilyId = pidInv?.current?.matched_family_id;
      const matchedFamily = matchedFamilyId
        ? pidInv?.families?.find((f) => f.family_id === matchedFamilyId)
        : undefined;

      const candidates = (matchedFamily?.by_slice_key || [])
        .map((s) => s.slice_key)
        .filter((k) => extractSliceDimensions(k) === contextDims);

      // If we have explicit context dims, we should be strict: no match → query returns none.
      slice_keys = Array.from(new Set(candidates));
    } catch {
      // Fail-safe: if inventory is unavailable, do not attempt a fuzzy guess.
      // (Returning undefined would incorrectly mix other contexts.)
      slice_keys = [];
    }
  }

  return {
    param_id: dbParamId,
    // IMPORTANT: the backend expects the full canonical signature string.
    // (It derives the short `core_hash` server-side.)
    canonical_signature: signature,
    slice_keys,
    // No anchor_from/anchor_to — see comment above.
    limit: 200,
  };
}

export async function getSnapshotRetrievalsForEdge(args: {
  graph: GraphData;
  edgeId: string;
  effectiveDSL: string;
  workspace?: { repository: string; branch: string };
}): Promise<QuerySnapshotRetrievalsResult> {
  const query = await buildSnapshotRetrievalsQueryForEdge(args);
  if (!query) {
    return {
      success: false,
      retrieved_at: [],
      retrieved_days: [],
      latest_retrieved_at: null,
      count: 0,
      error: 'Could not determine snapshot subject (missing edge/parameter/workspace metadata or signature)',
    };
  }
  return await querySnapshotRetrievals(query);
}

// ---------------------------------------------------------------------------
// Aggregate coverage: snapshot availability across a set of edges (per-param)
// ---------------------------------------------------------------------------

/** Collect edge IDs (uuid) from the graph, limited to connected edges (those with a p.id). */
function collectConnectedEdgeIds(graph: GraphData): string[] {
  return (graph.edges || [])
    .filter((e: any) => e?.p?.id || e?.p?.parameter_id)
    .map((e: any) => e.uuid || e.id)
    .filter(Boolean) as string[];
}

/** Check whether a specific edge has a connected parameter. */
function edgeHasParam(graph: GraphData, edgeId: string): boolean {
  const edge: any = (graph.edges || []).find((e: any) => e?.uuid === edgeId || e?.id === edgeId);
  return !!(edge?.p?.id || edge?.p?.parameter_id);
}

export interface SnapshotCoverageResult {
  success: boolean;
  /** Map from ISO date → coverage fraction (0.0–1.0) */
  coverageByDay: Record<string, number>;
  /** Number of params considered (each edge contributes its p param) */
  totalParams: number;
  /** All retrieved_days across all params (sorted desc) */
  allDays: string[];
  error?: string;
}

/**
 * Compute per-day snapshot coverage across params belonging to a set of edges.
 *
 * Uses `getSnapshotRetrievalsForEdge` per edge (signature-filtered) so results
 * are consistent with what edge tooltips show.  Each edge contributes its
 * primary `p` parameter to the coverage calculation.
 *
 * Coverage for a day = (params with at least one snapshot on that day) / totalParams.
 *
 * @param edgeIds - Edge UUIDs to query. If empty/undefined, queries ALL edges in the graph.
 */
export async function getSnapshotCoverageForEdges(args: {
  graph: GraphData;
  effectiveDSL: string;
  workspace?: { repository: string; branch: string };
  edgeIds?: string[];
}): Promise<SnapshotCoverageResult> {
  const { graph, effectiveDSL, workspace, edgeIds } = args;
  // Only consider edges that actually have a connected parameter (p.id).
  // Edges without a connection can never have snapshots, so including them
  // would artificially deflate the coverage fraction.
  const rawIds = edgeIds && edgeIds.length > 0 ? edgeIds : collectConnectedEdgeIds(graph);
  const targetEdgeIds = edgeIds ? rawIds.filter((id) => edgeHasParam(graph, id)) : rawIds;

  if (targetEdgeIds.length === 0) {
    return { success: true, coverageByDay: {}, totalParams: 0, allDays: [] };
  }

  try {
    // Fire all per-edge retrieval queries in parallel (each is signature-filtered).
    // Each result represents one param (edge.p).
    const results = await Promise.all(
      targetEdgeIds.map((edgeId) =>
        getSnapshotRetrievalsForEdge({ graph, edgeId, effectiveDSL, workspace })
          .catch((): QuerySnapshotRetrievalsResult => ({
            success: false, retrieved_at: [], retrieved_days: [],
            latest_retrieved_at: null, count: 0, error: 'fetch failed',
          }))
      )
    );

    // Aggregate: for each day, count how many params have data.
    const dayCounts: Record<string, number> = {};
    const allDaysSet = new Set<string>();
    for (const res of results) {
      if (!res.success) continue;
      for (const day of res.retrieved_days) {
        dayCounts[day] = (dayCounts[day] || 0) + 1;
        allDaysSet.add(day);
      }
    }

    const totalParams = targetEdgeIds.length;
    const coverageByDay: Record<string, number> = {};
    for (const [day, count] of Object.entries(dayCounts)) {
      coverageByDay[day] = count / totalParams;
    }

    const allDays = Array.from(allDaysSet).sort().reverse();
    return { success: true, coverageByDay, totalParams, allDays };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { success: false, coverageByDay: {}, totalParams: targetEdgeIds.length, allDays: [], error: errorMessage };
  }
}

