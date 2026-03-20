/**
 * useDataDepthScores — async hook that orchestrates the three data sources
 * (fetch plan, snapshot coverage, edge n) and returns per-edge depth scores.
 *
 * Triggers computation when the data-depth overlay activates.
 * Caches results keyed on (graphRevision, dsl).
 *
 * Design doc: docs/current/data-depth-v2-composite-design.md
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { computeDataDepthScores, type DataDepthScore } from '../services/dataDepthService';
import { buildFetchPlanProduction } from '../services/fetchPlanBuilderService';
import type { FetchPlan, FetchPlanItem } from '../services/fetchPlanTypes';
import { explodeDSL } from '../lib/dslExplosion';
import { getSnapshotRetrievalsForEdge } from '../services/snapshotRetrievalsService';
import { devDiagnosticService, type DataDepthCapture } from '../services/devDiagnosticService';
import { parseConstraints } from '../lib/queryDSL';
import { resolveRelativeDate, formatDateUK } from '../lib/dateFormat';
import type { Graph } from '../types';

export interface UseDataDepthScoresResult {
  scores: Map<string, DataDepthScore> | null;
  loading: boolean;
}

/**
 * Extract the date window from a DSL string (same logic as windowFetchPlannerService).
 * Returns null if no window/cohort found.
 */
