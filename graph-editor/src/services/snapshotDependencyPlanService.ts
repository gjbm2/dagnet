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
import { extractSliceDimensions } from './sliceIsolation';
import { contextRegistry } from './contextRegistry';
import { verifyAllCombinationsExist } from './dimensionalReductionService';
import { querySnapshotRetrievals, type SnapshotRetrievalSummaryRow } from './snapshotWriteService';

function isDev(): boolean {
  try {
    return !!(import.meta as any)?.env?.DEV;
  } catch {
    return false;
  }
}

// ============================================================
// DSL helpers (shared by AnalyticsPanel + share hooks)
// ============================================================

/**
 * Compose a DSL for snapshot analysis by merging:
 *   - from/to from the analytics DSL (defines what to analyse)
 *   - window/cohort/asat/context from the query DSL (defines the data scope)
 *
 * If the analytics DSL already contains temporal or context clauses, those
 * take priority (user override).
 */
export function composeSnapshotDsl(analyticsDsl: string, queryDsl: string): string {
  if (!queryDsl) return analyticsDsl;
  if (!analyticsDsl) return queryDsl;

  const ap = parseConstraints(analyticsDsl);
  const qp = parseConstraints(queryDsl);

  const parts: string[] = [analyticsDsl];

  if (!ap.window && !ap.cohort) {
    if (qp.cohort) {
      const anchor = (qp.cohort as any).anchor;
      const start = qp.cohort.start ?? '';
      const end = qp.cohort.end ?? '';
      parts.push(anchor ? `cohort(${anchor},${start}:${end})` : `cohort(${start}:${end})`);
    } else if (qp.window) {
      const start = qp.window.start ?? '';
      const end = qp.window.end ?? '';
      parts.push(`window(${start}:${end})`);
    }
  }

  if (!ap.asatClausePresent && qp.asat) {
    parts.push(`asat(${qp.asat})`);
  }

  if (!ap.contextClausePresent && qp.context && qp.context.length > 0) {
    for (const ctx of qp.context) {
      parts.push(ctx.value ? `context(${ctx.key}:${ctx.value})` : `context(${ctx.key})`);
    }
  }

  return parts.join('.');
}

/** Extract DateRange from DSL window()/cohort() clause. */
export function extractDateRangeFromDSL(dsl: string): { start: string; end: string } | null {
  try {
    const constraints = parseConstraints(dsl);
    const range = constraints.cohort || constraints.window;
    if (!range || !('start' in range) || !range.start) return null;
    const start = resolveRelativeDate(range.start);
    const end = ('end' in range && range.end) ? resolveRelativeDate(range.end) : formatDateUK(new Date());
    return { start, end };
  } catch {
    return null;
  }
}

// ============================================================
// Types
// ============================================================

export interface SnapshotSubjectRequest {
  // === Identity (frontend-computed, backend uses directly) ===

  /** Stable ID for joining results back to analysis scope */
  subject_id: string;

  /** Human-readable label for display (e.g. "registration → success") */
  subject_label?: string;

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

  /** Slice keys: explicit families → N keys; broad/unfiltered → [''] */
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
// Cohort maturity epoch planning (new required logic)
// ============================================================

type ModeClause = 'window()' | 'cohort()';

const EPOCH_SUBJECT_ID_SEP = '::epoch:';
const GAP_SLICE_KEY = '__epoch_gap__';

function isoDateFromIsoDatetimeUTC(dt: string): string | null {
  const t = Date.parse(String(dt || ''));
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString().split('T')[0];
}

export function normaliseSliceKeyForMatching(sliceKey: string): string {
  const s = String(sliceKey || '').trim();
  if (!s) return '';
  // Strip args from window()/cohort() but preserve context/case dimensions.
  return s
    .replace(/(^|\.)((?:window|cohort))\([^)]*\)/g, (_m, p1, fn) => `${p1}${fn}()`)
    .replace(/^\./, '');
}

