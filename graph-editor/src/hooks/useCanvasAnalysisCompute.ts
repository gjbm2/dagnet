/**
 * useCanvasAnalysisCompute
 *
 * Encapsulates all compute logic for a canvas analysis node:
 * - Live mode: reads graph + scenarios from context, debounced recompute
 * - Frozen mode: computes once on mount from recipe.scenarios
 * - Handles loading / error / backend-unavailable states
 */

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useGraphStore } from '../contexts/GraphStoreContext';
import { useScenariosContextOptional } from '../contexts/ScenariosContext';
import { useTabContext } from '../contexts/TabContext';
import { graphComputeClient, type AnalysisResult } from '../lib/graphComputeClient';
import { buildGraphForAnalysisLayer } from '../services/CompositionService';
import { ANALYSIS_TYPES } from '../components/panels/analysisTypes';
import { resolveSnapshotSubjectsForScenario } from '../services/snapshotSubjectResolutionService';
import { augmentDSLWithConstraint } from '../lib/queryDSL';
import { fileRegistry } from '../contexts/TabContext';
import type { CanvasAnalysis } from '../types';
import { isChartComputeReady } from '../services/chartHydrationService';

const DEBOUNCE_MS = 2000;

interface UseCanvasAnalysisComputeParams {
  analysis: CanvasAnalysis;
  tabId?: string;
}

interface UseCanvasAnalysisComputeResult {
  result: AnalysisResult | null;
  loading: boolean;
  waitingForDeps: boolean;
  error: string | null;
  backendUnavailable: boolean;
  refresh: () => void;
}

/**
 * Transient cache for instant first render after DnD.
 * Key: analysis.id, Value: AnalysisResult.
 * Entries are consumed once and deleted.
 */
export const canvasAnalysisTransientCache = new Map<string, AnalysisResult>();

/**
 * Shared result cache: latest compute result per analysis ID.
 * Written by the compute hook on each successful compute.
 * Read by the properties panel for result-driven UI (e.g. chart kind options).
 */
export const canvasAnalysisResultCache = new Map<string, AnalysisResult>();

