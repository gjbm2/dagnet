/**
 * Snapshot Retrievals Service
 *
 * Provides the @ menu (asat calendar) and snapshot coverage APIs.
 *
 * Design (7-Apr-26):
 *   The @ menu needs to find ALL snapshots that could fulfil the current queryDSL,
 *   spanning multiple dataInterestsDSL epochs and hash mapping changes.
 *
 *   It does NOT reference dataInterestsDSL directly. Instead it:
 *   1. Enumerates plausible context key-sets from stored parameter file slices
 *   2. Computes a signature for each key-set (same computeQuerySignature as fetch)
 *   3. Queries the snapshot DB with ALL hashes via hash_groups (one SQL per edge)
 *   4. Unions retrieved days per edge (boolean — no double-counting)
 *
 *   Three inputs determine plausible hashes:
 *     (a) stored parameter values (slice topology in files)
 *     (b) context definitions (MECE status from contextRegistry)
 *     (c) the queryDSL (narrows to explicit context keys if present)
 *
 * @see docs/current/project-contexts/snapshot-epoch-resolution-design.md
 * @see docs/current/project-contexts/mece-context-aggregation-design.md
 */
import type { GraphData } from '../types';
import type { ParameterValue } from '../types/parameterData';
import { fileRegistry } from '../contexts/TabContext';
import { parseConstraints } from '../lib/queryDSL';
import { extractSliceDimensions, hasContextAny } from './sliceIsolation';
import { parseSignature } from './signatureMatchingService';
import { computeQuerySignature } from './dataOperationsService';
import {
  getBatchInventoryV2,
  getBatchRetrievals,
  querySnapshotRetrievals,
  type BatchRetrievalsSubject,
  type QuerySnapshotRetrievalsParams,
  type QuerySnapshotRetrievalsResult
} from './snapshotWriteService';
import { computeShortCoreHash } from './coreHashService';
import { db } from '../db/appDatabase';
import { getClosureSet, type ClosureEntry } from './hashMappingsService';
import { selectImplicitUncontextedSliceSetSync } from './meceSliceService';

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

// ---------------------------------------------------------------------------
// Workspace scope — derived once lazily, reused for all restoreFile calls.
// ---------------------------------------------------------------------------

let cachedWorkspaceScope: { repository: string; branch: string } | undefined;

function getWorkspaceScope(): { repository: string; branch: string } | undefined {
  if (cachedWorkspaceScope) return cachedWorkspaceScope;
  const filesMap = (fileRegistry as any)?.files;
  if (filesMap && typeof filesMap.values === 'function') {
    try {
      for (const f of filesMap.values()) {
        const src = (f as any)?.source;
        if (src?.repository && src?.branch) {
          cachedWorkspaceScope = { repository: src.repository, branch: src.branch };
          return cachedWorkspaceScope;
        }
      }
    } catch { /* ignore */ }
  }
  return undefined;
}

// Event loader shared by all signature-computing paths in this module.
// Uses restoreFile with workspace-prefixed IDB fallback (same pattern as plannerQuerySignatureService).
async function loadEventDefinition(eventId: string): Promise<any> {
  const fileId = `event-${eventId}`;
  let file = fileRegistry.getFile(fileId);
  if (file?.data) return (file as any).data;

  // Restore from IDB with workspace-prefixed key fallback
  try {
    await fileRegistry.restoreFile(fileId, getWorkspaceScope());
    file = fileRegistry.getFile(fileId);
    if (file?.data) return (file as any).data;
  } catch { /* ignore */ }

  throw new Error(`[snapshotRetrievalsService] Event file "${eventId}" not found in fileRegistry or IndexedDB.`);
}

// ---------------------------------------------------------------------------
// Context key resolution — from stored slice topology, NOT from dataInterestsDSL
// ---------------------------------------------------------------------------

