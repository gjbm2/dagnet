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

      const scenario = await scenariosContext.createLiveScenario(dsl, wantName, tabId, wantColour);
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

  const recomputeChart = useCallback(
    async (created: Array<{ idx: number; id: string; dsl: string; scenario?: any }>) => {
      if (!scenariosContext || !chartFileId) return;
      const graph = scenariosContext.graph;
      if (!graph) return;

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
      const visibleScenarioIds = (() => {
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

      const scenarioGraphs = visibleScenarioIds.map(scenarioId => {
        const visibilityMode = (() => {
          if (scenarioId === 'current' || scenarioId === 'base') return 'f+e' as const;
          const idx = itemIdxByScenarioId.get(scenarioId);
          const def = typeof idx === 'number' ? items[idx] : null;
          return (def?.visibility_mode as any) || 'f+e';
        })();

        const scenarioGraph = buildGraphForAnalysisLayer(
          scenarioId,
          graph as any,
          scenariosContext.baseParams,
          scenariosContext.currentParams,
          scenariosContext.scenarios,
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
          if (scenarioId === 'current') return scenariosContext.currentColour;
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
        fileId: chartFileId,
      });
    },
    [chartPayload, scenariosContext, chartFileId, fileId, tabId]
  );

  const runBootIfNeeded = useCallback(async () => {
    if (!isEligible || !chartPayload) return;
    if (!scenariosContext?.scenariosReady) return;
    if (processedRef.current) return;

    // Fast path: show cached chart immediately if present.
    await openCachedChartIfPresent();

    // If we already have a cached chart artefact, do not recompute on boot.
    const cachedChart = chartFileId ? await fileRegistry.restoreFile(chartFileId) : null;
    const hasCachedResult = Boolean((cachedChart as any)?.data?.payload?.analysis_result);
    if (hasCachedResult) {
      processedRef.current = true;
      return;
    }

    // Wait until the graph is actually available in ScenariosContext.
    // In chart-only share boot, scenariosReady can become true before graphStore is hydrated.
    // If we proceed without a graph, recomputeChart will no-op and we'd never retry.
    if (!scenariosContext.graph) return;

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
      const created = await ensureScenarios();
      await applyScenarioViewState(created);

      // CRITICAL: live scenarios must be regenerated before analysis,
      // otherwise they are just "copies of Current" and will yield identical results.
      const liveIds = created.map(c => c.id);
      if (liveIds.length > 0) {
        // CRITICAL: call regenerateScenario with explicit overrides so we don't depend on
        // React state having already incorporated newly-created scenarios.
        const allScenariosOverride = created.map(c => c.scenario).filter(Boolean);
        for (const c of created) {
          await scenariosContext.regenerateScenario(c.id, c.scenario, undefined, allScenariosOverride, liveIds);
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

      await recomputeChart(created);

      if (import.meta.env.DEV) {
        try {
          const o = (window as any).__dagnetShareChartBootstrapper;
          if (o) o.mode = 'chart-opened';
        } catch {
          // ignore
        }
      }
    } catch (e: any) {
      processedRef.current = false;
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
                scenario_dsl_subtitle_by_id: undefined,
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

      try {
        const created = await ensureScenarios();
        await applyScenarioViewState(created);
        // Regenerate live scenarios (with overrides) so this works even when scenarios were just created.
        const liveIds = created.map(c => c.id);
        const allScenariosOverride = created.map(c => c.scenario).filter(Boolean);
        for (const c of created) {
          await scenariosContext.regenerateScenario(c.id, c.scenario, undefined, allScenariosOverride, liveIds);
        }
        await recomputeChart(created);
      } catch (e: any) {
        toast.error(e?.message || 'Failed to refresh live chart');
      }
    };

    window.addEventListener('dagnet:liveShareRefreshed', onRefreshed as any);
    return () => window.removeEventListener('dagnet:liveShareRefreshed', onRefreshed as any);
  }, [isEligible, chartPayload, shareMode, scenariosContext, ensureScenarios, applyScenarioViewState, recomputeChart]);
}

