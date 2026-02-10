import type { GraphData } from '../types';
import { sessionLogService } from './sessionLogService';
import { retrieveAllSlicesPlannerService } from './retrieveAllSlicesPlannerService';
import { fetchDataService, type FetchItem, persistGraphMasteredLatencyToParameterFiles } from './fetchDataService';
import { dataOperationsService } from './dataOperationsService';
import { fileRegistry } from '../contexts/TabContext';
import { runParityComparison, FORECASTING_PARALLEL_RUN } from './lagRecomputeService';

export type LagHorizonsRecomputeMode = 'current' | 'global';

function buildGlobalHorizonDSL(): string {
  // Intentionally uncontexted and broad.
  //
  // Goal: "use as much as is in the files as possible" rather than being constrained
  // by the user's current/pinned DSL. A very wide relative cohort range:
  // - avoids filtering out available cohort slices
  // - still allows the LAG topo pass to interpret this as cohort-mode
  //
  // Note: horizons are still recency-weighted per forecasting settings.
  // NOTE: Must include an end bound so parseConstraints recognises it as explicit cohort() mode
  // (lagSliceSource='cohort'), otherwise the Stage‑2 topo pass may treat this as "none" and fall back
  // to defaults (t95=DEFAULT_T95_DAYS, completeness=0).
  return 'cohort(-3650d:0d)';
}

function buildTopoItemsFromGraph(g: GraphData): FetchItem[] {
  const targets = retrieveAllSlicesPlannerService.collectTargets(g as any);
  return targets
    .filter((t: any) => t?.type === 'parameter')
    .map((t: any) => ({
      id:
        typeof t.conditionalIndex === 'number'
          ? `param-${t.objectId}-conditional_p[${t.conditionalIndex}]-${t.targetId}`
          : `param-${t.objectId}-${t.paramSlot ?? 'p'}-${t.targetId}`,
      type: 'parameter' as const,
      name: t.name,
      objectId: t.objectId,
      targetId: t.targetId,
      paramSlot: t.paramSlot,
      conditionalIndex: t.conditionalIndex,
    }));
}

async function runTopoPassFromFiles(args: {
  getGraph: () => GraphData | null;
  setGraph: (g: GraphData | null) => void;
  dsl: string;
  parentLogId?: string;
  suppressMissingDataToast?: boolean;
}): Promise<void> {
  const g0 = args.getGraph();
  if (!g0) return;

  // IMPORTANT:
  // Recompute horizons from file-backed data, NOT from the current graph's existing horizons.
  // If we leave existing edge.p.latency.t95/path_t95 in place, the stats engine can treat t95 as
  // an "authoritative constraint" and fail to move horizons even when data changes.
  //
  // We therefore:
  // - hydrate override flags from parameter files onto the graph (so we can respect locks)
  // - clear existing t95/path_t95 for edges that are NOT overridden
  const g: any = structuredClone(g0);
  const edges: any[] = Array.isArray(g.edges) ? g.edges : [];
  for (const e of edges) {
    const paramId = e?.p?.id;
    if (!paramId) continue;
    const pf: any = fileRegistry.getFile(`parameter-${paramId}`)?.data || null;
    const lat = pf?.latency || {};
    if (!e.p) e.p = {};
    if (!e.p.latency) e.p.latency = {};
    // Pull override flags from file into graph (explicit recompute workflow).
    e.p.latency.t95_overridden = lat.t95_overridden === true;
    e.p.latency.path_t95_overridden = lat.path_t95_overridden === true;

    // Clear existing horizons unless locked.
    if (e.p.latency.t95_overridden !== true) delete e.p.latency.t95;
    if (e.p.latency.path_t95_overridden !== true) delete e.p.latency.path_t95;
  }

  // Commit the normalised graph into state before recompute.
  args.setGraph(g);

  const items = buildTopoItemsFromGraph(g as any);
  if (items.length === 0) return;

  await fetchDataService.fetchItems(
    items,
    {
      mode: 'from-file',
      parentLogId: args.parentLogId,
      suppressBatchToast: true,
      skipStage2: false,
      writeLagHorizonsToGraph: true,
      suppressMissingDataToast: args.suppressMissingDataToast === true,
      // CRITICAL (anti-floatiness / recompute semantics):
      // During explicit horizon recompute, we must load *slice values* from files but NOT
      // copy file metadata (including latency.t95/path_t95) back onto the graph.
      // Otherwise, file horizons become "authoritative" and the topo pass cannot move them.
      copyOptions: {
        includeValues: true,
        includeMetadata: false,
        permissionsMode: 'do_not_copy',
      },
    } as any,
    (args.getGraph() as any) || (g as any),
    (next: any) => args.setGraph(next),
    args.dsl,
    () => args.getGraph() as any
  );
}

async function persistHorizonsFromGraph(args: {
  getGraph: () => GraphData | null;
  setGraph: (g: GraphData | null) => void;
  parentLogId?: string;
}): Promise<void> {
  const g = args.getGraph();
  if (!g) return;
  const edgeIds: string[] = (g as any)?.edges?.map((e: any) => e?.uuid || e?.id || `${e?.from}->${e?.to}`) || [];
  if (edgeIds.length === 0) return;

  await persistGraphMasteredLatencyToParameterFiles({
    graph: g as any,
    setGraph: (next: any) => args.setGraph(next),
    edgeIds,
  });

  if (args.parentLogId) {
    sessionLogService.addChild(args.parentLogId, 'success', 'LAG_HORIZONS_PERSISTED', 'Persisted horizons (t95/path_t95) to parameter files (respecting overrides)');
  }
}