/**
 * Enumerate ALL plausible context key-sets that could fulfil the queryDSL,
 * based on what slices actually exist in the parameter file.
 *
 * Three inputs only:
 *   (a) stored parameter values (slice topology)
 *   (b) context definitions (MECE status via contextRegistry)
 *   (c) the queryDSL constraints
 *
 * Returns an array of key-sets. Each key-set, when passed to computeQuerySignature,
 * produces a different hash. The @ menu should query the snapshot DB with ALL of them
 * and union the results (per-day boolean, no double-counting).
 *
 * When the queryDSL has explicit context keys, only that key-set is returned.
 * When the queryDSL is uncontexted, we return:
 *   - [] (uncontexted signature) — in case explicit uncontexted snapshots exist
 *   - Each single MECE context key found in stored slices
 *   - Each multi-key MECE cross-product key-set found in stored slices
 */
function enumeratePlausibleContextKeySets(
  constraintsWithoutAsat: any,
  paramValues: ParameterValue[],
): string[][] {
  // If the DSL has explicit context keys, only that key-set is plausible
  const explicit = extractContextKeysFromConstraints(constraintsWithoutAsat);
  if (explicit.length > 0) return [explicit.sort()];

  // No explicit context — enumerate all plausible key-sets from stored slices
  const keySets = new Set<string>();  // serialised key-sets for dedup
  const result: string[][] = [];

  // Always include uncontexted (empty key-set) — covers epoch A-style data
  keySets.add('');
  result.push([]);

  if (!paramValues || paramValues.length === 0) return result;

  // Extract all distinct single-key and multi-key context key-sets from stored slices
  for (const pv of paramValues) {
    const dims = extractSliceDimensions(pv.sliceDSL ?? '');
    if (!dims) continue;
    try {
      const parsed = parseConstraints(dims);
      if (parsed.contextAny.length > 0) continue;  // contextAny not usable for MECE
      if (parsed.context.length === 0) continue;
      if (dims.includes('case(')) continue;  // case dims excluded

      const keys = [...new Set(parsed.context.map(c => c.key))].sort();
      const keySetId = keys.join('||');
      if (!keySets.has(keySetId)) {
        keySets.add(keySetId);
        result.push(keys);
      }
    } catch { /* ignore unparseable slices */ }
  }

  return result;
}

export interface EdgeSignatureResult {
  signature: string;
  /** The inner identity hash (~64-char hex) from the structured signature's `c` field.
   *  ⚠ NOT the DB `core_hash` (~22-char base64url). Use computeShortCoreHash() to get that. */
  identityHash: string;
  paramId: string;
  dbParamId: string;
  contextKeys: string[];
}

/**
 * Compute ALL plausible signatures for an edge that could match stored snapshots.
 *
 * Returns one signature per plausible context key-set. For an uncontexted queryDSL
 * on a graph that has been through multiple dataInterestsDSL epochs, this may return
 * several signatures (uncontexted + one per MECE context dim observed in stored slices).
 *
 * The @ menu should query the snapshot DB with ALL returned hashes and union the
 * retrieved days (per-day boolean, no double-counting).
 */