function normaliseSummarySliceKeyToFamily(sliceKey: string): string {
  const s = normaliseSliceKeyForMatching(sliceKey);
  if (!s) return '';
  const mode: ModeClause =
    s.includes('cohort()') ? 'cohort()'
    : s.includes('window()') ? 'window()'
    : (sliceKey.includes('cohort(') ? 'cohort()' : 'window()'); // fail-safe
  const dims = extractSliceDimensions(s);
  return dims ? `${dims}.${mode}` : mode;
}

function parseContextMap(dsl: string): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const parsed = parseConstraints(dsl || '');
    for (const c of parsed.context || []) {
      out.set(c.key, c.value);
    }
  } catch {
    // ignore parse failures (treat as no dims)
  }
  return out;
}

function contextKeysFromDsl(dsl: string): Set<string> {
  const keys = new Set<string>();
  try {
    const parsed = parseConstraints(dsl || '');
    for (const c of parsed.context || []) keys.add(c.key);
  } catch {
    // ignore
  }
  return keys;
}

type DaySummary = { retrievedAt: string; families: Set<string> };

export function chooseLatestRetrievalGroupPerDay(args: {
  summary: SnapshotRetrievalSummaryRow[];
  sweepFrom: string; // ISO date
  sweepTo: string;   // ISO date
}): Map<string, DaySummary> {
  const { summary, sweepFrom, sweepTo } = args;
  const byDay = new Map<string, Map<string, Set<string>>>();
  for (const row of Array.isArray(summary) ? summary : []) {
    const day = isoDateFromIsoDatetimeUTC(row.retrieved_at);
    if (!day) continue;
    if (day < sweepFrom || day > sweepTo) continue;
    const ra = String(row.retrieved_at || '');
    if (!byDay.has(day)) byDay.set(day, new Map());
    const byRa = byDay.get(day)!;
    if (!byRa.has(ra)) byRa.set(ra, new Set());
    const fam = normaliseSummarySliceKeyToFamily(String(row.slice_key || ''));
    if (fam) byRa.get(ra)!.add(fam);
  }

  const chosen = new Map<string, DaySummary>();
  for (const [day, groups] of byDay.entries()) {
    const ras = Array.from(groups.keys()).sort(); // ISO datetime -> lexical sort OK
    const latest = ras[ras.length - 1];
    chosen.set(day, { retrievedAt: latest, families: groups.get(latest) || new Set() });
  }
  return chosen;
}

function isSubsetContextMatch(args: { specified: Map<string, string>; candidate: Map<string, string> }): boolean {
  const { specified, candidate } = args;
  for (const [k, v] of specified.entries()) {
    if (candidate.get(k) !== v) return false;
  }
  return true;
}

function meceCompleteForDim(args: {
  slices: Array<{ sliceDSL?: string }>;
  dimKey: string;
  workspace?: { repository: string; branch: string };
}): boolean {
  const { slices, dimKey, workspace } = args;
  const values = new Set<string>();
  for (const s of slices) {
    const map = parseContextMap(String(s.sliceDSL || ''));
    const v = map.get(dimKey);
    if (v) values.add(v);
  }
  const windows = Array.from(values).map((v) => ({ sliceDSL: `context(${dimKey}:${v})` }));
  const mece = contextRegistry.detectMECEPartitionSync(windows, dimKey, workspace ? { workspace } : undefined);
  return !!(mece.isMECE && mece.isComplete && mece.canAggregate);
}