async function setAllHorizonOverrideFlags(args: {
  getGraph: () => GraphData | null;
  setGraph: (g: GraphData | null) => void;
  overridden: boolean;
  parentLogId?: string;
}): Promise<void> {
  const g = args.getGraph();
  if (!g) return;

  const next: any = structuredClone(g);
  const edges: any[] = Array.isArray(next.edges) ? next.edges : [];

  // Update graph flags immediately (so subsequent topo passes in-session respect them).
  for (const e of edges) {
    if (!e?.p) e.p = {};
    if (!e.p.latency) e.p.latency = {};
    e.p.latency.t95_overridden = args.overridden;
    e.p.latency.path_t95_overridden = args.overridden;
  }
  args.setGraph(next);

  // Persist flags to parameter files (metadata-only, force copy).
  // This makes automation opt-in/out durable across reloads and devices.
  for (const e of edges) {
    const paramId = e?.p?.id;
    const edgeId = e?.uuid || e?.id || `${e?.from}->${e?.to}`;
    if (!paramId || !edgeId) continue;

    await dataOperationsService.putParameterToFile({
      paramId,
      edgeId,
      graph: args.getGraph() as any,
      setGraph: (gg: any) => args.setGraph(gg),
      copyOptions: {
        includeValues: false,
        includeMetadata: true,
        // Force-copy permissions + metadata (explicit user action).
        permissionsMode: 'copy_all',
      },
    });
  }

  if (args.parentLogId) {
    sessionLogService.addChild(
      args.parentLogId,
      'success',
      args.overridden ? 'LAG_HORIZONS_OVERRIDES_SET' : 'LAG_HORIZONS_OVERRIDES_CLEARED',
      args.overridden ? 'Set all horizon override flags (t95/path_t95)' : 'Cleared all horizon override flags (t95/path_t95)'
    );
  }
}

class LagHorizonsService {
  async recomputeHorizons(args: {
    mode: LagHorizonsRecomputeMode;
    getGraph: () => GraphData | null;
    setGraph: (g: GraphData | null) => void;
    currentDsl?: string;
    reason: string;
  }): Promise<void> {
    const mode = args.mode;
    const dsl =
      mode === 'global'
        ? buildGlobalHorizonDSL()
        : (typeof args.currentDsl === 'string' && args.currentDsl.trim() ? args.currentDsl.trim() : '');
    if (!dsl) {
      // Never silently no-op: emit a session log so the user can see *why* nothing happened.
      const opId = sessionLogService.startOperation(
        'warning',
        'data-fetch',
        'LAG_HORIZONS_RECOMPUTE_SKIPPED',
        `Recompute LAG horizons (${mode}) skipped (no current DSL)`,
        { mode, reason: args.reason }
      );
      sessionLogService.endOperation(opId, 'warning', 'Skipped: no current DSL available');
      return;
    }

    const opId = sessionLogService.startOperation(
      'info',
      'data-fetch',
      'LAG_HORIZONS_RECOMPUTE',
      `Recompute LAG horizons (${mode})`,
      { mode, dsl, reason: args.reason }
    );
    try {
      await runTopoPassFromFiles({
        getGraph: args.getGraph,
        setGraph: args.setGraph,
        dsl,
        parentLogId: opId,
        // Global recompute intentionally requests a very wide window; missing history is expected and not actionable.
        suppressMissingDataToast: mode === 'global',
      });
      await persistHorizonsFromGraph({
        getGraph: args.getGraph,
        setGraph: args.setGraph,
        parentLogId: opId,
      });

      // Parallel-run parity comparison (gated by FORECASTING_PARALLEL_RUN flag).
      if (FORECASTING_PARALLEL_RUN) {
        try {
          const g = args.getGraph();
          if (g) {
            // Get workspace from the first parameter file's source in fileRegistry.
            const firstParamEdge = (g as any)?.edges?.find((e: any) => e?.p?.id);
            const firstParamFileId = firstParamEdge?.p?.id ? `parameter-${firstParamEdge.p.id}` : undefined;
            const source = firstParamFileId ? fileRegistry.getFile(firstParamFileId)?.source : undefined;
            const workspace = source?.repository && source?.branch
              ? { repository: source.repository as string, branch: source.branch as string }
              : undefined;
            if (workspace) {
              await runParityComparison({ graph: g, workspace });
            }
          }
        } catch (e: any) {
          console.warn('[lagHorizonsService] Parity comparison failed (non-fatal):', e?.message || e);
        }
      }

      sessionLogService.endOperation(opId, 'success', 'Recomputed + persisted LAG horizons');
    } catch (e: any) {
      sessionLogService.endOperation(opId, 'error', e?.message || String(e));
      throw e;
    }
  }

  async setAllHorizonOverrides(args: {
    getGraph: () => GraphData | null;
    setGraph: (g: GraphData | null) => void;
    overridden: boolean;
    reason: string;
  }): Promise<void> {
    const opId = sessionLogService.startOperation(
      'info',
      'data-update',
      args.overridden ? 'LAG_HORIZONS_SET_OVERRIDES' : 'LAG_HORIZONS_CLEAR_OVERRIDES',
      args.overridden ? 'Set all horizon overrides' : 'Remove all horizon overrides',
      { overridden: args.overridden, reason: args.reason }
    );
    try {
      await setAllHorizonOverrideFlags({
        getGraph: args.getGraph,
        setGraph: args.setGraph,
        overridden: args.overridden,
        parentLogId: opId,
      });
      sessionLogService.endOperation(opId, 'success', args.overridden ? 'Overrides set' : 'Overrides cleared');
    } catch (e: any) {
      sessionLogService.endOperation(opId, 'error', e?.message || String(e));
      throw e;
    }
  }
}

export const lagHorizonsService = new LagHorizonsService();


