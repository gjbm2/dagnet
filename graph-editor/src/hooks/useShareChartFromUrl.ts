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

  const ensureScenarios = useCallback(async (): Promise<Array<{ id: string; dsl: string; scenario?: any }>> => {
    if (!scenariosContext || !chartPayload) return [];
    const items = chartPayload.scenarios?.items || [];

    const existingByDsl = new Map<string, string>();
    for (const s of scenariosContext.scenarios || []) {
      const dsl = s?.meta?.queryDSL;
      if (dsl) existingByDsl.set(dsl, s.id);
    }

    const created: Array<{ id: string; dsl: string; scenario?: any }> = [];
    for (const item of items) {
      const dsl = item.dsl;
      if (!dsl || !dsl.trim()) continue;
      const existingId = existingByDsl.get(dsl);
      if (existingId) {
        const existingScenario = scenariosContext.scenarios?.find(s => s.id === existingId);
        created.push({ id: existingId, dsl, scenario: existingScenario });
        continue;
      }
      const scenario = await scenariosContext.createLiveScenario(dsl, item.name, tabId, item.colour);
      created.push({ id: scenario.id, dsl, scenario });
    }

    return created;
  }, [chartPayload, scenariosContext, tabId]);

  const applyScenarioViewState = useCallback(
    async (scenarioIdsByDsl: Array<{ id: string; dsl: string }>) => {
    if (!tabId || !chartPayload) return;
    const items = chartPayload.scenarios?.items || [];
    const hideCurrent = Boolean(chartPayload.scenarios?.hide_current);

      const orderedScenarioIds = items
        .map(i => scenarioIdsByDsl.find(s => s.dsl === i.dsl)?.id)
        .filter((id): id is string => Boolean(id));

      const visible = hideCurrent ? [...orderedScenarioIds] : ['current', ...orderedScenarioIds];
      await operations.setVisibleScenarios(tabId, visible);

      for (const item of items) {
        const id = scenarioIdsByDsl.find(s => s.dsl === item.dsl)?.id;
        if (!id) continue;
        const mode = item.visibility_mode || 'f+e';
        await operations.setScenarioVisibilityMode(tabId, id, mode);
      }
    },
    [chartPayload, tabId, operations]
  );

  const recomputeChart = useCallback(
    async (scenarioIdsByDsl: Array<{ id: string; dsl: string }>) => {
      if (!scenariosContext || !chartFileId) return;
      const graph = scenariosContext.graph;
      if (!graph) return;

      if (!chartPayload?.analysis) return;
      const queryDsl = chartPayload.analysis.query_dsl;
      const analysisType = chartPayload.analysis.analysis_type || undefined;
      const whatIfDsl = chartPayload.analysis.what_if_dsl || undefined;

      const items = chartPayload.scenarios?.items || [];
      const hideCurrent = Boolean(chartPayload.scenarios?.hide_current);

      const orderedScenarioIds = items
        .map(i => scenarioIdsByDsl.find(s => s.dsl === i.dsl)?.id)
        .filter((id): id is string => Boolean(id));

      const visibleScenarioIds = hideCurrent ? [...orderedScenarioIds] : ['current', ...orderedScenarioIds];

      const scenarioDslSubtitleById: Record<string, string> = {};
      for (const item of items) {
        const id = scenarioIdsByDsl.find(s => s.dsl === item.dsl)?.id;
        if (!id) continue;
        scenarioDslSubtitleById[id] = (item.subtitle || item.dsl || '').trim();
      }

      // Build scenario graphs for analysis (same semantics as AnalyticsPanel).
      const scenarioGraphs = visibleScenarioIds.map(scenarioId => {
        const visibilityMode = (() => {
          if (scenarioId === 'current' || scenarioId === 'base') return 'f+e' as const;
          const item = items.find(i => scenarioIdsByDsl.find(s => s.id === scenarioId)?.dsl === i.dsl);
          return (item?.visibility_mode as any) || 'f+e';
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

        const name =
          scenarioId === 'current'
            ? 'Current'
            : scenariosContext.scenarios.find(s => s.id === scenarioId)?.name || scenarioId;
        const colour =
          scenarioId === 'current'
            ? scenariosContext.currentColour
            : scenariosContext.scenarios.find(s => s.id === scenarioId)?.colour;

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

