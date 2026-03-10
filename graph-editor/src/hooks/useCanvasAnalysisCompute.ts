import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useGraphStore } from '../contexts/GraphStoreContext';
import { useScenariosContextOptional } from '../contexts/ScenariosContext';
import { useTabContext, useFileState, fileRegistry } from '../contexts/TabContext';
import { graphComputeClient, type AnalysisResult } from '../lib/graphComputeClient';
import { ANALYSIS_TYPES } from '../components/panels/analysisTypes';
import { hydrateSnapshotPlannerInputs } from '../services/snapshotSubjectResolutionService';
import {
  isSnapshotBootChart,
  logSnapshotBoot,
  logChartReadinessTrace,
  recordSnapshotBootLedgerStage,
} from '../lib/snapshotBootTrace';
import type { CanvasAnalysis } from '../types';
import { isChartComputeReady } from '../services/chartHydrationService';
import {
  prepareAnalysisComputeInputs,
  runPreparedAnalysis,
  type PreparedAnalysisComputeReady,
  type PreparedAnalysisComputeState,
} from '../services/analysisComputePreparationService';

const DEBOUNCE_MS = 2000;

interface UseCanvasAnalysisComputeParams {
  analysis: CanvasAnalysis;
  tabId?: string;
  debugSnapshotChartOverride?: boolean;
}

interface UseCanvasAnalysisComputeResult {
  result: AnalysisResult | null;
  loading: boolean;
  waitingForDeps: boolean;
  error: string | null;
  backendUnavailable: boolean;
  refresh: () => void;
}

export const canvasAnalysisTransientCache = new Map<string, AnalysisResult>();
export const canvasAnalysisResultCache = new Map<string, AnalysisResult>();