export async function computePlausibleSignaturesForEdge(args: {
  graph: GraphData;
  edgeId: string;
  effectiveDSL: string;
  workspace?: { repository: string; branch: string };
}): Promise<EdgeSignatureResult[]> {
  const { graph, edgeId, effectiveDSL, workspace } = args;
  const edge: any = graph?.edges?.find((e: any) => e?.uuid === edgeId || e?.id === edgeId);
  if (!edge) return [];

  const paramId: string | undefined = edge?.p?.id || edge?.p?.parameter_id;
  if (!paramId) return [];

  // Load parameter file — try FileRegistry first, then restore from IDB with workspace prefix
  let paramFile = fileRegistry.getFile(`parameter-${paramId}`);
  if (!paramFile) {
    try {
      const ws = workspace ?? getWorkspaceScope();
      await fileRegistry.restoreFile(`parameter-${paramId}`, ws);
      paramFile = fileRegistry.getFile(`parameter-${paramId}`);
    } catch { /* ignore */ }
  }

  const workspaceRepo = paramFile?.source?.repository ?? workspace?.repository;
  const workspaceBranch = paramFile?.source?.branch ?? workspace?.branch;
  if (!workspaceRepo || !workspaceBranch) return [];

  const dbParamId = `${workspaceRepo}-${workspaceBranch}-${paramId}`;
  const dslWithoutAsat = stripAsatClause(effectiveDSL);
  const constraintsWithoutAsat = parseConstraints(dslWithoutAsat);

  const connectionName =
    edge?.p?.connection ||
    edge?.cost_gbp?.connection ||
    edge?.labour_cost?.connection ||
    'amplitude';

  const { buildDslFromEdge } = await import('../lib/das/buildDslFromEdge');
  const connectionProvider = await resolveProviderForConnection(connectionName);

  const { queryPayload, eventDefinitions } = await buildDslFromEdge(
    edge, graph, connectionProvider, loadEventDefinition, constraintsWithoutAsat
  );

  // Enumerate all plausible context key-sets from stored slice topology
  const paramValues: ParameterValue[] = Array.isArray((paramFile as any)?.data?.values)
    ? (paramFile as any).data.values
    : [];
  const keySets = enumeratePlausibleContextKeySets(constraintsWithoutAsat, paramValues);

  // Compute a signature for each key-set
  const results: EdgeSignatureResult[] = [];
  for (const contextKeys of keySets) {
    try {
      const signature = await computeQuerySignature(
        queryPayload, connectionName, graph, edge, contextKeys,
        { repository: workspaceRepo, branch: workspaceBranch },
        eventDefinitions
      );
      const sigParsed = parseSignature(signature);
      if (sigParsed.identityHash) {
        results.push({ signature, identityHash: sigParsed.identityHash, paramId, dbParamId, contextKeys });
      }
    } catch {
      // Skip key-sets that fail signature computation (e.g., context def not loaded)
    }
  }

  return results;
}

/**
 * Backward-compatible wrapper: returns the first plausible signature.
 * Used by callers that only need a single signature (e.g., snapshot write path).
 */
export async function computeCurrentSignatureForEdge(args: {
  graph: GraphData;
  edgeId: string;
  effectiveDSL: string;
  workspace?: { repository: string; branch: string };
}): Promise<EdgeSignatureResult | null> {
  const results = await computePlausibleSignaturesForEdge(args);
  return results.length > 0 ? results[0] : null;
}

