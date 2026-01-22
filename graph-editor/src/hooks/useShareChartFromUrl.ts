import { useCallback, useEffect, useMemo, useRef } from 'react';
import toast from 'react-hot-toast';

import { useShareModeOptional } from '../contexts/ShareModeContext';
import { useScenariosContextOptional } from '../contexts/ScenariosContext';
import { useTabContext } from '../contexts/TabContext';
import { decodeSharePayloadFromUrl, stableShortHash, type SharePayloadV1 } from '../lib/sharePayload';
import { chartOperationsService } from '../services/chartOperationsService';
import { graphComputeClient } from '../lib/graphComputeClient';
import { buildGraphForAnalysisLayer } from '../services/CompositionService';
import { fileRegistry } from '../contexts/TabContext';
import { formatDateUK } from '../lib/dateFormat';
import { db } from '../db/appDatabase';
import { waitForLiveShareGraphDeps } from '../services/liveShareHydrationService';
import { sessionLogService } from '../services/sessionLogService';
import { useGraphStoreOptional } from '../contexts/GraphStoreContext';
import { fetchDataService } from '../services/fetchDataService';
import { fetchOrchestratorService } from '../services/fetchOrchestratorService';

/**
 * Phase 3: Live chart share boot + refresh recompute pipeline.
 *
 * This hook MUST run inside ScenariosProvider (so it can create/regenerate live scenarios).
 * GraphEditor mounts it in the same place URLScenariosProcessor lives.
 */