export function useCanvasAnalysisCompute({
  analysis: analysisProp,
  tabId,
  debugSnapshotChartOverride,
}: UseCanvasAnalysisComputeParams): UseCanvasAnalysisComputeResult {
  const { graph, currentDSL } = useGraphStore();
  const scenariosContext = useScenariosContextOptional();
  const { tabs, operations } = useTabContext();
  const operationsRef = useRef(operations);
  operationsRef.current = operations;

  const analysis = useMemo(() => {
    const fromStore = (graph as any)?.canvasAnalyses?.find((a: any) => a.id === analysisProp.id);
    return fromStore || analysisProp;
  }, [graph, analysisProp]);

  const [result, setResult] = useState<AnalysisResult | null>(() => {
    const cached = canvasAnalysisTransientCache.get(analysis.id);
    if (cached) {
      canvasAnalysisTransientCache.delete(analysis.id);
      return cached;
    }
    return null;
  });
  const [loading, setLoading] = useState(!result);
  const [error, setError] = useState<string | null>(null);
  const [backendUnavailable, setBackendUnavailable] = useState(false);
  const [manualRefreshNonce, setManualRefreshNonce] = useState(0);
  const [registryVersion, setRegistryVersion] = useState(0);
  const [preparedState, setPreparedState] = useState<PreparedAnalysisComputeState>({
    status: 'blocked',
    reason: 'graph_not_ready',
  });

  const debounceRef = useRef<NodeJS.Timeout | null>(null);
  const mountedRef = useRef(true);
  const computeCountRef = useRef(0);
  const activeRunKeyRef = useRef<string | null>(null);
  const completedRunKeyRef = useRef<string | null>(null);
  const seededTransientResultRef = useRef(Boolean(result));

  const expectsTimeSeriesBranchResult =
    analysis?.recipe?.analysis?.analysis_type === 'branch_comparison'
    && analysis?.chart_kind === 'time_series';
  const analysisType = analysis?.recipe?.analysis?.analysis_type;
  const analyticsDsl = analysis?.recipe?.analysis?.analytics_dsl || '';
  const snapshotMeta = useMemo(
    () => ANALYSIS_TYPES.find(t => t.id === analysisType),
    [analysisType],
  );
  const needsSnapshots = !!snapshotMeta?.snapshotContract
    && (analysisType !== 'branch_comparison' || expectsTimeSeriesBranchResult);
  const resultHasTimeDimension = !!(result?.semantics?.dimensions || []).some((d: any) => d?.id === 'date' || d?.type === 'time');
  const debugSnapshotChart = debugSnapshotChartOverride ?? isSnapshotBootChart(analysis);
  const propLooksSnapshot = isSnapshotBootChart(analysisProp);

  useEffect(() => {
    if (!debugSnapshotChart) return;
    const storeLooksSnapshot = isSnapshotBootChart(analysis);
    if (storeLooksSnapshot !== propLooksSnapshot) {
      logSnapshotBoot('CanvasAnalysisCompute:store-payload-mismatch', {
        analysisId: analysisProp.id,
        propAnalysisType: analysisProp.recipe?.analysis?.analysis_type,
        propChartKind: analysisProp.chart_kind,
        storeAnalysisType: analysis.recipe?.analysis?.analysis_type,
        storeChartKind: analysis.chart_kind,
        propLooksSnapshot,
        storeLooksSnapshot,
        tabId,
      });
    }
  }, [debugSnapshotChart, analysis, analysisProp, propLooksSnapshot, tabId]);

  useEffect(() => {
    if (expectsTimeSeriesBranchResult && result && !resultHasTimeDimension) {
      // Only retry if the result has non-empty data in the wrong format
      // (bar/pie instead of time_series). If the result is genuinely empty
      // (no data from snapshot DB), retrying would loop forever.
      const hasNonEmptyData = Array.isArray(result.data) && result.data.length > 0;
      if (hasNonEmptyData) {
        completedRunKeyRef.current = null;
        setResult(null);
        canvasAnalysisResultCache.delete(analysis.id);
        setLoading(true);
      }
    }
  }, [expectsTimeSeriesBranchResult, result, resultHasTimeDimension, analysis.id]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const currentTab = useMemo(() =>
    tabId ? tabs.find(t => t.id === tabId) : undefined,
  [tabId, tabs]);
  const graphFileState = useFileState(currentTab?.fileId);

  const rawScenarioState = useMemo(() => {
    if (!tabId) return null;
    return currentTab?.editorState?.scenarioState ?? null;
  }, [tabId, currentTab]);

  const scenarioState = useMemo(() => {
    if (!tabId) return null;
    return operations.getScenarioState(tabId);
  }, [tabId, operations, tabs]);

  const whatIfDSL = currentTab?.editorState?.whatIfDSL || null;

  const workspace = useMemo(() => {
    const repository = graphFileState.source?.repository;
    const branch = graphFileState.source?.branch;
    return (repository && branch) ? { repository, branch } : undefined;
  }, [graphFileState.source?.branch, graphFileState.source?.repository]);
  const workspaceReady = !needsSnapshots || !!workspace;

  useEffect(() => {
    if (!debugSnapshotChart) return;
    logSnapshotBoot('CanvasAnalysisCompute:file-state', {
      analysisId: analysis.id,
      analysisType,
      chartKind: analysis.chart_kind,
      tabId,
      fileId: currentTab?.fileId,
      workspace,
      workspaceReady,
      needsSnapshots,
      source: graphFileState.source || null,
    });
  }, [
    debugSnapshotChart,
    analysis.id,
    analysisType,
    analysis.chart_kind,
    tabId,
    currentTab?.fileId,
    workspace,
    workspaceReady,
    needsSnapshots,
    graphFileState.source,
  ]);

  const getScenarioColour = useCallback((scenarioId: string): string => {
    if (!scenariosContext) return '#808080';
    if (scenarioId === 'current') return (scenariosContext as any).currentColour || '#808080';
    if (scenarioId === 'base') return (scenariosContext as any).baseColour || '#808080';
    const scenario = (scenariosContext as any).scenarios?.find((s: any) => s.id === scenarioId);
    return scenario?.colour || '#808080';
  }, [scenariosContext]);

  const getScenarioName = useCallback((scenarioId: string): string => {
    if (scenarioId === 'current') return 'Current';
    if (scenarioId === 'base') return 'Base';
    const scenario = (scenariosContext as any)?.scenarios?.find((s: any) => s.id === scenarioId);
    return scenario?.name || scenarioId;
  }, [scenariosContext]);

  const computeReady = useMemo(() => {
    const baseReady = isChartComputeReady({
      graph: graph as any,
      analysisType,
      live: analysis.live,
      scenarioState: analysis.live ? rawScenarioState : scenarioState,
      scenariosReady: scenariosContext ? Boolean((scenariosContext as any).scenariosReady) : false,
      customScenarios: analysis.recipe?.scenarios || null,
    });
    return baseReady && workspaceReady;
  }, [graph, analysis, analysisType, rawScenarioState, scenarioState, scenariosContext, workspaceReady]);

  const prepareVersionRef = useRef(0);
  const lastAppliedPrepareRef = useRef(0);

  useEffect(() => {
    const thisVersion = ++prepareVersionRef.current;

    const prepare = async () => {
      logChartReadinessTrace('CanvasScheduler:prepare-triggered', {
        analysisId: analysis.id,
        analysisType,
        chartKind: analysis.chart_kind,
        live: analysis.live,
        manualRefreshNonce,
        registryVersion,
        tabId,
        prepareVersion: thisVersion,
      });
      try {
        const nextPreparedState = await prepareAnalysisComputeInputs(
          analysis.live
            ? {
                mode: 'live',
                graph: graph as any,
                analysisType,
                analyticsDsl,
                currentDSL,
                chartCurrentLayerDsl: analysis.chart_current_layer_dsl,
                needsSnapshots,
                workspace,
                rawScenarioStateLoaded: Boolean(rawScenarioState),
                visibleScenarioIds: rawScenarioState?.visibleScenarioIds || [],
                scenariosContext: scenariosContext as any,
                whatIfDSL,
                getScenarioVisibilityMode: (scenarioId) => (
                  tabId ? operationsRef.current.getScenarioVisibilityMode(tabId, scenarioId) : 'f+e'
                ),
                getScenarioName,
                getScenarioColour,
              }
            : {
                mode: 'custom',
                graph: graph as any,
                analysisType,
                analyticsDsl,
                currentDSL,
                chartCurrentLayerDsl: analysis.chart_current_layer_dsl,
                needsSnapshots,
                workspace,
                customScenarios: analysis.recipe?.scenarios as any,
                hiddenScenarioIds: (((analysis.display as any)?.hidden_scenarios) || []) as string[],
                frozenWhatIfDsl: analysis.recipe?.analysis?.what_if_dsl,
              },
        );
        if (!mountedRef.current) return;
        if (thisVersion < lastAppliedPrepareRef.current) return;
        lastAppliedPrepareRef.current = thisVersion;
        setPreparedState(nextPreparedState);
      } catch (err: any) {
        if (!mountedRef.current) return;
        if (thisVersion < lastAppliedPrepareRef.current) return;
        lastAppliedPrepareRef.current = thisVersion;
        setPreparedState({ status: 'blocked', reason: 'graph_not_ready' });
        setError(err?.message || String(err));
        setLoading(false);
      }
    };

    void prepare();
  }, [
    graph,
    analysis,
    analysisType,
    analyticsDsl,
    currentDSL,
    needsSnapshots,
    workspace,
    rawScenarioState,
    scenarioState,
    scenariosContext,
    whatIfDSL,
    tabId,
    getScenarioColour,
    getScenarioName,
    registryVersion,
  ]);

  useEffect(() => {
    if (preparedState.status !== 'blocked') return undefined;
    const fileIds = preparedState.requiredFileIds || [];
    if (fileIds.length === 0) return undefined;
    logChartReadinessTrace('CanvasScheduler:subscribe-planner-files', {
      analysisId: analysis.id,
      analysisType,
      fileIds,
      blockedReason: preparedState.reason,
    });
    const unsubscribers = fileIds.map((fileId) => fileRegistry.subscribe(fileId, () => {
      logChartReadinessTrace('CanvasScheduler:planner-file-updated', {
        analysisId: analysis.id,
        analysisType,
        fileId,
      });
      setRegistryVersion((value) => value + 1);
    }));
    return () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    };
  }, [preparedState]);

  useEffect(() => {
    if (preparedState.status !== 'blocked') return;
    if (preparedState.reason !== 'planner_inputs_pending_hydration') return;
    const hydratableFileIds = preparedState.hydratableFileIds || [];
    if (hydratableFileIds.length === 0) return;
    logChartReadinessTrace('CanvasScheduler:hydrate-planner-inputs', {
      analysisId: analysis.id,
      analysisType,
      hydratableFileIds,
      workspace,
    });
    void hydrateSnapshotPlannerInputs({ fileIds: hydratableFileIds, workspace });
  }, [preparedState, workspace]);

  useEffect(() => {
    if (preparedState.status === 'blocked') {
      setLoading(false);
    }
  }, [preparedState]);

  const waitingForDeps = preparedState.status === 'blocked' && !error && !backendUnavailable;
  const graphReady = !!(graph && Array.isArray((graph as any).nodes) && Array.isArray((graph as any).edges));
  const analysisReady = typeof analysisType === 'string' && analysisType.trim().length > 0;
  const scenariosCtxReady = scenariosContext ? Boolean((scenariosContext as any).scenariosReady) : false;
  const effectiveScenarioState = analysis.live ? rawScenarioState : scenarioState;
  const scenarioStateReady = analysis.live ? !!effectiveScenarioState : true;

  const readinessSnapshot = useMemo(() => ({
    analysisId: analysis.id,
    analysisType,
    chartKind: analysis.chart_kind,
    live: analysis.live,
    tabId,
    graphReady,
    analysisReady,
    scenariosCtxReady,
    scenarioStateReady,
    workspaceReady,
    needsSnapshots,
    blockedReason: preparedState.status === 'blocked' ? preparedState.reason : null,
    computeReady,
    waitingForDeps,
    visibleScenarioIds: effectiveScenarioState?.visibleScenarioIds || null,
  }), [
    analysis.id,
    analysisType,
    analysis.chart_kind,
    analysis.live,
    tabId,
    graphReady,
    analysisReady,
    scenariosCtxReady,
    scenarioStateReady,
    workspaceReady,
    needsSnapshots,
    preparedState,
    computeReady,
    waitingForDeps,
    effectiveScenarioState,
  ]);

  const readinessKey = useMemo(() => JSON.stringify(readinessSnapshot), [readinessSnapshot]);
  const lastReadinessKeyRef = useRef('');
  useEffect(() => {
    if (!debugSnapshotChart) return;
    if (lastReadinessKeyRef.current === readinessKey) return;
    lastReadinessKeyRef.current = readinessKey;
    logSnapshotBoot('CanvasAnalysisCompute:readiness', readinessSnapshot);
  }, [debugSnapshotChart, readinessKey, readinessSnapshot]);

  useEffect(() => {
    if (!debugSnapshotChart) return;
    recordSnapshotBootLedgerStage('hook-mounted', {
      analysisId: analysis.id,
      analysisType,
      chartKind: analysis.chart_kind,
      live: analysis.live,
      tabId,
      source: 'useCanvasAnalysisCompute',
    });
    logSnapshotBoot('CanvasAnalysisCompute:hook-mount', {
      analysisId: analysis.id,
      analysisType,
      chartKind: analysis.chart_kind,
      live: analysis.live,
      tabId,
    });
    return () => {
      recordSnapshotBootLedgerStage('hook-unmounted', {
        analysisId: analysis.id,
        analysisType,
        chartKind: analysis.chart_kind,
        live: analysis.live,
        tabId,
        source: 'useCanvasAnalysisCompute',
      });
      logSnapshotBoot('CanvasAnalysisCompute:hook-unmount', {
        analysisId: analysis.id,
        analysisType,
        chartKind: analysis.chart_kind,
        live: analysis.live,
        tabId,
      });
    };
  }, [debugSnapshotChart, analysis.id, analysisType, analysis.chart_kind, analysis.live, tabId]);

  useEffect(() => {
    if (!debugSnapshotChart) return;
    if (preparedState.status === 'blocked') {
      recordSnapshotBootLedgerStage('prepared-blocked', {
        analysisId: analysis.id,
        analysisType,
        chartKind: analysis.chart_kind,
        live: analysis.live,
        tabId,
        reason: preparedState.reason,
        requiredFileIds: preparedState.requiredFileIds || [],
        hydratableFileIds: preparedState.hydratableFileIds || [],
        source: 'useCanvasAnalysisCompute',
      });
      return;
    }
    recordSnapshotBootLedgerStage('prepared-ready', {
      analysisId: analysis.id,
      analysisType,
      chartKind: analysis.chart_kind,
      live: analysis.live,
      tabId,
      signature: preparedState.signature,
      scenarioIds: preparedState.scenarios.map((scenario) => scenario.scenario_id),
      source: 'useCanvasAnalysisCompute',
    });
  }, [debugSnapshotChart, preparedState, analysis.id, analysisType, analysis.chart_kind, analysis.live, tabId]);

  const runCompute = useCallback(async (prepared: PreparedAnalysisComputeReady, runKey: string) => {
    const thisCompute = ++computeCountRef.current;
    activeRunKeyRef.current = runKey;
    setLoading(true);
    setError(null);
    setBackendUnavailable(false);

    if (debugSnapshotChart) {
      recordSnapshotBootLedgerStage('compute-start', {
        analysisId: analysis.id,
        analysisType,
        chartKind: analysis.chart_kind,
        live: analysis.live,
        tabId,
        scenarioIds: prepared.scenarios.map((scenario) => scenario.scenario_id),
        signature: prepared.signature,
        source: 'useCanvasAnalysisCompute',
      });
      logSnapshotBoot('CanvasAnalysisCompute:compute-start', {
        analysisId: analysis.id,
        analysisType,
        chartKind: analysis.chart_kind,
        live: analysis.live,
        scenarioIds: prepared.scenarios.map((scenario) => scenario.scenario_id),
        signature: prepared.signature,
      });
    }

    try {
      const response = await runPreparedAnalysis(prepared);
      if (thisCompute !== computeCountRef.current || !mountedRef.current) return;

      if (response?.result) {
        completedRunKeyRef.current = runKey;
        if (debugSnapshotChart) {
          recordSnapshotBootLedgerStage('compute-success', {
            analysisId: analysis.id,
            analysisType,
            chartKind: analysis.chart_kind,
            live: analysis.live,
            tabId,
            requestedAnalysisType: analysisType,
            responseAnalysisType: response.result.analysis_type,
            responseSource: (response.result.metadata as any)?.source,
            responseDescription: response.result.analysis_description,
            source: 'useCanvasAnalysisCompute',
          });
          logSnapshotBoot('CanvasAnalysisCompute:compute-success', {
            analysisId: analysis.id,
            requestedAnalysisType: analysisType,
            responseAnalysisType: response.result.analysis_type,
            responseSource: (response.result.metadata as any)?.source,
            responseDescription: response.result.analysis_description,
          });
        }
        setResult(response.result);
        canvasAnalysisResultCache.set(analysis.id, response.result);
        setError(null);
      } else {
        completedRunKeyRef.current = runKey;
        setError('No result returned from compute');
      }
    } catch (err: any) {
      if (thisCompute !== computeCountRef.current || !mountedRef.current) return;
      const msg = err?.message || String(err);
      completedRunKeyRef.current = runKey;
      if (debugSnapshotChart) {
        recordSnapshotBootLedgerStage('compute-error', {
          analysisId: analysis.id,
          analysisType,
          chartKind: analysis.chart_kind,
          live: analysis.live,
          tabId,
          message: msg,
          source: 'useCanvasAnalysisCompute',
        });
        logSnapshotBoot('CanvasAnalysisCompute:compute-error', {
          analysisId: analysis.id,
          analysisType,
          chartKind: analysis.chart_kind,
          message: msg,
        });
      }
      if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('ECONNREFUSED')) {
        setBackendUnavailable(true);
      } else {
        setError(msg);
      }
    } finally {
      if (activeRunKeyRef.current === runKey) {
        activeRunKeyRef.current = null;
      }
      if (thisCompute === computeCountRef.current && mountedRef.current) {
        setLoading(false);
      }
    }
  }, [analysis.id, analysis.live, analysis.chart_kind, analysisType, debugSnapshotChart, tabId]);

  useEffect(() => {
    if (preparedState.status !== 'ready') return;

    const runKey = `${preparedState.signature}|refresh:${manualRefreshNonce}`;
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (seededTransientResultRef.current && result && manualRefreshNonce === 0) {
      seededTransientResultRef.current = false;
      canvasAnalysisResultCache.set(analysis.id, result);
      logChartReadinessTrace('CanvasScheduler:skip-seeded-result', {
        analysisId: analysis.id,
        analysisType,
        signature: preparedState.signature,
      });
      return;
    }

    const activeRunKey = activeRunKeyRef.current;
    const completedRunKey = completedRunKeyRef.current;
    const hasSettledCurrentResult = completedRunKey === runKey && !!result && !loading && !error && !backendUnavailable;
    if (activeRunKey === runKey || hasSettledCurrentResult) {
      logChartReadinessTrace('CanvasScheduler:skip-duplicate-signature', {
        analysisId: analysis.id,
        analysisType,
        runKey,
        active: activeRunKey === runKey,
        completed: hasSettledCurrentResult,
      });
      return;
    }

    const isManualRefresh = manualRefreshNonce > 0;
    const shouldDebounce = analysis.live && !!result && !isManualRefresh;

    if (shouldDebounce) {
      logChartReadinessTrace('CanvasScheduler:schedule-debounced', {
        analysisId: analysis.id,
        analysisType,
        signature: preparedState.signature,
        delayMs: DEBOUNCE_MS,
      });
      setLoading(true);
      debounceRef.current = setTimeout(() => {
        void runCompute(preparedState, runKey);
      }, DEBOUNCE_MS);
      return () => {
        if (debounceRef.current) clearTimeout(debounceRef.current);
      };
    }

    logChartReadinessTrace('CanvasScheduler:schedule-immediate', {
      analysisId: analysis.id,
      analysisType,
      signature: preparedState.signature,
      manualRefresh: isManualRefresh,
    });
    void runCompute(preparedState, runKey);
    return undefined;
  }, [preparedState, manualRefreshNonce, analysis.live, analysis.id, result, runCompute, loading, error, backendUnavailable]);

  const refresh = useCallback(() => {
    graphComputeClient.clearCache();
    try { (window as any).__dagnetComputeNoCacheOnce = true; } catch { /* ignore */ }
    logChartReadinessTrace('CanvasScheduler:manual-refresh', {
      analysisId: analysis.id,
      analysisType,
      currentNonce: manualRefreshNonce,
    });
    setManualRefreshNonce((value) => value + 1);
  }, [analysis.id, analysisType, manualRefreshNonce]);

  return { result, loading, waitingForDeps, error, backendUnavailable, refresh };
}