function extractWindowFromDSL(dsl: string): { start: string; end: string } | null {
  try {
    const constraints = parseConstraints(dsl);
    if (constraints.cohort?.start) {
      const start = resolveRelativeDate(constraints.cohort.start);
      const end = constraints.cohort.end
        ? resolveRelativeDate(constraints.cohort.end)
        : formatDateUK(new Date());
      return { start, end };
    }
    if (constraints.window?.start) {
      const start = resolveRelativeDate(constraints.window.start);
      const end = constraints.window.end
        ? resolveRelativeDate(constraints.window.end)
        : formatDateUK(new Date());
      return { start, end };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Generate all UK-format date strings in a range (inclusive).
 */
function generateAllDates(start: string, end: string): string[] {
  // parseUKDate from dateFormat would be ideal, but we can use the Date constructor
  // with resolveRelativeDate output which is already UK format.
  // We need to parse UK dates — use a simple approach.
  const parseUK = (s: string): Date => {
    // UK format: d-MMM-yy or d-MMM-yyyy
    const months: Record<string, number> = {
      Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
      Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
    };
    const parts = s.split('-');
    if (parts.length !== 3) return new Date(s);
    const day = parseInt(parts[0], 10);
    const month = months[parts[1]];
    let year = parseInt(parts[2], 10);
    if (year < 100) year += 2000;
    return new Date(Date.UTC(year, month, day));
  };

  const dates: string[] = [];
  const startDate = parseUK(start);
  const endDate = parseUK(end);
  const current = new Date(startDate);
  while (current <= endDate) {
    dates.push(formatDateUK(current));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

/**
 * Normalise an ISO date (YYYY-MM-DD) to UK format (d-MMM-yy) for comparison
 * with fetch plan dates.
 */
function isoToUK(iso: string): string {
  // Handle ISO datetime or date-only
  const dateStr = iso.includes('T') ? iso.split('T')[0] : iso;
  const parts = dateStr.split('-');
  if (parts.length !== 3) return iso;
  const d = new Date(Date.UTC(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2])));
  return formatDateUK(d);
}

/**
 * Build a diagnostic capture and send it to devDiagnosticService.
 * Called after each data depth computation for audit via marks.
 */
function captureForDiagnostics(
  g: Graph,
  d: string | null,
  mode: 'full' | 'n-only',
  window: { start: string; end: string } | null,
  allDatesInWindow: string[],
  scores: Map<string, DataDepthScore>,
  snapshotDaysByEdge: Map<string, string[]>,
  plan: FetchPlan | null,
): void {
  try {
    // Compute nMedian for the capture
    const nValues = (g.edges || []).map((e: any) => e.p?.evidence?.n ?? 0).filter((n: number) => n > 0);
    const sorted = [...nValues].sort((a, b) => a - b);
    const nMedian = sorted.length === 0 ? 0
      : sorted.length % 2 === 0
        ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
        : sorted[Math.floor(sorted.length / 2)];

    // Build histogram of composite scores in 0.1-width buckets
    const histogram: Record<string, number> = {};
    for (let i = 0; i < 10; i++) {
      const lo = (i * 0.1).toFixed(1);
      const hi = ((i + 1) * 0.1).toFixed(1);
      histogram[`${lo}-${hi}`] = 0;
    }
    for (const [, score] of scores) {
      const bucket = Math.min(Math.floor(score.depth * 10), 9);
      const lo = (bucket * 0.1).toFixed(1);
      const hi = ((bucket + 1) * 0.1).toFixed(1);
      histogram[`${lo}-${hi}`]++;
    }

    // Node lookup for from/to labels
    const nodeMap = new Map<string, string>();
    for (const node of (g as any).nodes || []) {
      if (node.uuid) nodeMap.set(node.uuid, node.id || node.uuid);
      if (node.id) nodeMap.set(node.id, node.id);
    }

    // Index plan items by edge
    const planItemsByEdge = new Map<string, number>();
    if (plan) {
      for (const item of plan.items) {
        if (item.type !== 'parameter') continue;
        planItemsByEdge.set(item.targetId, (planItemsByEdge.get(item.targetId) ?? 0) + 1);
      }
    }

    // Date sample: first 5 + last 5
    const dateSample = allDatesInWindow.length <= 10
      ? allDatesInWindow
      : [...allDatesInWindow.slice(0, 5), '...', ...allDatesInWindow.slice(-5)];

    const edges: DataDepthCapture['edges'] = [];
    for (const edge of (g.edges || [])) {
      const edgeId = edge.uuid || edge.id || '';
      const score = scores.get(edgeId);
      if (!score) continue;
      const snapDays = snapshotDaysByEdge.get(edgeId) ?? [];
      // Which snapshot days actually intersect with the window? (for audit)
      const windowSet = new Set(allDatesInWindow);
      const snapshotDaysInWindow = snapDays.filter(d => windowSet.has(d));
      edges.push({
        edgeId,
        fromNode: nodeMap.get((edge as any).from) || (edge as any).from || '?',
        toNode: nodeMap.get((edge as any).to) || (edge as any).to || '?',
        n: edge.p?.evidence?.n ?? 0,
        k: edge.p?.evidence?.k,
        f1: score.f1,
        f2: score.f2,
        f3: score.f3,
        depth: score.depth,
        planItemCount: planItemsByEdge.get(edgeId) ?? 0,
        snapshotDayCount: snapDays.length,
        snapshotDaysSample: snapDays.slice(0, 5),
        snapshotDaysInWindow,
        sliceBreakdown: score.sliceBreakdown.map(s => ({
          label: s.label,
          coverage: s.coverage,
          coveredDays: s.coveredDays,
          totalDays: s.totalDays,
        })),
      });
    }

    // Sort edges by depth ascending (worst first) for quick scanning
    edges.sort((a, b) => a.depth - b.depth);

    const capture: DataDepthCapture = {
      ts: Date.now(),
      dsl: d,
      mode,
      window,
      allDatesInWindowCount: allDatesInWindow.length,
      allDatesInWindowSample: dateSample,
      nMedian,
      edgeCount: edges.length,
      edges,
      histogram,
    };

    devDiagnosticService.captureDataDepthState(capture);
  } catch (err) {
    console.warn('[useDataDepthScores] diagnostic capture failed:', err);
  }
}

export function useDataDepthScores(
  graph: Graph | null | undefined,
  dsl: string | null | undefined,
  _active?: boolean,
  workspace?: { repository: string; branch: string },
): UseDataDepthScoresResult {
  const [scores, setScores] = useState<Map<string, DataDepthScore> | null>(null);
  const [loading, setLoading] = useState(false);

  // Gate: wait for tab context init (files loaded from IDB into FileRegistry).
  // Without this, fetch plan + snapshot queries fire before data is ready on F5.
  const [bootReady, setBootReady] = useState(() => {
    try { return !!(window as any).__dagnetTabContextInitDone; } catch { return false; }
  });
  useEffect(() => {
    if (bootReady) return;
    if ((window as any).__dagnetTabContextInitDone) {
      setBootReady(true);
      return;
    }
    const onReady = () => setBootReady(true);
    window.addEventListener('dagnet:tabContextInitDone', onReady);
    return () => window.removeEventListener('dagnet:tabContextInitDone', onReady);
  }, [bootReady]);

  // Cache key to avoid redundant recomputation
  const cacheKeyRef = useRef<string>('');
  const abortRef = useRef<AbortController | null>(null);

  const compute = useCallback(async (g: Graph, d: string | null, ws?: { repository: string; branch: string }) => {
    // Abort any in-flight computation
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;

    setLoading(true);

    try {
      // 1. Extract window from DSL — if no DSL or no window, fall back to n-only scores
      const window = d ? extractWindowFromDSL(d) : null;
      if (!window) {
        // Graceful degradation: score edges by n-only (f₁=1, f₂=1, f₃=hyperbolic)
        const nOnlyScores = computeDataDepthScores({
          plan: { version: 1, createdAt: new Date().toISOString(), referenceNow: new Date().toISOString(), dsl: d || '', items: [] },
          snapshotDaysByEdge: new Map(),
          edges: g.edges || [],
          allDatesInWindow: [],
        });
        // No DSL → f₁ and f₂ are not applicable.
        // Mark them as N/A (1) and set depth = f₃ directly (pure n-adequacy).
        for (const [, score] of nOnlyScores) {
          score.f1 = 1;
          score.f2 = 1;
          score.depth = score.f3;
        }
        if (!abort.signal.aborted) {
          captureForDiagnostics(g, d, 'n-only', null, [], nOnlyScores, new Map(), null);
          setScores(nOnlyScores);
          setLoading(false);
        }
        return;
      }

      // 2. Generate all dates in the window (UK format)
      const allDatesInWindow = generateAllDates(window.start, window.end);
      if (allDatesInWindow.length === 0) {
        setScores(new Map());
        setLoading(false);
        return;
      }

      // 3. Explode the pinned DSL into atomic slices, build a fetch plan for each,
      //    and merge all plan items into a single aggregated plan.
      const atomicSlices = await explodeDSL(d!);
      if (abort.signal.aborted) return;

      const allPlanItems: FetchPlanItem[] = [];
      for (const slice of atomicSlices) {
        if (abort.signal.aborted) return;
        const sliceWindow = extractWindowFromDSL(slice) ?? window;
        try {
          const { plan: slicePlan } = await buildFetchPlanProduction(g, slice, sliceWindow);
          allPlanItems.push(...slicePlan.items);
        } catch {
          // Best-effort: skip slices that fail to plan
        }
      }
      // If explosion produced no slices (e.g. pure relative DSL with no context),
      // fall back to building a single plan from the raw DSL.
      if (allPlanItems.length === 0 && atomicSlices.length === 0) {
        try {
          const { plan: fallbackPlan } = await buildFetchPlanProduction(g, d!, window);
          allPlanItems.push(...fallbackPlan.items);
        } catch { /* best-effort */ }
      }
      const plan: FetchPlan = {
        version: 1,
        createdAt: new Date().toISOString(),
        referenceNow: new Date().toISOString(),
        dsl: d!,
        items: allPlanItems,
      };

      if (abort.signal.aborted) return;

      // 4. Query snapshot coverage per connected edge (parallel)
      const connectedEdges = (g.edges || []).filter(
        (e: any) => e?.p?.id || e?.p?.parameter_id,
      );

      const snapshotDaysByEdge = new Map<string, string[]>();

      // Fire all snapshot queries in parallel, with best-effort error handling
      const snapshotResults = await Promise.allSettled(
        connectedEdges.map(async (edge: any) => {
          const edgeId = edge.uuid || edge.id;
          try {
            const result = await getSnapshotRetrievalsForEdge({
              graph: g,
              edgeId,
              effectiveDSL: d!,
              workspace: ws,
              limit: 2000, // Data depth needs all retrieval timestamps to cover the full window
            });
            if (result.success && result.retrieved_days.length > 0) {
              // retrieved_days = unique ISO dates derived from retrieved_at (snapshot capture dates).
              // Convert to UK format for comparison with window dates.
              return { edgeId, days: result.retrieved_days.map(isoToUK) };
            }
            return { edgeId, days: [] as string[] };
          } catch {
            return { edgeId, days: [] as string[] };
          }
        }),
      );

      if (abort.signal.aborted) return;

      for (const result of snapshotResults) {
        if (result.status === 'fulfilled') {
          snapshotDaysByEdge.set(result.value.edgeId, result.value.days);
        }
      }

      // 5. Compute composite scores
      const computed = computeDataDepthScores({
        plan,
        snapshotDaysByEdge,
        edges: g.edges || [],
        allDatesInWindow,
      });

      if (abort.signal.aborted) return;

      captureForDiagnostics(g, d, 'full', window, allDatesInWindow, computed, snapshotDaysByEdge, plan);
      setScores(computed);
    } catch (err) {
      if (!abort.signal.aborted) {
        console.warn('[useDataDepthScores] computation failed:', err);
        setScores(new Map());
      }
    } finally {
      if (!abort.signal.aborted) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!graph) return;

    // Gate: wait for boot (FileRegistry populated) + graph structurally ready
    // + at least one edge has evidence data (proves param files are synced to graph).
    if (!bootReady) return;
    const graphReady = Array.isArray(graph.nodes) && Array.isArray(graph.edges) && graph.edges.length > 0;
    if (!graphReady) return;
    const hasEvidenceData = graph.edges.some((e: any) => (e.p?.evidence?.n ?? 0) > 0);
    if (!hasEvidenceData) return;

    // Simple cache key from DSL + edge count + first edge evidence.n
    // (graphRevision isn't directly accessible here, so approximate)
    // dsl may be null/undefined — n-only degradation handled by compute()
    const edgeCount = graph.edges.length;
    const firstN = graph.edges[0]?.p?.evidence?.n ?? 0;
    const key = `${dsl ?? '(none)'}|${edgeCount}|${firstN}`;

    if (key === cacheKeyRef.current && scores != null) {
      return; // Already computed for this state
    }

    cacheKeyRef.current = key;
    compute(graph, dsl ?? null, workspace);

    return () => {
      abortRef.current?.abort();
    };
  }, [graph, dsl, compute, scores, bootReady, workspace]);

  return { scores, loading };
}