export function useCanvasAnalysisCompute({
  analysis: analysisProp,
  tabId,
}: UseCanvasAnalysisComputeParams): UseCanvasAnalysisComputeResult {
  const { graph, currentDSL } = useGraphStore();
  const scenariosContext = useScenariosContextOptional();
  const { tabs, operations } = useTabContext();

  // Read the latest analysis from the graph store (not from stale ReactFlow node data)
  // This ensures changes from the properties panel are picked up immediately
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

  const debounceRef = useRef<NodeJS.Timeout | null>(null);
  const mountedRef = useRef(true);
  const computeCountRef = useRef(0);

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

  // IMPORTANT:
  // `operations.getScenarioState(tabId)` returns a synthetic default state (`['current']`)
  // when the real tab scenario state has not loaded yet. That is correct for general callers
  // but WRONG for chart boot, because it lets live charts compute too early against a fake
  // single-scenario state, then later flip once the real multi-scenario state arrives.
  //
  // For readiness gating we must distinguish:
  // - "real tab state is present" from
  // - "TabContext handed us a default fallback".
  const rawScenarioState = useMemo(() => {
    if (!tabId) return null;
    return currentTab?.editorState?.scenarioState ?? null;
  }, [tabId, currentTab]);

  const scenarioState = useMemo(() => {
    if (!tabId) return null;
    return operations.getScenarioState(tabId);
  }, [tabId, operations, tabs]);

  const whatIfDSL = currentTab?.editorState?.whatIfDSL || null;

  const getWorkspace = useCallback(() => {
    const graphFile = currentTab?.fileId ? fileRegistry.getFile(currentTab.fileId) : undefined;
    const repository = graphFile?.source?.repository;
    const branch = graphFile?.source?.branch;
    return (repository && branch) ? { repository, branch } : undefined;
  }, [currentTab?.fileId]);

  const chartFragment = analysis.chart_current_layer_dsl || '';

  const getQueryDslForScenario = useCallback((scenarioId: string): string => {
    let baseDslForScenario: string;
    if (scenarioId === 'current') {
      baseDslForScenario = currentDSL || '';
    } else if (scenarioId === 'base') {
      const bd = scenariosContext?.baseDSL || (graph as any)?.baseDSL;
      baseDslForScenario = typeof bd === 'string' ? bd : currentDSL || '';
    } else {
      const scenario = scenariosContext?.scenarios?.find((s: any) => s.id === scenarioId);
      const meta: any = scenario?.meta;
      if (meta?.isLive && typeof meta.lastEffectiveDSL === 'string' && meta.lastEffectiveDSL.trim()) {
        baseDslForScenario = meta.lastEffectiveDSL;
      } else {
        baseDslForScenario = currentDSL || '';
      }
    }
    if (chartFragment.trim()) {
      return augmentDSLWithConstraint(baseDslForScenario, chartFragment);
    }
    return baseDslForScenario;
  }, [currentDSL, scenariosContext, graph, chartFragment]);

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

  const compute = useCallback(async () => {
    if (!graph || !graph.nodes || !graph.edges) return;

    const thisCompute = ++computeCountRef.current;
    setLoading(true);
    setBackendUnavailable(false);

    try {
      const analysisType = analysis.recipe.analysis.analysis_type;
      const analyticsDsl = analysis.recipe.analysis.analytics_dsl || '';
      const snapshotMeta = ANALYSIS_TYPES.find(t => t.id === analysisType);
      const needsSnapshots = !!snapshotMeta?.snapshotContract;
      const workspace = getWorkspace();

      let response;

      if (analysis.live) {
        // Live mode: read from current tab state
        const visibleIds = scenarioState?.visibleScenarioIds || ['current'];

        if (visibleIds.length > 1 && scenariosContext) {
          const scenarioGraphs = await Promise.all(visibleIds.map(async (scenarioId) => {
            const visibilityMode = tabId
              ? operations.getScenarioVisibilityMode(tabId, scenarioId)
              : 'f+e' as const;

            const scenarioGraph = buildGraphForAnalysisLayer(
              scenarioId,
              graph as any,
              (scenariosContext as any).baseParams || {},
              (scenariosContext as any).currentParams || {},
              (scenariosContext as any).scenarios || [],
              scenarioId === 'current' ? whatIfDSL : undefined,
              visibilityMode,
            );

            const colour = getScenarioColour(scenarioId);
            const effectiveDsl = needsSnapshots ? analyticsDsl : getQueryDslForScenario(scenarioId);

            let snapshotSubjects;
            if (needsSnapshots && workspace) {
              const resolved = await resolveSnapshotSubjectsForScenario({
                scenarioGraph,
                analyticsDsl,
                scenarioId,
                analysisType,
                workspace,
                getQueryDslForScenario,
              });
              snapshotSubjects = resolved.subjects;
            }

            return {
              scenario_id: scenarioId,
              name: getScenarioName(scenarioId),
              graph: scenarioGraph,
              colour,
              visibility_mode: visibilityMode,
              snapshot_subjects: snapshotSubjects,
            };
          }));

          response = await graphComputeClient.analyzeMultipleScenarios(
            scenarioGraphs as any,
            analyticsDsl || currentDSL,
            analysisType,
          );
        } else {
          const scenarioId = visibleIds[0] || 'current';
          const visibilityMode = tabId
            ? operations.getScenarioVisibilityMode(tabId, scenarioId)
            : 'f+e' as const;

          const analysisGraph = buildGraphForAnalysisLayer(
            scenarioId,
            graph as any,
            (scenariosContext as any)?.baseParams || {},
            (scenariosContext as any)?.currentParams || {},
            (scenariosContext as any)?.scenarios || [],
            scenarioId === 'current' ? whatIfDSL : undefined,
            visibilityMode,
          );

          let snapshotSubjects;
          if (needsSnapshots && workspace) {
            const resolved = await resolveSnapshotSubjectsForScenario({
              scenarioGraph: analysisGraph,
              analyticsDsl,
              scenarioId,
              analysisType,
              workspace,
              getQueryDslForScenario,
            });
            snapshotSubjects = resolved.subjects;
          }

          const finalDsl = analyticsDsl || currentDSL;
          response = await graphComputeClient.analyzeSelection(
            analysisGraph,
            finalDsl,
            scenarioId,
            getScenarioName(scenarioId),
            getScenarioColour(scenarioId),
            analysisType,
            visibilityMode,
            snapshotSubjects,
          );
        }
      } else {
        // Custom mode: compute from recipe.scenarios but use the SAME graph
        // composition as live mode so results are identical.
        const frozenScenariosAll = analysis.recipe.scenarios || [];
        const hiddenScenarios = new Set<string>((((analysis.display as any)?.hidden_scenarios) || []) as string[]);
        const frozenScenariosVisible = frozenScenariosAll.filter((fs: any) => !hiddenScenarios.has(fs.scenario_id));
        const frozenScenarios = frozenScenariosVisible.length > 0
          ? frozenScenariosVisible
          : frozenScenariosAll;
        const frozenWhatIfDsl = analysis.recipe.analysis.what_if_dsl;
        const frozenDsl = analyticsDsl || currentDSL;

        if (frozenScenarios.length > 1) {
          const scenarioGraphs = await Promise.all(frozenScenarios.map(async (fs: any) => {
            const scenarioGraph = scenariosContext
              ? buildGraphForAnalysisLayer(
                  fs.scenario_id,
                  graph as any,
                  (scenariosContext as any).baseParams || {},
                  (scenariosContext as any).currentParams || {},
                  (scenariosContext as any).scenarios || [],
                  fs.scenario_id === 'current' ? frozenWhatIfDsl : undefined,
                  (fs.visibility_mode || 'f+e') as 'f+e' | 'f' | 'e',
                )
              : graph;

            let snapshotSubjects;
            if (needsSnapshots && workspace) {
              const resolved = await resolveSnapshotSubjectsForScenario({
                scenarioGraph,
                analyticsDsl,
                scenarioId: fs.scenario_id,
                analysisType,
                workspace,
                getQueryDslForScenario,
              });
              snapshotSubjects = resolved.subjects;
            }

            return {
              scenario_id: fs.scenario_id,
              name: fs.name || fs.scenario_id,
              graph: scenarioGraph,
              colour: fs.colour || '#808080',
              visibility_mode: fs.visibility_mode || 'f+e' as const,
              ...(snapshotSubjects?.length ? { snapshot_subjects: snapshotSubjects } : {}),
            };
          }));

          response = await graphComputeClient.analyzeMultipleScenarios(
            scenarioGraphs as any,
            frozenDsl,
            analysisType,
          );
        } else {
          const fs = frozenScenarios[0] || { scenario_id: 'current' };
          const scenarioGraph = scenariosContext
            ? buildGraphForAnalysisLayer(
                fs.scenario_id,
                graph as any,
                (scenariosContext as any).baseParams || {},
                (scenariosContext as any).currentParams || {},
                (scenariosContext as any).scenarios || [],
                fs.scenario_id === 'current' ? frozenWhatIfDsl : undefined,
                (fs.visibility_mode || 'f+e') as 'f+e' | 'f' | 'e',
              )
            : graph;

          let snapshotSubjects;
          if (needsSnapshots && workspace) {
            const resolved = await resolveSnapshotSubjectsForScenario({
              scenarioGraph,
              analyticsDsl,
              scenarioId: fs.scenario_id,
              analysisType,
              workspace,
              getQueryDslForScenario,
            });
            snapshotSubjects = resolved.subjects;
          }

          response = await graphComputeClient.analyzeSelection(
            scenarioGraph,
            frozenDsl,
            fs.scenario_id,
            fs.name || 'Current',
            fs.colour || '#3b82f6',
            analysisType,
            (fs.visibility_mode || 'f+e') as 'f+e' | 'f' | 'e',
            snapshotSubjects,
          );
        }
      }

      if (thisCompute !== computeCountRef.current || !mountedRef.current) return;

      if (response?.result) {
        setResult(response.result);
        canvasAnalysisResultCache.set(analysis.id, response.result);
        setError(null);
      } else {
        setError('No result returned from compute');
      }
    } catch (err: any) {
      if (thisCompute !== computeCountRef.current || !mountedRef.current) return;

      const msg = err?.message || String(err);
      if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('ECONNREFUSED')) {
        setBackendUnavailable(true);
      } else {
        setError(msg);
      }
    } finally {
      if (thisCompute === computeCountRef.current && mountedRef.current) {
        setLoading(false);
      }
    }
  }, [
    graph, currentDSL, analysis, scenariosContext, scenarioState, whatIfDSL,
    tabId, operations, getWorkspace, getQueryDslForScenario,
    getScenarioColour, getScenarioName,
  ]);

  // Store compute in a ref so effects can call it without depending on it
  const computeRef = useRef(compute);
  computeRef.current = compute;

  const computeReady = useMemo(() => {
    return isChartComputeReady({
      graph: graph as any,
      analysisType: analysis?.recipe?.analysis?.analysis_type,
      live: analysis.live,
      scenarioState: analysis.live ? rawScenarioState : scenarioState,
      scenariosReady: scenariosContext ? Boolean((scenariosContext as any).scenariosReady) : false,
      customScenarios: analysis.recipe?.scenarios || null,
    });
  }, [graph, analysis, rawScenarioState, scenarioState, scenariosContext]);

  const waitingForDeps = !computeReady && !error && !backendUnavailable;

  // Live mode: stable compute key based only on compute-relevant inputs
  const liveComputeKey = useMemo(() => {
    if (!analysis.live) return null;
    const visibleIds = rawScenarioState?.visibleScenarioIds || [];
    return [
      analysis.recipe?.analysis?.analysis_type,
      analysis.recipe?.analysis?.analytics_dsl,
      analysis.chart_current_layer_dsl,
      currentDSL,
      whatIfDSL,
      visibleIds.join(','),
      graph?.nodes?.length,
      graph?.edges?.length,
    ].join('|');
  }, [analysis.live, analysis.recipe?.analysis?.analysis_type, analysis.recipe?.analysis?.analytics_dsl,
      analysis.chart_current_layer_dsl, currentDSL, whatIfDSL, rawScenarioState, graph?.nodes?.length, graph?.edges?.length]);

  // Custom mode: stable compute key
  const frozenComputeKey = useMemo(() => {
    if (analysis.live) return null;
    const scenarios = analysis.recipe?.scenarios || [];
    return [
      analysis.recipe?.analysis?.analysis_type,
      analysis.recipe?.analysis?.analytics_dsl,
      analysis.recipe?.analysis?.what_if_dsl,
      analysis.chart_current_layer_dsl,
      scenarios.map((s: any) => `${s.scenario_id}:${s.effective_dsl || ''}:${s.visibility_mode || 'f+e'}`).join(','),
      ((analysis.display as any)?.hidden_scenarios || []).join(','),
    ].join('|');
  }, [analysis]);

  // Live mode: recompute when liveComputeKey changes.
  // Skip debounce if no result yet (first load / F5 — compute immediately).
  useEffect(() => {
    if (!analysis.live) return;
    if (!computeReady) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!result) {
      computeRef.current();
      return;
    }
    debounceRef.current = setTimeout(() => {
      computeRef.current();
    }, DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveComputeKey]);

  // Custom mode: recompute when frozenComputeKey changes
  useEffect(() => {
    if (analysis.live) return;
    if (!computeReady) return;
    computeRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frozenComputeKey, computeReady]);

  // Retry: if we still have no result after graph becomes available, compute.
  const resultRef = useRef(result);
  resultRef.current = result;
  useEffect(() => {
    if (result) return;
    if (!computeReady) return;
    const timer = setTimeout(() => {
      if (!resultRef.current) computeRef.current();
    }, 500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [computeReady, result]);

  return { result, loading, waitingForDeps, error, backendUnavailable, refresh: compute };
}
