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
import { getActiveContentItem } from '../utils/canvasAnalysisAccessors';
import { isChartComputeReady } from '../services/chartHydrationService';
import {
  prepareAnalysisComputeInputs,
  runPreparedAnalysis,
  type PreparedAnalysisComputeReady,
  type PreparedAnalysisComputeState,
} from '../services/analysisComputePreparationService';
import {
  registerCanvasAnalysisRefresh,
  unregisterCanvasAnalysisRefresh,
} from '../services/canvasAnalysisRefreshRegistry';

const DEBOUNCE_MS = 2000;

interface UseCanvasAnalysisComputeParams {
  analysis: CanvasAnalysis;
  tabId?: string;
  /** Index of the active content tab — compute uses this tab's DSL, type, kind. */
  activeContentIndex?: number;
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
/** Per-content-item result cache — used when a tab carries its own result
 *  (e.g. snapped-in from hover preview with a different analysis type).
 *  Keyed by content item UUID. */
export const contentItemResultCache = new Map<string, AnalysisResult>();

export function useCanvasAnalysisCompute({
  analysis: analysisProp,
  tabId,
  activeContentIndex,
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

  const contentItem = (activeContentIndex != null && analysis.content_items?.[activeContentIndex])
    ? analysis.content_items[activeContentIndex]
    : getActiveContentItem(analysis);

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

  // On tab switch, instantly restore per-item cached result (avoids full re-compute).
  // Sets cacheSeededRef so the run effect skips the next compute cycle.
  const contentItemId = contentItem?.id;
  const cacheSeededRef = useRef(false);
  useEffect(() => {
    if (!contentItemId) return;
    const cached = contentItemResultCache.get(contentItemId);
    if (cached) {
      setResult(cached);
      setLoading(false);
      setError(null);
      cacheSeededRef.current = true;
    }
  }, [contentItemId]);
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

  // Per-tab properties take priority over container-level properties
  // (Legacy flat fields like mode, analysis.recipe, analysis.display are
  //  stripped by stripLegacyContainerFields — content items are the authority.)
  const mode = contentItem?.mode || 'live';
  const chartKind = contentItem?.kind || (analysis as any).chart_kind;
  const isTimeSeriesChartKind = chartKind === 'time_series';
  const analysisType = contentItem?.analysis_type || (analysis as any)?.recipe?.analysis?.analysis_type;
  const expectsTimeSeriesBranchResult =
    analysisType === 'branch_comparison'
    && isTimeSeriesChartKind;
  const analyticsDsl = contentItem?.analytics_dsl || (analysis as any)?.recipe?.analysis?.analytics_dsl || '';
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
  const chartKindNeedsSnapshots = !contentItem.kind || SNAPSHOT_REQUIRING_CHART_KINDS.has(contentItem.kind);
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
        propAnalysisType: analysisProp.content_items?.[0]?.analysis_type,
        propChartKind: analysisProp.content_items?.[0]?.kind,
        storeAnalysisType: analysis.content_items?.[0]?.analysis_type,
        storeChartKind: chartKind,
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
      console.warn(`[SnapshotRetry] ${analysis.id} (${analysisType}×${chartKind}): empty snapshot result after retry — giving up.`, {
        resultDescription: result.analysis_description,
        metadata: result.metadata,
      });
      return;
    }

    console.log(`[SnapshotRetry] ${analysis.id} (${analysisType}×${chartKind}): empty snapshot result — scheduling retry in 2s.`, {
      resultDescription: result.analysis_description,
      metadata: result.metadata,
      preparedSignature: preparedSignatureRef.current,
    });

    const timer = setTimeout(() => {
      if (!mountedRef.current) return;
      snapshotEmptyRetryCountRef.current += 1;
      console.log(`[SnapshotRetry] ${analysis.id} (${analysisType}×${chartKind}): executing retry now.`);
      completedRunKeyRef.current = null;
      preparedSignatureRef.current = null; // Force full re-prepare
      setResult(null);
      canvasAnalysisResultCache.delete(analysis.id);
      graphComputeClient.clearCache();
      setRegistryVersion((v) => v + 1); // Trigger re-prepare
      setLoading(true);
    }, 2000);

    return () => clearTimeout(timer);
  }, [needsSnapshots, result, analysis.id, analysisType, chartKind]);

  // Reset snapshot empty retry counter when the analysis changes
  useEffect(() => {
    snapshotEmptyRetryCountRef.current = 0;
  }, [analysisType, chartKind]);

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
      chartKind: chartKind,
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
    chartKind,
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
      live: mode === 'live',
      scenarioState: mode === 'live' ? rawScenarioState : scenarioState,
      scenariosReady: scenariosContext ? Boolean((scenariosContext as any).scenariosReady) : false,
      customScenarios: contentItem?.scenarios || null,
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
        chartKind: chartKind,
        mode,
        manualRefreshNonce,
        registryVersion,
        tabId,
        prepareVersion: thisVersion,
        bootReadyEpoch,
      });
      try {
        const resolveParameterFile = (paramId: string) =>
          fileRegistry.getFile(`parameter-${paramId}`)?.data;
        const nextPreparedState = await prepareAnalysisComputeInputs(
          mode === 'live'
            ? {
                mode: 'live',
                graph: graph as any,
                analysisType,
                analyticsDsl,
                currentDSL,
                chartCurrentLayerDsl: contentItem?.chart_current_layer_dsl,
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
                display: contentItem.display as Record<string, unknown> | undefined,
                resolveParameterFile,
              }
            : (() => {
                // Patch the 'current' underlayer's colour with the live tab value
                // so charts (e.g. bridge) render the correct active colour.
                let customScenarios = contentItem?.scenarios as any;
                if (mode === 'custom' && tabId && customScenarios) {
                  const liveColour = operationsRef.current.getEffectiveScenarioColour(
                    tabId, 'current', scenariosContext as any,
                  );
                  customScenarios = customScenarios.map((s: any) =>
                    s.scenario_id === 'current' ? { ...s, colour: liveColour } : s,
                  );
                }
                return {
                  mode: 'custom',
                  // Doc 73e §8.3 Stage 5 item 1 — fixed recipes carry an
                  // absolute effective DSL that must not be rebased over
                  // currentDSL during preparation. Forward the chart-level
                  // mode here so prepareAnalysisComputeInputs can honour it.
                  analysisMode: mode === 'fixed' ? 'fixed' : 'custom',
                  graph: graph as any,
                  analysisType,
                  analyticsDsl,
                  currentDSL,
                  chartCurrentLayerDsl: contentItem?.chart_current_layer_dsl,
                  needsSnapshots,
                  workspace,
                  customScenarios,
                  hiddenScenarioIds: (((contentItem?.display as any)?.hidden_scenarios) || []) as string[],
                  frozenWhatIfDsl: contentItem?.what_if_dsl,
                  display: contentItem.display as Record<string, unknown> | undefined,
                  resolveParameterFile,
                };
              })(),
        );
        if (!mountedRef.current) return;
        if (thisVersion < lastAppliedPrepareRef.current) return;
        lastAppliedPrepareRef.current = thisVersion;

        const nextSig = nextPreparedState.status === 'ready' ? nextPreparedState.signature : null;
        if (nextSig !== null && nextSig === preparedSignatureRef.current) {
          console.log(`[Compute] SKIP-redundant-prepare ${analysis.id} (${analysisType}×${chartKind})`, {
            signature: nextSig?.slice(0, 16),
          });
          return;
        }
        preparedSignatureRef.current = nextSig;
        if (nextPreparedState.status === 'ready' && needsSnapshots) {
          const scenarios = nextPreparedState.scenarios;
          console.log(`[CanvasAnalysisCompute] snapshot-ready ${analysis.id} (${analysisType}×${chartKind})`, {
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
          console.log(`[CanvasAnalysisCompute] blocked ${analysis.id} (${analysisType}×${chartKind}): ${nextPreparedState.reason}`, {
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
        console.warn(`[CanvasAnalysisCompute] prepare failed for ${analysis.id} (${analysisType}×${chartKind}):`, msg, {
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
    mode,
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
      console.log(`[Compute] BLOCKED ${analysis.id} (${analysisType}×${chartKind}): ${preparedState.reason}`, {
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
  const effectiveScenarioState = mode === 'live' ? rawScenarioState : scenarioState;
  const scenarioStateReady = mode === 'live' ? !!effectiveScenarioState : true;

  const readinessSnapshot = useMemo(() => ({
    analysisId: analysis.id,
    analysisType,
    chartKind: chartKind,
    mode: mode,
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
    chartKind,
    mode,
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
      chartKind: chartKind,
      mode: mode,
      tabId,
      source: 'useCanvasAnalysisCompute',
    });
    logSnapshotBoot('CanvasAnalysisCompute:hook-mount', {
      analysisId: analysis.id,
      analysisType,
      chartKind: chartKind,
      mode: mode,
      tabId,
    });
    return () => {
      recordSnapshotBootLedgerStage('hook-unmounted', {
        analysisId: analysis.id,
        analysisType,
        chartKind: chartKind,
        mode: mode,
        tabId,
        source: 'useCanvasAnalysisCompute',
      });
      logSnapshotBoot('CanvasAnalysisCompute:hook-unmount', {
        analysisId: analysis.id,
        analysisType,
        chartKind: chartKind,
        mode: mode,
        tabId,
      });
    };
  }, [debugSnapshotChart, analysis.id, analysisType, chartKind, mode, tabId]);

  useEffect(() => {
    if (!debugSnapshotChart) return;
    if (preparedState.status === 'blocked') {
      recordSnapshotBootLedgerStage('prepared-blocked', {
        analysisId: analysis.id,
        analysisType,
        chartKind: chartKind,
        mode: mode,
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
      chartKind: chartKind,
      mode: mode,
      tabId,
      signature: preparedState.signature,
      scenarioIds: preparedState.scenarios.map((scenario) => scenario.scenario_id),
      source: 'useCanvasAnalysisCompute',
    });
  }, [debugSnapshotChart, preparedState, analysis.id, analysisType, chartKind, mode, tabId]);

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
        chartKind: chartKind,
        mode: mode,
        tabId,
        scenarioIds: prepared.scenarios.map((scenario) => scenario.scenario_id),
        signature: prepared.signature,
        source: 'useCanvasAnalysisCompute',
      });
      logSnapshotBoot('CanvasAnalysisCompute:compute-start', {
        analysisId: analysis.id,
        analysisType,
        chartKind: chartKind,
        mode: mode,
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
          if (contentItem?.id) contentItemResultCache.set(contentItem.id, augmented.result);
          // Cache for sibling tabs with same analysis_type
          if (analysis.content_items) {
            for (const ci of analysis.content_items) {
              if (ci.analysis_type === analysisType && ci.id !== contentItem?.id) {
                contentItemResultCache.set(ci.id, augmented.result);
              }
            }
          }
        }
      });
      if (thisCompute !== computeCountRef.current || !mountedRef.current) return;

      if (response?.result) {
        completedRunKeyRef.current = runKey;
        console.log(`[Compute] RESULT ${analysis.id} (${analysisType}×${chartKind})`, {
          responseType: response.result.analysis_type,
          dataRows: response.result.data?.length,
          source: (response.result.metadata as any)?.source,
          empty: (response.result.metadata as any)?.empty,
        });
        // DEV: auto-dump full analysis roundtrip to debug/analysis-dumps/
        // Only when console logging is enabled (same toggle as mark/mirror)
        if (import.meta.env.DEV && debugSnapshotChart) {
          try {
            const dumpPayload = {
              ts: new Date().toISOString(),
              analysisId: analysis.id,
              analysisType,
              chartKind,
              analyticsDsl: contentItem?.analytics_dsl || analysis?.recipe?.analysis?.analytics_dsl,
              prepared: {
                signature: prepared.signature?.slice(0, 200),
                scenarios: prepared.scenarios.map((s: any) => ({
                  scenario_id: s.scenario_id,
                  snapshot_subjects: s.snapshot_subjects?.map((sub: any) => ({
                    subject_id: sub.subject_id,
                    param_id: sub.param_id,
                    core_hash: sub.core_hash,
                    read_mode: sub.read_mode,
                    anchor_from: sub.anchor_from,
                    anchor_to: sub.anchor_to,
                    sweep_from: sub.sweep_from,
                    sweep_to: sub.sweep_to,
                    slice_keys: sub.slice_keys,
                    canonical_signature: typeof sub.canonical_signature === 'string' ? sub.canonical_signature.slice(0, 80) + '…' : sub.canonical_signature,
                  })),
                })),
              },
              cachedResult: response.result,
            };
            fetch(`/__dagnet/analysis-dump`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(dumpPayload),
            }).catch(() => { /* ignore */ });
          } catch { /* ignore */ }
        }
        if (debugSnapshotChart) {
          recordSnapshotBootLedgerStage('compute-success', {
            analysisId: analysis.id,
            analysisType,
            chartKind: chartKind,
            mode: mode,
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
        // Cache per content item so tab switches can restore instantly.
        // Also cache for ALL sibling content items with the same analysis_type —
        // they share one compute result (e.g. all edge_info card tabs).
        if (contentItem?.id) contentItemResultCache.set(contentItem.id, response.result);
        if (analysis.content_items) {
          for (const ci of analysis.content_items) {
            if (ci.analysis_type === analysisType && ci.id !== contentItem?.id) {
              contentItemResultCache.set(ci.id, response.result);
            }
          }
        }
        setError(null);
      } else {
        completedRunKeyRef.current = runKey;
        const beErr = (response as any)?.error;
        console.warn(`[Compute] NO-RESULT ${analysis.id} (${analysisType}×${chartKind})`, beErr ? { error: beErr } : undefined);
        setError(beErr || 'No result returned from compute');
      }
    } catch (err: any) {
      if (thisCompute !== computeCountRef.current || !mountedRef.current) return;
      const msg = err?.message || String(err);
      completedRunKeyRef.current = runKey;
      console.error(`[Compute] ERROR ${analysis.id} (${analysisType}×${chartKind}):`, msg);
      if (debugSnapshotChart) {
        recordSnapshotBootLedgerStage('compute-error', {
          analysisId: analysis.id,
          analysisType,
          chartKind: chartKind,
          mode: mode,
          tabId,
          message: msg,
          source: 'useCanvasAnalysisCompute',
        });
        logSnapshotBoot('CanvasAnalysisCompute:compute-error', {
          analysisId: analysis.id,
          analysisType,
          chartKind: chartKind,
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
  }, [analysis.id, mode, chartKind, analysisType, debugSnapshotChart, tabId]);

  useEffect(() => {
    if (preparedState.status !== 'ready') return;

    const runKey = `${preparedState.signature}|refresh:${manualRefreshNonce}`;
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if ((seededTransientResultRef.current || cacheSeededRef.current) && result && manualRefreshNonce === 0) {
      seededTransientResultRef.current = false;
      cacheSeededRef.current = false;
      canvasAnalysisResultCache.set(analysis.id, result);
      console.log(`[Compute] SKIP-seeded ${analysis.id} (${analysisType}×${chartKind})`);
      return;
    }

    const activeRunKey = activeRunKeyRef.current;
    const completedRunKey = completedRunKeyRef.current;
    // A run counts as settled if it ran to completion for this runKey,
    // regardless of whether it produced a result or errored. Retrying on
    // error without a dependency change creates a tight retry loop
    // (setError triggers useEffect → retry → setError → ...). Manual
    // refresh or dependency change is required to re-run after an error.
    const hasSettledCurrentResult = completedRunKey === runKey
      && !loading
      && !backendUnavailable
      && (!!result || !!error);
    if (activeRunKey === runKey || hasSettledCurrentResult) {
      console.log(`[Compute] SKIP-dup ${analysis.id} (${analysisType}×${chartKind})`, {
        activeMatch: activeRunKey === runKey,
        settled: hasSettledCurrentResult,
        hasResult: !!result,
        hasError: !!error,
      });
      return;
    }

    const isManualRefresh = manualRefreshNonce > 0;
    // Only debounce when re-computing the SAME analysis type (e.g., graph changed).
    // Don't debounce when the analysis type changed (tab switch) — the user needs
    // the new result now, not in 2s.
    const resultMatchesCurrentType = result?.analysis_type === analysisType;
    const shouldDebounce = mode === 'live' && resultMatchesCurrentType && !isManualRefresh;

    if (shouldDebounce) {
      console.log(`[Compute] DEBOUNCE ${analysis.id} (${analysisType}×${chartKind}) ${DEBOUNCE_MS}ms`);
      // Don't set loading=true — we already have a result to show during the debounce.
      // The stale result is better than a loading flash.
      debounceRef.current = setTimeout(() => {
        void runCompute(preparedState, runKey);
      }, DEBOUNCE_MS);
      return () => {
        if (debounceRef.current) clearTimeout(debounceRef.current);
      };
    }

    console.log(`[Compute] RUN ${analysis.id} (${analysisType}×${chartKind})`, {
      signature: preparedState.signature?.slice(0, 16),
      manualRefresh: isManualRefresh,
      needsSnapshots,
    });
    void runCompute(preparedState, runKey);
    return undefined;
  }, [preparedState, manualRefreshNonce, mode, analysis.id, result, runCompute, loading, error, backendUnavailable]);

  const refresh = useCallback(() => {
    graphComputeClient.clearCache();
    try { (window as any).__dagnetComputeNoCacheOnce = true; } catch { /* ignore */ }
    canvasAnalysisResultCache.delete(analysis.id);
    canvasAnalysisTransientCache.delete(analysis.id);
    if (analysis.content_items) {
      for (const ci of analysis.content_items) {
        if (ci?.id) contentItemResultCache.delete(ci.id);
      }
    }
    cacheSeededRef.current = false;
    seededTransientResultRef.current = false;
    logChartReadinessTrace('CanvasScheduler:manual-refresh', {
      analysisId: analysis.id,
      analysisType,
      currentNonce: manualRefreshNonce,
    });
    setManualRefreshNonce((value) => value + 1);
  }, [analysis.id, analysis.content_items, analysisType, manualRefreshNonce]);

  useEffect(() => {
    registerCanvasAnalysisRefresh(analysis.id, refresh);
    return () => unregisterCanvasAnalysisRefresh(analysis.id, refresh);
  }, [analysis.id, refresh]);

  return { result, loading, waitingForDeps, error, backendUnavailable, refresh };
}
