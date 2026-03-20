import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useGraphStore } from '../contexts/GraphStoreContext';
import { useScenariosContextOptional } from '../contexts/ScenariosContext';
import { useTabContext, useFileState, fileRegistry } from '../contexts/TabContext';
import { useAnalysisBootContext } from '../contexts/AnalysisBootContext';
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

  const bootContext = useAnalysisBootContext();
  const bootReady = bootContext?.bootReady ?? true;
  const bootReadyEpoch = bootContext?.bootReadyEpoch ?? 0;

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
  const timeSeriesRetryCountRef = useRef(0);
  const snapshotEmptyRetryCountRef = useRef(0);

  const isTimeSeriesChartKind = analysis?.chart_kind === 'time_series';
  const expectsTimeSeriesBranchResult =
    analysis?.recipe?.analysis?.analysis_type === 'branch_comparison'
    && isTimeSeriesChartKind;
  const analysisType = analysis?.recipe?.analysis?.analysis_type;
  const analyticsDsl = analysis?.recipe?.analysis?.analytics_dsl || '';
  const snapshotMeta = useMemo(
    () => ANALYSIS_TYPES.find(t => t.id === analysisType),
    [analysisType],
  );
  // Snapshot data is only needed when chart_kind will actually consume it.
  // When chart_kind is a standard path_runner kind (funnel, bridge, bar_grouped, etc.),
  // the backend computes without snapshots — no point blocking on snapshot resolution.
  // Snapshot-requiring chart kinds: 'time_series' (comparison types), the snapshot
  // type IDs themselves (daily_conversions, cohort_maturity, lag_histogram, lag_fit),
  // and 'histogram' (the chart kind used by lag_histogram's dedicated builder).
  const SNAPSHOT_REQUIRING_CHART_KINDS = useMemo(
    () => new Set([
      'time_series',
      'histogram',
      ...ANALYSIS_TYPES.filter(t => t.snapshotContract).map(t => t.id),
    ]),
    [],
  );
  const chartKindNeedsSnapshots = !analysis.chart_kind || SNAPSHOT_REQUIRING_CHART_KINDS.has(analysis.chart_kind);
  const needsSnapshots = !!snapshotMeta?.snapshotContract && chartKindNeedsSnapshots;
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
      // Result is in bar/pie format but we expect time_series — likely a stale
      // cache entry from before snapshot data was available. Clear all caches
      // and retry once. Only retry if data is non-empty (empty = genuinely no data).
      const hasNonEmptyData = Array.isArray(result.data) && result.data.length > 0;
      if (hasNonEmptyData && timeSeriesRetryCountRef.current < 1) {
        timeSeriesRetryCountRef.current += 1;
        completedRunKeyRef.current = null;
        setResult(null);
        canvasAnalysisResultCache.delete(analysis.id);
        graphComputeClient.clearCache();
        setLoading(true);
      }
    }
    if (!expectsTimeSeriesBranchResult) {
      // Reset retry counter when chart kind changes away from time_series
      timeSeriesRetryCountRef.current = 0;
    }
  }, [expectsTimeSeriesBranchResult, result, resultHasTimeDimension, analysis.id]);

  // Retry once (after a delay) when a snapshot chart returns an empty result.
  // The first compute may fire before all planner input files are fully hydrated,
  // producing snapshot subjects with stale signatures. A delayed retry gives
  // FileRegistry time to stabilise, allowing re-preparation with correct data.
  useEffect(() => {
    if (!needsSnapshots) return;
    if (!result) return;
    const isEmpty = (result.metadata as any)?.empty === true
      && (result.metadata as any)?.source === 'snapshot_db';
    if (!isEmpty) return;
    if (snapshotEmptyRetryCountRef.current >= 1) {
      console.warn(`[SnapshotRetry] ${analysis.id} (${analysisType}×${analysis.chart_kind}): empty snapshot result after retry — giving up.`, {
        resultDescription: result.analysis_description,
        metadata: result.metadata,
      });
      return;
    }

    console.log(`[SnapshotRetry] ${analysis.id} (${analysisType}×${analysis.chart_kind}): empty snapshot result — scheduling retry in 2s.`, {
      resultDescription: result.analysis_description,
      metadata: result.metadata,
      preparedSignature: preparedSignatureRef.current,
    });

    const timer = setTimeout(() => {
      if (!mountedRef.current) return;
      snapshotEmptyRetryCountRef.current += 1;
      console.log(`[SnapshotRetry] ${analysis.id} (${analysisType}×${analysis.chart_kind}): executing retry now.`);
      completedRunKeyRef.current = null;
      preparedSignatureRef.current = null; // Force full re-prepare
      setResult(null);
      canvasAnalysisResultCache.delete(analysis.id);
      graphComputeClient.clearCache();
      setRegistryVersion((v) => v + 1); // Trigger re-prepare
      setLoading(true);
    }, 2000);

    return () => clearTimeout(timer);
  }, [needsSnapshots, result, analysis.id, analysisType, analysis.chart_kind]);

  // Reset snapshot empty retry counter when the analysis changes
  useEffect(() => {
    snapshotEmptyRetryCountRef.current = 0;
  }, [analysisType, analysis.chart_kind]);

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
      live: analysis.mode === 'live',
      scenarioState: analysis.mode === 'live' ? rawScenarioState : scenarioState,
      scenariosReady: scenariosContext ? Boolean((scenariosContext as any).scenariosReady) : false,
      customScenarios: analysis.recipe?.scenarios || null,
    });
    return baseReady && workspaceReady;
  }, [graph, analysis, analysisType, rawScenarioState, scenarioState, scenariosContext, workspaceReady]);

  const prepareVersionRef = useRef(0);
  const lastAppliedPrepareRef = useRef(0);
  const preparedSignatureRef = useRef<string | null>(null);

  useEffect(() => {
    if (bootContext && !bootReady) return;

    const thisVersion = ++prepareVersionRef.current;

    const prepare = async () => {
      logChartReadinessTrace('CanvasScheduler:prepare-triggered', {
        analysisId: analysis.id,
        analysisType,
        chartKind: analysis.chart_kind,
        mode: analysis.mode,
        manualRefreshNonce,
        registryVersion,
        tabId,
        prepareVersion: thisVersion,
        bootReadyEpoch,
      });
      try {
        const nextPreparedState = await prepareAnalysisComputeInputs(
          analysis.mode === 'live'
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
                display: analysis.display as Record<string, unknown> | undefined,
              }
            : (() => {
                // Patch the 'current' underlayer's colour with the live tab value
                // so charts (e.g. bridge) render the correct active colour.
                let customScenarios = analysis.recipe?.scenarios as any;
                if (analysis.mode === 'custom' && tabId && customScenarios) {
                  const liveColour = operationsRef.current.getEffectiveScenarioColour(
                    tabId, 'current', scenariosContext as any,
                  );
                  customScenarios = customScenarios.map((s: any) =>
                    s.scenario_id === 'current' ? { ...s, colour: liveColour } : s,
                  );
                }
                return {
                  mode: 'custom',
                  graph: graph as any,
                  analysisType,
                  analyticsDsl,
                  currentDSL,
                  chartCurrentLayerDsl: analysis.chart_current_layer_dsl,
                  needsSnapshots,
                  workspace,
                  customScenarios,
                  hiddenScenarioIds: (((analysis.display as any)?.hidden_scenarios) || []) as string[],
                  frozenWhatIfDsl: analysis.recipe?.analysis?.what_if_dsl,
                  display: analysis.display as Record<string, unknown> | undefined,
                };
              })(),
        );
        if (!mountedRef.current) return;
        if (thisVersion < lastAppliedPrepareRef.current) return;
        lastAppliedPrepareRef.current = thisVersion;

        const nextSig = nextPreparedState.status === 'ready' ? nextPreparedState.signature : null;
        if (nextSig !== null && nextSig === preparedSignatureRef.current) {
          console.log(`[Compute] SKIP-redundant-prepare ${analysis.id} (${analysisType}×${analysis.chart_kind})`, {
            signature: nextSig?.slice(0, 16),
          });
          return;
        }
        preparedSignatureRef.current = nextSig;
        if (nextPreparedState.status === 'ready' && needsSnapshots) {
          const scenarios = nextPreparedState.scenarios;
          console.log(`[CanvasAnalysisCompute] snapshot-ready ${analysis.id} (${analysisType}×${analysis.chart_kind})`, {
            signature: nextSig,
            scenarios: scenarios.map(s => ({
              id: s.scenario_id,
              subjectCount: s.snapshot_subjects?.length ?? 0,
              snapshotDsl: s.snapshot_query_dsl,
              subjects: (s.snapshot_subjects || []).map(subj => ({
                subject_id: subj.subject_id,
                param_id: subj.param_id,
                core_hash: subj.core_hash,
                read_mode: subj.read_mode,
                anchor: `${subj.anchor_from}→${subj.anchor_to}`,
                sweep: subj.sweep_from ? `${subj.sweep_from}→${subj.sweep_to}` : undefined,
                slice_keys: subj.slice_keys,
              })),
            })),
          });
        } else if (nextPreparedState.status === 'blocked') {
          console.log(`[CanvasAnalysisCompute] blocked ${analysis.id} (${analysisType}×${analysis.chart_kind}): ${nextPreparedState.reason}`, {
            requiredFileIds: nextPreparedState.requiredFileIds,
            missingFileIds: nextPreparedState.missingFileIds,
            hydratableFileIds: nextPreparedState.hydratableFileIds,
          });
        }
        setPreparedState(nextPreparedState);
      } catch (err: any) {
        if (!mountedRef.current) return;
        if (thisVersion < lastAppliedPrepareRef.current) return;
        lastAppliedPrepareRef.current = thisVersion;
        preparedSignatureRef.current = null;
        const msg = err?.message || String(err);
        console.warn(`[CanvasAnalysisCompute] prepare failed for ${analysis.id} (${analysisType}×${analysis.chart_kind}):`, msg, {
          needsSnapshots,
          workspace,
          analyticsDsl,
          tabId,
        });
        setPreparedState({ status: 'blocked', reason: 'graph_not_ready' });
        setError(msg);
        setLoading(false);
      }
    };

    void prepare();
  }, [
    bootContext,
    bootReady,
    bootReadyEpoch,
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
    if (bootContext && !bootReady) return undefined;
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
  }, [bootContext, bootReady, preparedState]);

  useEffect(() => {
    if (bootContext && !bootReady) return;
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
  }, [bootContext, bootReady, preparedState, workspace]);

  useEffect(() => {
    if (preparedState.status === 'blocked') {
      console.log(`[Compute] BLOCKED ${analysis.id} (${analysisType}×${analysis.chart_kind}): ${preparedState.reason}`, {
        requiredFileIds: preparedState.requiredFileIds?.length,
        missingFileIds: preparedState.missingFileIds?.length,
        hydratableFileIds: preparedState.hydratableFileIds?.length,
      });
      setLoading(false);
    }
  }, [preparedState]);

  const waitingForDeps =
    (bootContext && !bootReady)
    || (preparedState.status === 'blocked' && !error && !backendUnavailable);
  const graphReady = !!(graph && Array.isArray((graph as any).nodes) && Array.isArray((graph as any).edges));
  const analysisReady = typeof analysisType === 'string' && analysisType.trim().length > 0;
  const scenariosCtxReady = scenariosContext ? Boolean((scenariosContext as any).scenariosReady) : false;
  const effectiveScenarioState = analysis.mode === 'live' ? rawScenarioState : scenarioState;
  const scenarioStateReady = analysis.mode === 'live' ? !!effectiveScenarioState : true;

  const readinessSnapshot = useMemo(() => ({
    analysisId: analysis.id,
    analysisType,
    chartKind: analysis.chart_kind,
    mode: analysis.mode,
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
    analysis.mode,
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
      mode: analysis.mode,
      tabId,
      source: 'useCanvasAnalysisCompute',
    });
    logSnapshotBoot('CanvasAnalysisCompute:hook-mount', {
      analysisId: analysis.id,
      analysisType,
      chartKind: analysis.chart_kind,
      mode: analysis.mode,
      tabId,
    });
    return () => {
      recordSnapshotBootLedgerStage('hook-unmounted', {
        analysisId: analysis.id,
        analysisType,
        chartKind: analysis.chart_kind,
        mode: analysis.mode,
        tabId,
        source: 'useCanvasAnalysisCompute',
      });
      logSnapshotBoot('CanvasAnalysisCompute:hook-unmount', {
        analysisId: analysis.id,
        analysisType,
        chartKind: analysis.chart_kind,
        mode: analysis.mode,
        tabId,
      });
    };
  }, [debugSnapshotChart, analysis.id, analysisType, analysis.chart_kind, analysis.mode, tabId]);

  useEffect(() => {
    if (!debugSnapshotChart) return;
    if (preparedState.status === 'blocked') {
      recordSnapshotBootLedgerStage('prepared-blocked', {
        analysisId: analysis.id,
        analysisType,
        chartKind: analysis.chart_kind,
        mode: analysis.mode,
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
      mode: analysis.mode,
      tabId,
      signature: preparedState.signature,
      scenarioIds: preparedState.scenarios.map((scenario) => scenario.scenario_id),
      source: 'useCanvasAnalysisCompute',
    });
  }, [debugSnapshotChart, preparedState, analysis.id, analysisType, analysis.chart_kind, analysis.mode, tabId]);

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
        mode: analysis.mode,
        tabId,
        scenarioIds: prepared.scenarios.map((scenario) => scenario.scenario_id),
        signature: prepared.signature,
        source: 'useCanvasAnalysisCompute',
      });
      logSnapshotBoot('CanvasAnalysisCompute:compute-start', {
        analysisId: analysis.id,
        analysisType,
        chartKind: analysis.chart_kind,
        mode: analysis.mode,
        scenarioIds: prepared.scenarios.map((scenario) => scenario.scenario_id),
        signature: prepared.signature,
      });
    }

    try {
      const response = await runPreparedAnalysis(prepared, (augmented) => {
        // Progressive enhancement: BE augmentation arrived after FE result
        if (thisCompute !== computeCountRef.current || !mountedRef.current) return;
        if (augmented?.result) {
          setResult(augmented.result);
          canvasAnalysisResultCache.set(analysis.id, augmented.result);
        }
      });
      if (thisCompute !== computeCountRef.current || !mountedRef.current) return;

      if (response?.result) {
        completedRunKeyRef.current = runKey;
        console.log(`[Compute] RESULT ${analysis.id} (${analysisType}×${analysis.chart_kind})`, {
          responseType: response.result.analysis_type,
          dataRows: response.result.data?.length,
          source: (response.result.metadata as any)?.source,
          empty: (response.result.metadata as any)?.empty,
        });
        if (debugSnapshotChart) {
          recordSnapshotBootLedgerStage('compute-success', {
            analysisId: analysis.id,
            analysisType,
            chartKind: analysis.chart_kind,
            mode: analysis.mode,
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
        console.warn(`[Compute] NO-RESULT ${analysis.id} (${analysisType}×${analysis.chart_kind})`);
        setError('No result returned from compute');
      }
    } catch (err: any) {
      if (thisCompute !== computeCountRef.current || !mountedRef.current) return;
      const msg = err?.message || String(err);
      completedRunKeyRef.current = runKey;
      console.error(`[Compute] ERROR ${analysis.id} (${analysisType}×${analysis.chart_kind}):`, msg);
      if (debugSnapshotChart) {
        recordSnapshotBootLedgerStage('compute-error', {
          analysisId: analysis.id,
          analysisType,
          chartKind: analysis.chart_kind,
          mode: analysis.mode,
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
  }, [analysis.id, analysis.mode, analysis.chart_kind, analysisType, debugSnapshotChart, tabId]);

  useEffect(() => {
    if (preparedState.status !== 'ready') return;

    const runKey = `${preparedState.signature}|refresh:${manualRefreshNonce}`;
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (seededTransientResultRef.current && result && manualRefreshNonce === 0) {
      seededTransientResultRef.current = false;
      canvasAnalysisResultCache.set(analysis.id, result);
      console.log(`[Compute] SKIP-seeded ${analysis.id} (${analysisType}×${analysis.chart_kind})`);
      return;
    }

    const activeRunKey = activeRunKeyRef.current;
    const completedRunKey = completedRunKeyRef.current;
    const hasSettledCurrentResult = completedRunKey === runKey && !!result && !loading && !error && !backendUnavailable;
    if (activeRunKey === runKey || hasSettledCurrentResult) {
      console.log(`[Compute] SKIP-dup ${analysis.id} (${analysisType}×${analysis.chart_kind})`, {
        activeMatch: activeRunKey === runKey,
        settled: hasSettledCurrentResult,
        hasResult: !!result,
      });
      return;
    }

    const isManualRefresh = manualRefreshNonce > 0;
    const shouldDebounce = analysis.mode === 'live' && !!result && !isManualRefresh;

    if (shouldDebounce) {
      console.log(`[Compute] DEBOUNCE ${analysis.id} (${analysisType}×${analysis.chart_kind}) ${DEBOUNCE_MS}ms`);
      setLoading(true);
      debounceRef.current = setTimeout(() => {
        void runCompute(preparedState, runKey);
      }, DEBOUNCE_MS);
      return () => {
        if (debounceRef.current) clearTimeout(debounceRef.current);
      };
    }

    console.log(`[Compute] RUN ${analysis.id} (${analysisType}×${analysis.chart_kind})`, {
      signature: preparedState.signature?.slice(0, 16),
      manualRefresh: isManualRefresh,
      needsSnapshots,
    });
    void runCompute(preparedState, runKey);
    return undefined;
  }, [preparedState, manualRefreshNonce, analysis.mode, analysis.id, result, runCompute, loading, error, backendUnavailable]);

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