export async function buildSnapshotRetrievalsQueryForEdge(args: {
  graph: GraphData;
  edgeId: string;
  effectiveDSL: string;
  workspace?: { repository: string; branch: string };
  limit?: number;
}): Promise<QuerySnapshotRetrievalsParams | null> {
  const sigResult = await computeCurrentSignatureForEdge(args);
  if (!sigResult) return null;

  const { signature, identityHash, paramId, dbParamId } = sigResult;

  const dslWithoutAsat = stripAsatClause(args.effectiveDSL);
  const contextDims = extractSliceDimensions(dslWithoutAsat);

  let slice_keys: string[] | undefined;
  const wantSliceFilter = !!contextDims && !hasContextAny(dslWithoutAsat);
  if (wantSliceFilter) {
    try {
      const closureSet = getClosureSet(identityHash);
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
    limit: args.limit ?? 200,
  };
}

export async function getSnapshotRetrievalsForEdge(args: {
  graph: GraphData;
  edgeId: string;
  effectiveDSL: string;
  workspace?: { repository: string; branch: string };
  limit?: number;
}): Promise<QuerySnapshotRetrievalsResult> {
  // Compute ALL plausible signatures for this edge
  const sigs = await computePlausibleSignaturesForEdge(args);
  if (sigs.length === 0) {
    return {
      success: false,
      retrieved_at: [],
      retrieved_days: [],
      latest_retrieved_at: null,
      count: 0,
      error: 'Could not determine snapshot subject (missing edge/parameter/workspace metadata or signature)',
    };
  }

  // Build hash_groups — all plausible hashes in one subject, one SQL query
  const hashGroups: Array<{ core_hash: string; equivalent_hashes?: ClosureEntry[] }> = [];
  for (const sig of sigs) {
    const shortHash = await computeShortCoreHash(sig.signature);
    const closure = getClosureSet(shortHash);
    hashGroups.push({
      core_hash: shortHash,
      ...(closure.length > 0 ? { equivalent_hashes: closure } : {}),
    });
  }

  const batchResults = await getBatchRetrievals([{
    param_id: sigs[0].dbParamId,
    hash_groups: hashGroups,
  }], args.limit ?? 200);

  const allDaysSet = new Set<string>();
  const allRetrievedAt = new Set<string>();
  for (const res of batchResults) {
    if (!res?.success) continue;
    for (const day of res.retrieved_days) allDaysSet.add(day);
    for (const rat of res.retrieved_at) allRetrievedAt.add(rat);
  }

  const retrieved_days = Array.from(allDaysSet).sort().reverse();
  const retrieved_at = Array.from(allRetrievedAt).sort().reverse();

  return {
    success: true,
    retrieved_at,
    retrieved_days,
    latest_retrieved_at: retrieved_at[0] ?? null,
    count: retrieved_at.length,
  };
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

/**
 * Batched version of getSnapshotCoverageForEdges.
 *
 * Same contract, same output — but uses 2 API round-trips (one inventory +
 * one batch-retrievals) instead of 2N individual calls.
 *
 * NOT yet wired into the UI. Exported for parity testing against the
 * original N-parallel implementation.
 */
export async function getSnapshotCoverageForEdgesBatched(args: {
  graph: GraphData;
  effectiveDSL: string;
  workspace?: { repository: string; branch: string };
  edgeIds?: string[];
}): Promise<SnapshotCoverageResult> {
  const { graph, effectiveDSL, workspace, edgeIds } = args;
  const rawIds = edgeIds && edgeIds.length > 0 ? edgeIds : collectConnectedEdgeIds(graph);
  const targetEdgeIds = edgeIds ? rawIds.filter((id) => edgeHasParam(graph, id)) : rawIds;

  if (targetEdgeIds.length === 0) {
    return { success: true, coverageByDay: {}, totalParams: 0, allDays: [] };
  }

  try {
    // Step 1: Compute ALL plausible signatures per edge (parallel, no network)
    const allSigResults = await Promise.all(
      targetEdgeIds.map((edgeId) =>
        computePlausibleSignaturesForEdge({ graph, edgeId, effectiveDSL, workspace })
          .catch((): EdgeSignatureResult[] => [])
      )
    );

    // Build one subject per edge with hash_groups — all plausible hashes collapsed
    const subjects: BatchRetrievalsSubject[] = [];
    const subjectToEdgeIndex: number[] = [];  // maps subject index → edge index

    for (let edgeIdx = 0; edgeIdx < targetEdgeIds.length; edgeIdx++) {
      const sigs = allSigResults[edgeIdx];
      if (!sigs || sigs.length === 0) continue;

      const hashGroups: Array<{ core_hash: string; equivalent_hashes?: ClosureEntry[] }> = [];
      for (const sig of sigs) {
        const shortHash = await computeShortCoreHash(sig.signature);
        const closure = getClosureSet(shortHash);
        hashGroups.push({
          core_hash: shortHash,
          ...(closure.length > 0 ? { equivalent_hashes: closure } : {}),
        });
      }

      subjects.push({
        param_id: sigs[0].dbParamId,
        hash_groups: hashGroups,
      });
      subjectToEdgeIndex.push(edgeIdx);
    }

    if (subjects.length === 0) {
      return { success: true, coverageByDay: {}, totalParams: targetEdgeIds.length, allDays: [] };
    }

    // Step 2: ONE batched retrievals call — one subject per edge
    const batchResults = await getBatchRetrievals(subjects, 200);

    // Step 3: Aggregate coverage — per edge, per day, boolean
    const dayCounts: Record<string, number> = {};
    const allDaysSet = new Set<string>();

    for (let subIdx = 0; subIdx < batchResults.length; subIdx++) {
      const res = batchResults[subIdx];
      if (!res?.success) continue;
      // Each subject = one edge. Days are already unioned by the backend (single SQL ANY query).
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

