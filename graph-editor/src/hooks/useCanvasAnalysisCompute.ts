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

const DEBOUNCE_MS = 2000;

interface UseCanvasAnalysisComputeParams {
  analysis: CanvasAnalysis;
  tabId?: string;
}

interface UseCanvasAnalysisComputeResult {
  result: AnalysisResult | null;
  loading: boolean;
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
    if (!graph) return;

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
              (scenariosContext as any).baseParams,
              (scenariosContext as any).currentParams,
              (scenariosContext as any).scenarios,
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
        // Frozen mode: compute from recipe.scenarios
        // Each scenario has its own effective_dsl; compose chart fragment onto each.
        const frozenScenariosAll = analysis.recipe.scenarios || [];
        const hiddenScenarios = new Set<string>((((analysis.display as any)?.hidden_scenarios) || []) as string[]);
        const frozenScenariosVisible = frozenScenariosAll.filter((fs: any) => !hiddenScenarios.has(fs.scenario_id));
        const frozenScenarios = frozenScenariosVisible.length > 0
          ? frozenScenariosVisible
          : frozenScenariosAll;
        const frozenWhatIfDsl = analysis.recipe.analysis.what_if_dsl;

        const getDslForFrozenScenario = (): string => {
          return analyticsDsl || currentDSL;
        };

        if (frozenScenarios.length > 1) {
          const allHaveSameDsl = frozenScenarios.every((fs: any) =>
            (fs.effective_dsl || '') === (frozenScenarios[0].effective_dsl || ''));

          if (allHaveSameDsl) {
            const scenarioGraphs = frozenScenarios.map((fs: any) => ({
              scenario_id: fs.scenario_id,
              name: fs.name || fs.scenario_id,
              graph: graph,
              colour: fs.colour,
              visibility_mode: fs.visibility_mode || 'f+e' as const,
            }));
            response = await graphComputeClient.analyzeMultipleScenarios(
              scenarioGraphs as any,
              getDslForFrozenScenario(frozenScenarios[0]),
              analysisType,
            );
          } else {
            const perScenarioResults = await Promise.all(
              frozenScenarios.map(async (fs: any) => {
                const scenarioDsl = getDslForFrozenScenario(fs);
                const res = await graphComputeClient.analyzeSelection(
                  graph,
                  scenarioDsl,
                  fs.scenario_id,
                  fs.name || fs.scenario_id,
                  fs.colour || '#808080',
                  analysisType,
                  (fs.visibility_mode || 'f+e') as 'f+e' | 'f' | 'e',
                );
                return res;
              }),
            );
            const mergedData: any[] = [];
            const mergedDimValues: any = {};
            for (const res of perScenarioResults) {
              if (res?.result?.data) mergedData.push(...res.result.data);
              if (res?.result?.dimension_values) {
                for (const [dim, vals] of Object.entries(res.result.dimension_values)) {
                  if (!mergedDimValues[dim]) mergedDimValues[dim] = {};
                  Object.assign(mergedDimValues[dim], vals);
                }
              }
            }
            const firstResult = perScenarioResults.find(r => r?.result)?.result;
            response = {
              result: firstResult ? {
                ...firstResult,
                data: mergedData,
                dimension_values: mergedDimValues,
              } : undefined,
            };
          }
        } else {
          const fs = frozenScenarios[0] || { scenario_id: 'current' };
          response = await graphComputeClient.analyzeSelection(
            graph,
            getDslForFrozenScenario(fs),
            fs.scenario_id,
            fs.name || 'Current',
            fs.colour || '#3b82f6',
            analysisType,
            (fs.visibility_mode || 'f+e') as 'f+e' | 'f' | 'e',
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

  // Live mode: debounced recompute when deps change
  useEffect(() => {
    if (!analysis.live) return;

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      compute();
    }, DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [compute, analysis.live]);

  const frozenComputeKey = useMemo(() => {
    if (analysis.live) return null;
    return [
      analysis.recipe?.analysis?.analysis_type,
      analysis.recipe?.analysis?.analytics_dsl,
      analysis.chart_current_layer_dsl,
      analysis.recipe?.scenarios?.map((s: any) => s.scenario_id).join(','),
      ((analysis.display as any)?.hidden_scenarios || []).join(','),
    ].join('|');
  }, [analysis]);

  useEffect(() => {
    if (analysis.live) return;
    compute();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frozenComputeKey]);

  // Compute on first mount for live mode too (immediate, no debounce)
  useEffect(() => {
    if (!analysis.live) return;
    if (!result) compute();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { result, loading, error, backendUnavailable, refresh: compute };
}