export function selectLeastAggregationSliceKeysForDay(args: {
  availableFamilies: Set<string>;
  querySliceFamily: string; // context/case dims only, no mode
  mode: ModeClause;
  pinnedContextKeys: Set<string>;
  workspace?: { repository: string; branch: string };
}): string[] | null {
  const { availableFamilies, querySliceFamily, mode, pinnedContextKeys, workspace } = args;

  const specified = parseContextMap(querySliceFamily);
  const specifiedKeys = new Set(specified.keys());

  type Candidate = { extraDims: string[]; families: string[] };
  const candidates: Candidate[] = [];

  // Enumerate candidates by dimension-set (keys present).
  const familyMeta = Array.from(availableFamilies).map((fam) => {
    const dims = extractSliceDimensions(fam);
    const ctxMap = parseContextMap(dims);
    const keys = Array.from(ctxMap.keys()).sort();
    const mode: ModeClause | null =
      String(fam).endsWith('cohort()') ? 'cohort()'
      : String(fam).endsWith('window()') ? 'window()'
      : null;
    return { fam, dims, ctxMap, keys };
  });

  // Restrict availability to the requested mode. Do NOT fall back across window/cohort modes.
  const modeFamilies = familyMeta.filter((m) => String(m.fam).endsWith(mode));

  for (const meta of modeFamilies) {
    if (!isSubsetContextMatch({ specified, candidate: meta.ctxMap })) continue;
    const extra = meta.keys.filter((k) => !specifiedKeys.has(k));
    // Only aggregate away dims that are explicitly in-scope (pinned).
    if (extra.some((k) => !pinnedContextKeys.has(k))) continue;

    // Candidate set = all families with exactly this key-set (dimension-set) and matching specified dims.
    const fams = modeFamilies
      .filter((m) => m.keys.join('|') === meta.keys.join('|'))
      .filter((m) => isSubsetContextMatch({ specified, candidate: m.ctxMap }))
      .map((m) => m.fam);

    candidates.push({ extraDims: extra, families: Array.from(new Set(fams)).sort() });
  }

  if (candidates.length === 0) return null;

  // Validate MECE for any extra dims; also validate combination completeness when >1.
  const eligible: Candidate[] = [];
  for (const c of candidates) {
    if (c.extraDims.length === 0) {
      eligible.push(c);
      continue;
    }
    const fakeSlices = c.families.map((f) => ({ sliceDSL: f }));
    const okPerDim = c.extraDims.every((d) => meceCompleteForDim({ slices: fakeSlices, dimKey: d, workspace }));
    if (!okPerDim) continue;
    if (c.extraDims.length > 1) {
      const combos = verifyAllCombinationsExist(fakeSlices as any, c.extraDims);
      if (!combos.complete) continue;
    }
    eligible.push(c);
  }

  if (eligible.length === 0) return null;

  // Least aggregation: minimise |E|, then minimise number of families.
  eligible.sort((a, b) => {
    if (a.extraDims.length !== b.extraDims.length) return a.extraDims.length - b.extraDims.length;
    if (a.families.length !== b.families.length) return a.families.length - b.families.length;
    return a.families.join('|').localeCompare(b.families.join('|'));
  });
  return eligible[0].families;
}

type EpochSegment = { from: string; to: string; sliceKeys: string[] };

function* iterateDaysInclusive(fromISO: string, toISO: string): Generator<string> {
  const start = new Date(`${fromISO}T00:00:00Z`);
  const end = new Date(`${toISO}T00:00:00Z`);
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    yield d.toISOString().split('T')[0];
  }
}

