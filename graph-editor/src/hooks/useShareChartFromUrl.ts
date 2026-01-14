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

  const isEligible =
    Boolean(payload && payload.target === 'chart') &&
    Boolean(shareMode?.isLiveMode) &&
    Boolean(shareMode?.identity.repo && shareMode?.identity.branch && shareMode?.identity.graph);

  const chartFileId = useMemo(() => {
    if (!payload || payload.target !== 'chart') return null;
    return `chart-share-${stableShortHash(JSON.stringify(payload))}`;
  }, [payload]);

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
      title: (payload as any)?.chart?.title || 'Chart',
    });
    return true;
  }, [chartFileId, tabs, payload]);

  const ensureScenarios = useCallback(async (): Promise<Array<{ id: string; dsl: string }>> => {
    if (!scenariosContext || !tabId) return [];
    const items = (payload as SharePayloadV1).scenarios.items || [];

    const existingByDsl = new Map<string, string>();
    for (const s of scenariosContext.scenarios || []) {
      const dsl = s?.meta?.queryDSL;
      if (dsl) existingByDsl.set(dsl, s.id);
    }

    const created: Array<{ id: string; dsl: string }> = [];
    for (const item of items) {
      const dsl = item.dsl;
      if (!dsl || !dsl.trim()) continue;
      const existingId = existingByDsl.get(dsl);
      if (existingId) {
        created.push({ id: existingId, dsl });
        continue;
      }
      const scenario = await scenariosContext.createLiveScenario(dsl, item.name, tabId, item.colour);
      created.push({ id: scenario.id, dsl });
    }

    return created;
  }, [payload, scenariosContext, tabId]);

  const applyScenarioViewState = useCallback(
    async (scenarioIdsByDsl: Array<{ id: string; dsl: string }>) => {
      if (!tabId) return;
      const items = (payload as SharePayloadV1).scenarios.items || [];
      const hideCurrent = Boolean((payload as SharePayloadV1).scenarios.hide_current);

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
    [payload, tabId, operations]
  );

  const recomputeChart = useCallback(
    async (scenarioIdsByDsl: Array<{ id: string; dsl: string }>) => {
      if (!scenariosContext || !chartFileId) return;
      const graph = scenariosContext.graph;
      if (!graph) return;

      const p = payload as SharePayloadV1;
      const queryDsl = p.analysis.query_dsl;
      const analysisType = p.analysis.analysis_type || undefined;
      const whatIfDsl = p.analysis.what_if_dsl || undefined;

      const items = p.scenarios.items || [];
      const hideCurrent = Boolean(p.scenarios.hide_current);

      const orderedScenarioIds = items
        .map(i => scenarioIdsByDsl.find(s => s.dsl === i.dsl)?.id)
        .filter((id): id is string => Boolean(id));

      const visibleScenarioIds = hideCurrent ? [...orderedScenarioIds] : ['current', ...orderedScenarioIds];

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

      if (!response?.success) {
        throw new Error(response?.error?.message || 'Analysis failed');
      }

      const analysisResult = response.result;

      // Re-materialise (or update) a stable chart artefact file, then open a tab for it.
      await chartOperationsService.openAnalysisChartTabFromAnalysis({
        chartKind: p.chart.kind,
        analysisResult,
        scenarioIds: visibleScenarioIds,
        title: p.chart.title || analysisResult.analysis_name || 'Chart',
        source: {
          parent_file_id: fileId,
          parent_tab_id: tabId,
          query_dsl: queryDsl,
          analysis_type: analysisType,
        },
        fileId: chartFileId,
      });
    },
    [payload, scenariosContext, chartFileId, fileId, tabId]
  );

  const runBootIfNeeded = useCallback(async () => {
    if (!isEligible || !payload || payload.target !== 'chart') return;
    if (!scenariosContext?.scenariosReady) return;
    if (!tabId) return;
    if (processedRef.current) return;

    // Ensure we only process once per session (per graph tab).
    processedRef.current = true;

    // Fast path: show cached chart immediately if present.
    await openCachedChartIfPresent();

    // If we already have a cached chart artefact, do not recompute on boot.
    const cachedChart = chartFileId ? await fileRegistry.restoreFile(chartFileId) : null;
    const hasCachedResult = Boolean((cachedChart as any)?.data?.payload?.analysis_result);
    if (hasCachedResult) return;

    try {
      const created = await ensureScenarios();
      await applyScenarioViewState(created);
      await recomputeChart(created);
    } catch (e: any) {
      processedRef.current = false;
      toast.error(e?.message || 'Failed to load live chart share');
    }
  }, [
    isEligible,
    payload,
    scenariosContext?.scenariosReady,
    tabId,
    openCachedChartIfPresent,
    chartFileId,
    ensureScenarios,
    applyScenarioViewState,
    recomputeChart,
  ]);

  // Boot (mount) behaviour
  useEffect(() => {
    void runBootIfNeeded();
  }, [runBootIfNeeded]);

  // Refresh pipeline: after live-share refresh, regenerate live scenarios and recompute the chart.
  useEffect(() => {
    if (!isEligible || !payload || payload.target !== 'chart') return;
    if (!shareMode?.identity.repo || !shareMode?.identity.branch || !shareMode?.identity.graph) return;
    if (!scenariosContext?.scenariosReady) return;
    if (!tabId) return;

    const onRefreshed = async (ev: any) => {
      const detail = ev?.detail || {};
      if (detail.repo !== shareMode.identity.repo) return;
      if (detail.branch !== shareMode.identity.branch) return;
      if (detail.graph !== shareMode.identity.graph) return;

      try {
        const created = await ensureScenarios();
        await applyScenarioViewState(created);
        // Regenerate all live scenarios (ensures versions increment and analysis keys change)
        await scenariosContext.regenerateAllLive(undefined, created.map(c => c.id));
        await recomputeChart(created);
      } catch (e: any) {
        toast.error(e?.message || 'Failed to refresh live chart');
      }
    };

    window.addEventListener('dagnet:liveShareRefreshed', onRefreshed as any);
    return () => window.removeEventListener('dagnet:liveShareRefreshed', onRefreshed as any);
  }, [isEligible, payload, shareMode, scenariosContext, tabId, ensureScenarios, applyScenarioViewState, recomputeChart]);
}