export function useShareChartFromUrl(args: { fileId: string; tabId?: string }) {
  const { fileId, tabId } = args;
  const shareMode = useShareModeOptional();
  const scenariosContext = useScenariosContextOptional();
  const { operations, tabs } = useTabContext();
  const graphStore = useGraphStoreOptional();

  const payload = useMemo(() => decodeSharePayloadFromUrl(), []);
  const chartPayload = useMemo(
    () => (payload && payload.target === 'chart' ? payload : null),
    [payload]
  );

  const isEligible =
    Boolean(chartPayload) &&
    Boolean(shareMode?.isLiveMode) &&
    Boolean(shareMode?.identity.repo && shareMode?.identity.branch && shareMode?.identity.graph);

  // Dev-only introspection for Playwright/debugging.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    try {
      const o = (window as any).__dagnetShareChartBootstrapper;
      if (!o) return;
      o.hook = {
        isEligible,
        hasPayload: Boolean(payload),
        payloadTarget: (payload as any)?.target,
        shareMode: shareMode
          ? { isLiveMode: shareMode.isLiveMode, identity: shareMode.identity }
          : null,
        hasScenariosContext: Boolean(scenariosContext),
        scenariosReady: Boolean((scenariosContext as any)?.scenariosReady),
      };
    } catch {
      // ignore
    }
  }, [isEligible, payload, shareMode, scenariosContext]);

  const chartFileId = useMemo(() => {
    if (!chartPayload) return null;
    return `chart-share-${stableShortHash(JSON.stringify(chartPayload))}`;
  }, [chartPayload]);

  const processedRef = useRef(false);

  const openCachedChartIfPresent = useCallback(async () => {
    if (!chartFileId) return false;
    // If already open, don't spam tabs.
    const alreadyOpen = tabs.some(t => t.fileId === chartFileId);
    if (alreadyOpen) return true;

    const restored = await fileRegistry.restoreFile(chartFileId);
    const hasData = Boolean((restored as any)?.data?.payload?.analysis_result);
    if (!hasData) return false;

    await chartOperationsService.openExistingChartTab({
      fileId: chartFileId,
      title: chartPayload?.chart?.title || 'Chart',
    });
    return true;
  }, [chartFileId, tabs, chartPayload]);

  const ensureScenarios = useCallback(async (): Promise<Array<{ idx: number; id: string; dsl: string; scenario?: any }>> => {
    if (!scenariosContext || !chartPayload) return [];
    const items = chartPayload.scenarios?.items || [];

    const existing = Array.isArray(scenariosContext.scenarios) ? scenariosContext.scenarios : [];
    const usedScenarioIds = new Set<string>();

    const created: Array<{ idx: number; id: string; dsl: string; scenario?: any }> = [];
    for (let idx = 0; idx < items.length; idx++) {
      const item = items[idx];
      const dsl = item?.dsl;
      if (!dsl || !dsl.trim()) continue;

      const wantName = typeof item?.name === 'string' ? item.name : undefined;
      const wantColour = typeof item?.colour === 'string' ? item.colour : undefined;
      const match = existing.find(s => {
        if (!s?.id || usedScenarioIds.has(s.id)) return false;
        if ((s as any)?.meta?.queryDSL !== dsl) return false;
        if (wantName && s?.name !== wantName) return false;
        if (wantColour && s?.colour !== wantColour) return false;
        return true;
      });
      if (match) {
        usedScenarioIds.add(match.id);
        created.push({ idx, id: match.id, dsl, scenario: match });
        continue;
      }

      const idOverride = typeof (item as any)?.id === 'string' ? String((item as any).id) : undefined;
      const scenario = await scenariosContext.createLiveScenario(dsl, wantName, tabId, wantColour, idOverride);
      usedScenarioIds.add(scenario.id);
      created.push({ idx, id: scenario.id, dsl, scenario });
    }

    // Best-effort: persist immediately for the same reason as bundle boot.
    // Chart shares may open/mount chart UI before ScenariosContext's save effect flushes.
    try {
      const toPersist = created
        .map(c => c.scenario)
        .filter(Boolean)
        .map((s: any) => ({ ...s, fileId }));
      if (toPersist.length > 0) {
        await db.scenarios.bulkPut(toPersist as any);
      }
    } catch {
      // best-effort
    }

    return created;
  }, [chartPayload, scenariosContext, tabId]);

  const applyScenarioViewState = useCallback(
    async (created: Array<{ idx: number; id: string; dsl: string }>) => {
    if (!tabId || !chartPayload) return;
    const items = chartPayload.scenarios?.items || [];
    const hideCurrent = Boolean(chartPayload.scenarios?.hide_current);

      const createdByIdx = new Map<number, string>(created.map(c => [c.idx, c.id]));
      const orderedScenarioIds = items
        .map((_i, idx) => createdByIdx.get(idx))
        .filter((id): id is string => Boolean(id));

      // IMPORTANT: analysis + scenario view state require at least one scenario.
      // If hide_current is true but we have no scenario items (or mapping failed), fall back to Current.
      const visible = (() => {
        const base = hideCurrent ? [...orderedScenarioIds] : ['current', ...orderedScenarioIds];
        return base.length > 0 ? base : ['current'];
      })();
      await operations.setVisibleScenarios(tabId, visible);

      for (let idx = 0; idx < items.length; idx++) {
        const item = items[idx];
        const id = createdByIdx.get(idx);
        if (!id) continue;
        const mode = item.visibility_mode || 'f+e';
        await operations.setScenarioVisibilityMode(tabId, id, mode);
      }
    },
    [chartPayload, tabId, operations]
  );

  const hydrateCurrentFromFilesForShare = useCallback(
    async (args: { currentDslFromPayload?: string | null; parentLogId?: string }) => {
      const { currentDslFromPayload, parentLogId } = args;
      try {
        const currentDsl =
          (typeof currentDslFromPayload === 'string' && currentDslFromPayload.trim())
            ? currentDslFromPayload.trim()
            : (typeof (scenariosContext?.graph as any)?.currentQueryDSL === 'string'
                ? String((scenariosContext?.graph as any).currentQueryDSL)
                : '');

        if (!currentDsl || !currentDsl.trim()) {
          if (parentLogId) {
            sessionLogService.addChild(parentLogId, 'warning', 'LIVE_SHARE_CURRENT_NO_DSL', 'Cannot hydrate Current: missing current DSL');
          }
          return;
        }

        if (!graphStore) {
          if (parentLogId) {
            sessionLogService.addChild(parentLogId, 'warning', 'LIVE_SHARE_CURRENT_NO_GRAPHSTORE', 'Cannot hydrate Current: graphStore not available');
          }
          return;
        }

        const g0 = graphStore.getState().graph as any;
        if (!g0) {
          if (parentLogId) {
            sessionLogService.addChild(parentLogId, 'warning', 'LIVE_SHARE_CURRENT_NO_GRAPH', 'Cannot hydrate Current: graph is not available yet');
          }
          return;
        }

        if (parentLogId) {
          sessionLogService.addChild(parentLogId, 'info', 'LIVE_SHARE_CURRENT_HYDRATE', `Hydrating Current from files for ${currentDsl}…`);
        }

        const itemsForCurrent = fetchDataService.getItemsForFromFileLoad(g0 as any);
        if (itemsForCurrent.length === 0) {
          if (parentLogId) {
            sessionLogService.addChild(parentLogId, 'warning', 'LIVE_SHARE_CURRENT_NO_ITEMS', 'No items to hydrate for Current');
          }
          return;
        }

        // Unified cache-only pipeline: build plan (for observability) + from-file refresh (Stage‑2 enabled).
        try {
          fetchOrchestratorService.buildPlan({ graph: g0 as any, dsl: currentDsl, parentLogId });
        } catch {
          // Best-effort: do not block hydration if plan build fails (e.g. invalid DSL).
        }
        await fetchOrchestratorService.refreshFromFilesWithRetries({
          graphGetter: () => (graphStore.getState().graph as any) || null,
          setGraph: (g) => graphStore.getState().setGraph(g as any),
          dsl: currentDsl,
          skipStage2: false,
          parentLogId,
          attempts: 6,
          delayMs: 75,
        });

        if (parentLogId) {
          sessionLogService.addChild(parentLogId, 'success', 'LIVE_SHARE_CURRENT_HYDRATE_OK', 'Hydrated Current from files');
        }
      } catch (e: any) {
        if (parentLogId) {
          sessionLogService.addChild(parentLogId, 'warning', 'LIVE_SHARE_CURRENT_HYDRATE_ERROR', e?.message || String(e));
        }
      }
    },
    [graphStore, scenariosContext?.graph]
  );

  const recomputeChart = useCallback(
    async (created: Array<{ idx: number; id: string; dsl: string; scenario?: any }>) => {
      if (!scenariosContext || !chartFileId) return;
      const graph0 = scenariosContext.graph;
      if (!graph0) return;

      if (!chartPayload?.analysis) return;
      const queryDsl = chartPayload.analysis.query_dsl;
      const analysisType = chartPayload.analysis.analysis_type || undefined;
      const whatIfDsl = chartPayload.analysis.what_if_dsl || undefined;

      const items = chartPayload.scenarios?.items || [];
      const hideCurrent = Boolean(chartPayload.scenarios?.hide_current);

      const createdByIdx = new Map<number, { id: string; scenario?: any }>(created.map(c => [c.idx, { id: c.id, scenario: c.scenario }]));
      const itemIdxByScenarioId = new Map<string, number>();
      for (const [idx, v] of createdByIdx.entries()) itemIdxByScenarioId.set(v.id, idx);

      const orderedScenarioIds = items
        .map((_i, idx) => createdByIdx.get(idx)?.id)
        .filter((id): id is string => Boolean(id));

      // IMPORTANT: analyze requires at least one scenario.
      //
      // Bridge View compares two scenarios. In the authoring app, the convention is:
      // - scenario_a = selected/explicit scenario
      // - scenario_b = Current
      // i.e. Current is LAST (not first).
      const visibleScenarioIds = (() => {
        // Ordering rule: only "bridge_view" analysis uses the special "Current last" ordering.
        // Do NOT infer bridge semantics from chart kind alone.
        const isBridge = analysisType === 'bridge_view';
        if (isBridge) {
          const base = hideCurrent ? [...orderedScenarioIds] : [...orderedScenarioIds, 'current'];
          return base.length > 0 ? base : ['current'];
        }
        const base = hideCurrent ? [...orderedScenarioIds] : ['current', ...orderedScenarioIds];
        return base.length > 0 ? base : ['current'];
      })();

      const scenarioDslSubtitleById: Record<string, string> = {};
      for (let idx = 0; idx < items.length; idx++) {
        const item = items[idx];
        const id = createdByIdx.get(idx)?.id;
        if (!id) continue;
        scenarioDslSubtitleById[id] = (item.subtitle || item.dsl || '').trim();
      }
      // Also record the DSL used for Current during chart materialisation (required for debugging + share replay parity).
      const currentDslFromPayload = (chartPayload as any)?.graph_state?.current_query_dsl;
      if (typeof currentDslFromPayload === 'string' && currentDslFromPayload.trim()) {
        scenarioDslSubtitleById['current'] = currentDslFromPayload.trim();
      }

      // Build scenario graphs for analysis (same semantics as AnalyticsPanel).
      //
      // IMPORTANT:
      // When scenarios are just created, React state may not yet reflect them in scenariosContext.scenarios.
      // Use the passed-in scenarioIdsByDsl set as the authoritative map (created scenarios are included there
      // via ensureScenarios()) so we preserve names/colours deterministically.
      const scenarioOverrideById = new Map<string, any>();
      for (const c of created as any[]) {
        if (c?.id && c?.scenario) scenarioOverrideById.set(c.id, c.scenario);
      }

      // Build an authoritative scenario list for CompositionService:
      // use the created scenario objects (which we pass through regeneration) to avoid racing
      // React state updates (a common share-boot failure mode).
      const scenariosForLayer = (() => {
        const base = Array.isArray(scenariosContext.scenarios) ? scenariosContext.scenarios : [];
        const mapped = base.map(s => scenarioOverrideById.get(s.id) ?? s);
        for (const [id, s] of scenarioOverrideById.entries()) {
          if (!mapped.some((x: any) => x?.id === id)) mapped.push(s);
        }
        return mapped;
      })();

      // Ensure the graph object we send to the runner carries the AUTHORING DSL state from the share payload.
      // Do NOT rely on the repo graph file’s persisted baseDSL/currentQueryDSL (it may differ from authoring),
      // and do NOT rely on boot-time mutation to always win race conditions.
      const baseGraphForAnalysis0 = (graphStore?.getState().graph as any) || (scenariosContext.graph as any);
      const baseGraphForAnalysis: any = (() => {
        try {
          const cloned = JSON.parse(JSON.stringify(baseGraphForAnalysis0 || null));
          const gs: any = (chartPayload as any)?.graph_state || null;
          if (cloned && gs) {
            if (typeof gs.base_dsl === 'string' && gs.base_dsl.trim()) cloned.baseDSL = gs.base_dsl.trim();
            if (typeof gs.current_query_dsl === 'string' && gs.current_query_dsl.trim()) cloned.currentQueryDSL = gs.current_query_dsl.trim();
          }
          return cloned || baseGraphForAnalysis0;
        } catch {
          return baseGraphForAnalysis0;
        }
      })();
      const scenarioGraphs = visibleScenarioIds.map(scenarioId => {
        const visibilityMode = (() => {
          if (scenarioId === 'base') return 'f+e' as const;
          if (scenarioId === 'current') {
            const cur = (chartPayload as any)?.scenarios?.current;
            return (cur?.visibility_mode as any) || 'f+e';
          }
          const idx = itemIdxByScenarioId.get(scenarioId);
          const def = typeof idx === 'number' ? items[idx] : null;
          return (def?.visibility_mode as any) || 'f+e';
        })();

        const scenarioGraph = buildGraphForAnalysisLayer(
          scenarioId,
          baseGraphForAnalysis as any,
          scenariosContext.baseParams,
          scenariosContext.currentParams,
          scenariosForLayer as any,
          scenarioId === 'current' ? whatIfDsl : undefined,
          visibilityMode
        );

        const scenarioOverride = scenarioOverrideById.get(scenarioId);
        const scenarioFromState = scenariosContext.scenarios.find(s => s.id === scenarioId);
        const scenario = scenarioOverride || scenarioFromState;

        const name = (() => {
          if (scenarioId === 'current') return 'Current';
          const idx = itemIdxByScenarioId.get(scenarioId);
          const def = typeof idx === 'number' ? items[idx] : null;
          return def?.name || scenario?.name || scenarioId;
        })();
        const colour = (() => {
          if (scenarioId === 'current') {
            const cur = (chartPayload as any)?.scenarios?.current;
            return cur?.colour || scenariosContext.currentColour;
          }
          const idx = itemIdxByScenarioId.get(scenarioId);
          const def = typeof idx === 'number' ? items[idx] : null;
          return def?.colour || scenario?.colour;
        })();

        return {
          scenario_id: scenarioId,
          name,
          graph: scenarioGraph as any,
          colour,
          visibility_mode: visibilityMode,
        };
      });

      const response = await graphComputeClient.analyzeMultipleScenarios(
        scenarioGraphs as any,
        queryDsl || undefined,
        analysisType
      );

      if (!response?.success || !response.result) {
        throw new Error(response?.error?.message || 'Analysis failed');
      }

      const analysisResult = response.result;

      // Re-materialise (or update) a stable chart artefact file, then open a tab for it.
      await chartOperationsService.openAnalysisChartTabFromAnalysis({
        chartKind: chartPayload.chart.kind,
        analysisResult,
        scenarioIds: visibleScenarioIds,
        title: chartPayload.chart.title || analysisResult.analysis_name || 'Chart',
        source: {
          parent_file_id: fileId,
          parent_tab_id: tabId,
          query_dsl: queryDsl,
          analysis_type: analysisType,
        },
        scenarioDslSubtitleById,
        hideCurrent: Boolean((chartPayload as any)?.scenarios?.hide_current),
        whatIfDsl: (chartPayload as any)?.analysis?.what_if_dsl || undefined,
        fileId: chartFileId,
      });
    },
    [chartPayload, scenariosContext, chartFileId, fileId, tabId]
  );

  const runBootIfNeeded = useCallback(async () => {
    if (!isEligible || !chartPayload) return;
    if (!scenariosContext?.scenariosReady) return;
    if (processedRef.current) return;

    const forceRefetchFromFiles = (() => {
      try {
        const params = new URLSearchParams(window.location.search);
        return params.get('refetchfiles') === '1';
      } catch {
        return false;
      }
    })();

    const identity = shareMode?.identity;
    const opId = sessionLogService.startOperation(
      'info',
      'session',
      'LIVE_SHARE_BOOT',
      'Live share: boot (chart)',
      {
        repository: identity?.repo,
        branch: identity?.branch,
        graph: identity?.graph,
        chartFileId,
      } as any
    );

    // Fast path: show cached chart immediately if present.
    const openedCached = await openCachedChartIfPresent();
    if (openedCached) {
      sessionLogService.addChild(opId, 'info', 'LIVE_SHARE_BOOT_CACHE_OPENED', 'Opened cached chart artefact');
    }

    // If we already have a cached chart artefact, we may show it immediately as a placeholder,
    // but we STILL recompute on boot.
    //
    // Rationale: live share is a replay environment. Skipping recompute based on a local cached
    // artefact introduces a major divergence source (stale/partial chart results) and makes
    // first-load vs post-refresh comparisons meaningless.
    const cachedChart = chartFileId ? await fileRegistry.restoreFile(chartFileId) : null;
    const hasCachedResult = Boolean((cachedChart as any)?.data?.payload?.analysis_result);
    if (hasCachedResult && !forceRefetchFromFiles) {
      sessionLogService.addChild(opId, 'info', 'LIVE_SHARE_BOOT_CACHE_HIT', 'Cached chart artefact present (will recompute)');
    }

    // Wait until the graph is actually available in ScenariosContext.
    // In chart-only share boot, scenariosReady can become true before graphStore is hydrated.
    // If we proceed without a graph, recomputeChart will no-op and we'd never retry.
    if (!scenariosContext.graph) {
      sessionLogService.addChild(opId, 'warning', 'LIVE_SHARE_BOOT_NO_GRAPH', 'ScenariosContext.graph not ready yet; boot will retry on next render');
      sessionLogService.endOperation(opId, 'warning', 'Live share boot deferred (graph not ready)');
      return;
    }

    // Deterministic barrier: ensure all dependent files are present in IndexedDB and hydrated
    // into FileRegistry BEFORE scenario regeneration / analysis / chart materialisation.
    try {
      const identity = shareMode?.identity;
      if (identity?.repo && identity?.branch) {
        sessionLogService.addChild(opId, 'info', 'LIVE_SHARE_BOOT_HYDRATE', 'Waiting for live share graph dependencies…');
        const depRes = await waitForLiveShareGraphDeps({
          graph: scenariosContext.graph as any,
          identity: { repo: identity.repo, branch: identity.branch },
        });
        if (!depRes.success) {
          throw new Error(`Live share cache not ready (missing ${depRes.missing.length} file(s))`);
        }
        sessionLogService.addChild(opId, 'success', 'LIVE_SHARE_BOOT_HYDRATE_OK', 'Live share graph dependencies ready');
      }
    } catch (e) {
      // Surface as in-tab error (handled by the catch block below).
      throw e;
    }

    // Guard against React StrictMode double-mount (Playwright runs in dev-like mode).
    // processedRef alone is per-hook-instance; a global guard prevents duplicate chart tabs.
    if (typeof window !== 'undefined') {
      try {
        const keyBase = chartFileId || `${fileId}:${(chartPayload as any)?.chart?.kind || 'chart'}`;
        const key = forceRefetchFromFiles ? `${keyBase}:refetchfiles` : keyBase;
        const g = (window as any);
        if (!g.__dagnetShareChartProcessedKeys) g.__dagnetShareChartProcessedKeys = new Set<string>();
        if (key && g.__dagnetShareChartProcessedKeys.has(key)) return;
        if (key) g.__dagnetShareChartProcessedKeys.add(key);
      } catch {
        // ignore
      }
    }

    // Ensure we only process once per session (after prerequisites are satisfied).
    processedRef.current = true;

    if (import.meta.env.DEV) {
      try {
        const o = (window as any).__dagnetShareChartBootstrapper;
        if (o) o.mode = 'hook-start';
      } catch {
        // ignore
      }
    }

    try {
      sessionLogService.addChild(opId, 'info', 'LIVE_SHARE_BOOT_ENSURE_SCENARIOS', 'Ensuring scenarios…');
      const created = await ensureScenarios();
      sessionLogService.addChild(opId, 'success', 'LIVE_SHARE_BOOT_ENSURE_SCENARIOS_OK', `Ensured ${created.length} scenario(s)`);
      await applyScenarioViewState(created);

      // Deterministic ordering: hydrate Current first (for the chart's Current DSL), then regenerate live scenarios,
      // then run analysis. This avoids order-dependent drift between boot vs refresh.
      await hydrateCurrentFromFilesForShare({
        currentDslFromPayload: (chartPayload as any)?.graph_state?.current_query_dsl,
        parentLogId: opId,
      });

      // CRITICAL: live scenarios must be regenerated before analysis,
      // otherwise they are just "copies of Current" and will yield identical results.
      const liveIds = created.map(c => c.id);
      if (liveIds.length > 0) {
        // CRITICAL: call regenerateScenario with explicit overrides so we don't depend on
        // React state having already incorporated newly-created scenarios.
        const allScenariosOverride = created.map(c => c.scenario).filter(Boolean);
        for (const c of created) {
          sessionLogService.addChild(opId, 'info', 'LIVE_SHARE_BOOT_REGEN_SCENARIO', `Regenerating scenario ${c.id}…`, undefined, { scenarioId: c.id } as any);
          await scenariosContext.regenerateScenario(c.id, c.scenario, undefined, allScenariosOverride, liveIds, {
            skipStage2: false,
            allowFetchFromSource: false,
          });
        }
      }

      if (import.meta.env.DEV) {
        try {
          const o = (window as any).__dagnetShareChartBootstrapper;
          if (o) o.mode = 'pre-analyze';
        } catch {
          // ignore
        }
      }

      sessionLogService.addChild(opId, 'info', 'LIVE_SHARE_BOOT_RECOMPUTE', 'Recomputing chart…');
      await recomputeChart(created);
      sessionLogService.endOperation(opId, 'success', 'Live share boot complete');

      if (import.meta.env.DEV) {
        try {
          const o = (window as any).__dagnetShareChartBootstrapper;
          if (o) o.mode = 'chart-opened';
        } catch {
          // ignore
        }
      }
    } catch (e: any) {
      sessionLogService.addChild(opId, 'error', 'LIVE_SHARE_BOOT_ERROR', e?.message || String(e));
      sessionLogService.endOperation(opId, 'error', 'Live share boot failed');
      // IMPORTANT: Do not reset processedRef on boot failure.
      // In dev/StrictMode or when errors are persistent (e.g. missing data), resetting this
      // causes repeated boot attempts and duplicate chart tabs/error panes.
      // Persist an in-tab error state so dashboard mode never looks "blank" when recompute fails.
      // This is especially important for share links, where toasts may be missed.
      try {
        if (chartFileId && chartPayload?.chart?.kind) {
          const now = Date.now();
          await (fileRegistry as any).upsertFileClean(
            chartFileId,
            'chart' as any,
            { repository: 'local', branch: 'main', path: `charts/${chartFileId}.json` },
            {
              version: '1.0.0',
              chart_kind: chartPayload.chart.kind,
              title: chartPayload.chart.title || 'Chart',
              created_at_uk: formatDateUK(new Date(now)),
              created_at_ms: now,
              source: {
                parent_file_id: fileId,
                parent_tab_id: tabId,
                query_dsl: chartPayload.analysis?.query_dsl,
                analysis_type: chartPayload.analysis?.analysis_type || undefined,
              },
              payload: {
                analysis_result: null,
                scenario_ids: [],
                error_message: e?.message || String(e),
              },
            }
          );
          await chartOperationsService.openExistingChartTab({
            fileId: chartFileId,
            title: chartPayload.chart.title || 'Chart',
          });
        }
      } catch {
        // ignore best-effort error surfacing
      }
      if (import.meta.env.DEV) {
        try {
          (window as any).__dagnetShareChartBootError = e?.message || String(e);
        } catch {
          // ignore
        }
      }
      toast.error(e?.message || 'Failed to load live chart share');
    }
  }, [
    isEligible,
    chartPayload,
    scenariosContext?.scenariosReady,
    scenariosContext?.graph,
    openCachedChartIfPresent,
    chartFileId,
    ensureScenarios,
    applyScenarioViewState,
    hydrateCurrentFromFilesForShare,
    recomputeChart,
    scenariosContext,
  ]);

  // Boot (mount) behaviour
  useEffect(() => {
    void runBootIfNeeded();
  }, [runBootIfNeeded]);

  // Refresh pipeline: after live-share refresh, regenerate live scenarios and recompute the chart.
  useEffect(() => {
    if (!isEligible || !chartPayload) return;
    if (!shareMode?.identity.repo || !shareMode?.identity.branch || !shareMode?.identity.graph) return;
    if (!scenariosContext?.scenariosReady) return;

    const onRefreshed = async (ev: any) => {
      const detail = ev?.detail || {};
      if (detail.repo !== shareMode.identity.repo) return;
      if (detail.branch !== shareMode.identity.branch) return;
      if (detail.graph !== shareMode.identity.graph) return;

      const opId = sessionLogService.startOperation(
        'info',
        'session',
        'LIVE_SHARE_REFETCH_FROM_FILES',
        'Live share: refetch from files (recompute chart)',
        {
          repository: shareMode.identity.repo,
          branch: shareMode.identity.branch,
          graph: shareMode.identity.graph,
          reason: detail.reason,
        } as any
      );

      try {
        sessionLogService.addChild(opId, 'info', 'ENSURE_SCENARIOS', 'Ensuring scenarios…');
        const created = await ensureScenarios();
        sessionLogService.addChild(opId, 'success', 'ENSURE_SCENARIOS_OK', `Ensured ${created.length} scenario(s)`);
        await applyScenarioViewState(created);

        // Match boot ordering: hydrate Current first, then regenerate scenarios, then analyse.
        await hydrateCurrentFromFilesForShare({
          currentDslFromPayload: (chartPayload as any)?.graph_state?.current_query_dsl,
          parentLogId: opId,
        });

        // Regenerate live scenarios (with overrides) so this works even when scenarios were just created.
        const liveIds = created.map(c => c.id);
        const allScenariosOverride = created.map(c => c.scenario).filter(Boolean);
        for (const c of created) {
          sessionLogService.addChild(opId, 'info', 'REGEN_SCENARIO', `Regenerating scenario ${c.id}…`, undefined, { scenarioId: c.id } as any);
          await scenariosContext.regenerateScenario(c.id, c.scenario, undefined, allScenariosOverride, liveIds, {
            skipStage2: false,
            allowFetchFromSource: false,
          });
        }
        sessionLogService.addChild(opId, 'info', 'RECOMPUTE_CHART', 'Recomputing chart…');
        await recomputeChart(created);

        try {
          const chartFile = chartFileId ? fileRegistry.getFile(chartFileId) : null;
          const createdUk = (chartFile as any)?.data?.created_at_uk;
          const createdMs = (chartFile as any)?.data?.created_at_ms;
          sessionLogService.addChild(opId, 'success', 'CHART_UPDATED', 'Chart updated', undefined, { chartFileId, created_at_uk: createdUk, created_at_ms: createdMs } as any);
        } catch {
          sessionLogService.addChild(opId, 'success', 'CHART_UPDATED', 'Chart updated');
        }

        sessionLogService.endOperation(opId, 'success', 'Live share recompute complete');
      } catch (e: any) {
        sessionLogService.addChild(opId, 'error', 'LIVE_SHARE_REFETCH_ERROR', e?.message || String(e));
        sessionLogService.endOperation(opId, 'error', 'Live share recompute failed');
        toast.error(e?.message || 'Failed to refresh live chart');
      }
    };

    window.addEventListener('dagnet:liveShareRefreshed', onRefreshed as any);
    return () => window.removeEventListener('dagnet:liveShareRefreshed', onRefreshed as any);
  }, [isEligible, chartPayload, shareMode, scenariosContext, ensureScenarios, applyScenarioViewState, hydrateCurrentFromFilesForShare, recomputeChart]);
}