export function segmentSweepIntoEpochs(args: {
  sweepFrom: string;
  sweepTo: string;
  perDay: Map<string, string[] | null>; // day → selected sliceKeys, or null meaning "gap"
}): EpochSegment[] {
  const { sweepFrom, sweepTo, perDay } = args;
  const segments: EpochSegment[] = [];

  let cur: EpochSegment | null = null;
  const sig = (keys: string[] | null) => keys === null ? 'GAP' : `OK:${keys.slice().sort().join('|')}`;

  for (const day of iterateDaysInclusive(sweepFrom, sweepTo)) {
    const keys = perDay.get(day) ?? null;
    const keysSorted = keys === null ? null : keys.slice().sort();
    if (!cur) {
      cur = { from: day, to: day, sliceKeys: keysSorted === null ? [GAP_SLICE_KEY] : keysSorted };
      continue;
    }
    const curIsGap = cur.sliceKeys.length === 1 && cur.sliceKeys[0] === GAP_SLICE_KEY;
    const nextIsGap = keysSorted === null;
    const curSig = curIsGap ? 'GAP' : `OK:${cur.sliceKeys.slice().sort().join('|')}`;
    const nextSig = sig(keysSorted);
    if (curSig === nextSig) {
      cur.to = day;
    } else {
      segments.push(cur);
      cur = { from: day, to: day, sliceKeys: nextIsGap ? [GAP_SLICE_KEY] : keysSorted! };
    }
  }
  if (cur) segments.push(cur);
  return segments;
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
    // - sliceFamily encodes only the CONTEXT/CASE axis (e.g. "context(channel:google)").
    // - The temporal MODE (window vs cohort) is part of slice identity for snapshot reads.
    // - For slicePolicy=mece_fulfilment_allowed, uncontexted is represented as a BROAD read: [''].
    const modeClause: ModeClause = item.mode === 'cohort' ? 'cohort()' : 'window()';
    const sliceKeysDefault = (() => {
      if (item.sliceFamily) return [`${item.sliceFamily}.${modeClause}`];
      if (contract.slicePolicy === 'mece_fulfilment_allowed') return [''];
      return [modeClause];
    })();

    // Derive a human-readable label from the graph edge (from → to node IDs).
    // item.targetId is the edge UUID; look it up in the graph.
    let subjectLabel: string | undefined;
    const edge = graph.edges.find((e: any) => e.uuid === item.targetId);
    if (edge) {
      const fromNode = graph.nodes.find((n: any) => n.uuid === edge.from);
      const toNode = graph.nodes.find((n: any) => n.uuid === edge.to);
      if (fromNode && toNode) {
        subjectLabel = `${fromNode.id} → ${toNode.id}`;
      }
    }

    if (contract.readMode === 'cohort_maturity') {
      // Epoch planning: preflight retrieval summaries to choose a single regime per day,
      // then segment into sweep epochs.
      const sweepFrom = timeBounds.sweepFrom;
      const sweepTo = timeBounds.sweepTo;
      if (!sweepFrom || !sweepTo) {
        skipped.push({ subjectId: item.itemKey, reason: 'Missing sweep bounds for cohort_maturity' });
        continue;
      }

      // Pinned dims define which extra dims are in-scope for marginalisation.
      const pinnedKeys = contextKeysFromDsl(String((graph as any)?.dataInterestsDSL || ''));

      // CRITICAL:
      // Epoch selection uses synchronous MECE checks (detectMECEPartitionSync), which require
      // context definitions to be present in the in-memory cache. If contexts aren't cached,
      // MECE checks will conservatively fail ("unknown"), causing all days to become gaps.
      //
      // Therefore we must proactively cache all in-scope context definitions before selection.
      try {
        await contextRegistry.ensureContextsCached(Array.from(pinnedKeys), { workspace });
      } catch {
        // Fail-safe: if caching fails, selection will treat MECE as non-eligible and produce gaps.
        // This is safer than mixing regimes, and will surface as missing data.
      }

      let preflight: any = null;
      try {
        preflight = await querySnapshotRetrievals({
          param_id: paramId,
          core_hash: coreHash,
          slice_keys: [''], // broad: observe all slice families in the signature closure
          anchor_from: timeBounds.anchorFrom,
          anchor_to: timeBounds.anchorTo,
          include_equivalents: true,
          include_summary: true,
          limit: 2000,
        });
      } catch {
        preflight = null;
      }

      // Fail-safe: if preflight is unavailable, do NOT do a broad cohort maturity read.
      // Broad reads reintroduce mixed-regime summation. Instead, fall back to a single
      // explicit family selector (or uncontexted-only when query is uncontexted).
      if (!preflight || preflight.success !== true || !Array.isArray(preflight.summary)) {
        const fallbackSliceKeys = item.sliceFamily ? [`${item.sliceFamily}.${modeClause}`] : [modeClause];
        subjects.push({
          subject_id: item.itemKey,
          subject_label: subjectLabel,
          param_id: paramId,
          canonical_signature: item.querySignature,
          core_hash: coreHash,
          read_mode: contract.readMode,
          anchor_from: timeBounds.anchorFrom,
          anchor_to: timeBounds.anchorTo,
          ...(timeBounds.asAt ? { as_at: timeBounds.asAt } : {}),
          sweep_from: sweepFrom,
          sweep_to: sweepTo,
          slice_keys: fallbackSliceKeys,
          target: {
            targetId: item.targetId,
            ...(item.slot ? { slot: item.slot } : {}),
            ...(item.conditionalIndex !== undefined ? { conditionalIndex: item.conditionalIndex } : {}),
          },
        });
        continue;
      }

      const summary = preflight.summary;
      const chosenByDay = chooseLatestRetrievalGroupPerDay({ summary, sweepFrom, sweepTo });
      if (chosenByDay.size === 0) {
        // No observed retrieval groups in sweep window. Fall back to a single subject so the
        // backend can return a clean empty result (rather than forcing gap epochs).
        const fallbackSliceKeys = item.sliceFamily ? [`${item.sliceFamily}.${modeClause}`] : [modeClause];
        subjects.push({
          subject_id: item.itemKey,
          subject_label: subjectLabel,
          param_id: paramId,
          canonical_signature: item.querySignature,
          core_hash: coreHash,
          read_mode: contract.readMode,
          anchor_from: timeBounds.anchorFrom,
          anchor_to: timeBounds.anchorTo,
          ...(timeBounds.asAt ? { as_at: timeBounds.asAt } : {}),
          sweep_from: sweepFrom,
          sweep_to: sweepTo,
          slice_keys: fallbackSliceKeys,
          target: {
            targetId: item.targetId,
            ...(item.slot ? { slot: item.slot } : {}),
            ...(item.conditionalIndex !== undefined ? { conditionalIndex: item.conditionalIndex } : {}),
          },
        });
        continue;
      }

      // Per-day regime selection with carry-forward on non-retrieval days.
      const perDay = new Map<string, string[] | null>();
      let last: string[] | null = null;
      for (const day of iterateDaysInclusive(sweepFrom, sweepTo)) {
        const obs = chosenByDay.get(day);
        if (!obs) {
          perDay.set(day, last);
          continue;
        }
        const selected = selectLeastAggregationSliceKeysForDay({
          availableFamilies: obs.families,
          querySliceFamily: item.sliceFamily,
          mode: modeClause,
          pinnedContextKeys: pinnedKeys,
          workspace,
        });
        // If we can't resolve safely, treat as a gap (missing data).
        last = selected;
        perDay.set(day, selected);
      }

      const epochs = segmentSweepIntoEpochs({ sweepFrom, sweepTo, perDay });
      epochs.forEach((ep, i) => {
        subjects.push({
          subject_id: `${item.itemKey}${EPOCH_SUBJECT_ID_SEP}${i}`,
          subject_label: subjectLabel,
          param_id: paramId,
          canonical_signature: item.querySignature,
          core_hash: coreHash,
          read_mode: contract.readMode,
          anchor_from: timeBounds.anchorFrom,
          anchor_to: timeBounds.anchorTo,
          ...(timeBounds.asAt ? { as_at: timeBounds.asAt } : {}),
          sweep_from: ep.from,
          sweep_to: ep.to,
          slice_keys: ep.sliceKeys,
          target: {
            targetId: item.targetId,
            ...(item.slot ? { slot: item.slot } : {}),
            ...(item.conditionalIndex !== undefined ? { conditionalIndex: item.conditionalIndex } : {}),
          },
        });
      });
      continue;
    }

    subjects.push({
      subject_id: item.itemKey,
      subject_label: subjectLabel,
      param_id: paramId,
      canonical_signature: item.querySignature,
      core_hash: coreHash,
      read_mode: contract.readMode,
      anchor_from: timeBounds.anchorFrom,
      anchor_to: timeBounds.anchorTo,
      ...(timeBounds.asAt ? { as_at: timeBounds.asAt } : {}),
      slice_keys: sliceKeysDefault,
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
