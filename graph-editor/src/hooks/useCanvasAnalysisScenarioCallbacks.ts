/**
 * useCanvasAnalysisScenarioCallbacks
 *
 * Provides scenario list callbacks for a canvas analysis.
 * Handles Live -> Custom auto-promotion: any mutation in Live mode
 * silently captures from tab, flips to Custom, then applies the edit.
 *
 * Returns a props object that can be spread onto ScenarioLayerList.
 */

import { useCallback, useMemo } from 'react';
import toast from 'react-hot-toast';
import { useTabContext } from '../contexts/TabContext';
import { useGraphStore } from '../contexts/GraphStoreContext';
import { useScenariosContextOptional } from '../contexts/ScenariosContext';
import { captureTabScenariosToRecipe } from '../services/captureTabScenariosService';
import { mutateCanvasAnalysisGraph, advanceMode } from '../services/canvasAnalysisMutationService';
import type { CanvasAnalysis, ContentItem } from '../types';
import type { ScenarioLayerListProps } from '../components/panels/ScenarioLayerList';

type ScenarioCallbacks = Pick<ScenarioLayerListProps,
  'onRename' | 'onColourChange' | 'onDelete' | 'onToggleVisibility' |
  'onCycleMode' | 'onReorder' | 'onEdit' | 'onRefresh' | 'shouldShowRefresh' | 'getEditTooltip'
>;

interface UseCanvasAnalysisScenarioCallbacksArgs {
  analysisId: string;
  analysis: CanvasAnalysis | undefined;
  contentItemIndex?: number;
  graph: any;
  setGraph: (g: any) => void;
  saveHistoryState: (action: string) => void;
  tabId?: string;
  onEditScenarioDsl: (scenarioId: string) => void;
}

export function useCanvasAnalysisScenarioCallbacks({
  analysisId,
  analysis,
  contentItemIndex = 0,
  graph,
  setGraph,
  saveHistoryState,
  tabId,
  onEditScenarioDsl,
}: UseCanvasAnalysisScenarioCallbacksArgs): ScenarioCallbacks {
  const scenariosContext = useScenariosContextOptional();
  const { tabs, operations } = useTabContext();
  const graphStore = useGraphStore();
  const liveTabId = tabId || tabs[0]?.id;
  const activeCI: ContentItem | undefined = analysis?.content_items?.[contentItemIndex] || analysis?.content_items?.[0];

  const captureScenarios = useCallback((): { scenarios: any[]; what_if_dsl?: string } | null => {
    if (!liveTabId || !scenariosContext) return null;
    const currentTab = tabs.find(t => t.id === liveTabId);
    const whatIfDSL = currentTab?.editorState?.whatIfDSL || null;
    return captureTabScenariosToRecipe({
      tabId: liveTabId,
      currentDSL: graphStore.currentDSL || '',
      operations,
      scenariosContext: scenariosContext as any,
      whatIfDSL,
    });
  }, [liveTabId, scenariosContext, tabs, operations, graphStore]);

  const promoteToCustom = useCallback((): any[] | null => {
    if (activeCI?.mode !== 'live') return null;
    const captured = captureScenarios();
    if (!captured) return null;
    const liveColour = liveTabId ? operations.getEffectiveScenarioColour(liveTabId, 'current', scenariosContext as any) : undefined;
    const nextGraph = mutateCanvasAnalysisGraph(graph, analysisId, (a) => {
      const ci = a.content_items?.[contentItemIndex] || a.content_items?.[0];
      if (ci) advanceMode(ci, graphStore.currentDSL || '', captured, liveColour);
    });
    if (!nextGraph) return null;
    setGraph(nextGraph);
    const updatedCI = nextGraph.canvasAnalyses?.find((a: any) => a.id === analysisId)?.content_items?.[contentItemIndex];
    return updatedCI?.scenarios || null;
  }, [activeCI?.mode, analysisId, contentItemIndex, graph, setGraph, captureScenarios, graphStore]);

  const mutateRecipeScenarios = useCallback((mutator: (ci: any) => void, label: string) => {
    if (!analysis) return;
    const nextGraph = mutateCanvasAnalysisGraph(graph, analysisId, (a) => {
      const ci = a.content_items?.[contentItemIndex] || a.content_items?.[0];
      if (!ci) return;
      if (activeCI?.mode === 'live') {
        const captured = captureScenarios();
        if (!captured) return;
        const liveColour = liveTabId ? operations.getEffectiveScenarioColour(liveTabId, 'current', scenariosContext as any) : undefined;
        advanceMode(ci, graphStore.currentDSL || '', captured, liveColour);
      }
      mutator(ci);
    });
    if (!nextGraph) return;
    setGraph(nextGraph);
    saveHistoryState(label);
  }, [activeCI?.mode, analysis, analysisId, contentItemIndex, graph, setGraph, saveHistoryState, captureScenarios, graphStore]);

  const onRename = useCallback((id: string, newName: string) => {
    mutateRecipeScenarios((ci) => {
      const s = ci?.scenarios?.find((sc: any) => sc.scenario_id === id);
      if (s) s.name = newName;
    }, 'Rename chart scenario');
  }, [mutateRecipeScenarios]);

  const onColourChange = useCallback((id: string, colour: string) => {
    mutateRecipeScenarios((ci) => {
      const s = ci?.scenarios?.find((sc: any) => sc.scenario_id === id);
      if (s) s.colour = colour;
    }, 'Change chart scenario colour');
  }, [mutateRecipeScenarios]);

  const onDelete = useCallback((id: string) => {
    mutateRecipeScenarios((ci) => {
      if (ci?.scenarios) {
        ci.scenarios = ci.scenarios.filter((sc: any) => sc.scenario_id !== id);
      }
      if (ci?.display && Array.isArray((ci.display as any).hidden_scenarios)) {
        (ci.display as any).hidden_scenarios = (ci.display as any).hidden_scenarios.filter((sid: string) => sid !== id);
      }
    }, 'Delete chart scenario');
  }, [mutateRecipeScenarios]);

  const onToggleVisibility = useCallback((id: string) => {
    mutateRecipeScenarios((ci) => {
      if (!ci.display) ci.display = {} as any;
      const hidden = Array.isArray((ci.display as any).hidden_scenarios) ? [...(ci.display as any).hidden_scenarios] : [];
      const idx = hidden.indexOf(id);
      if (idx >= 0) hidden.splice(idx, 1);
      else hidden.push(id);
      (ci.display as any).hidden_scenarios = hidden;
    }, 'Toggle chart scenario visibility');
  }, [mutateRecipeScenarios]);

  const onCycleMode = useCallback((id: string) => {
    mutateRecipeScenarios((ci) => {
      const s = ci?.scenarios?.find((sc: any) => sc.scenario_id === id);
      if (!s) return;
      const modes: Array<'f+e' | 'f' | 'e'> = ['f+e', 'f', 'e'];
      const cur = (s.visibility_mode || 'f+e') as 'f+e' | 'f' | 'e';
      const idx = modes.indexOf(cur);
      s.visibility_mode = modes[(idx + 1) % modes.length];
    }, 'Cycle chart scenario display mode');
  }, [mutateRecipeScenarios]);

  const onReorder = useCallback((fromIndex: number, toIndex: number) => {
    mutateRecipeScenarios((ci) => {
      if (!ci?.scenarios) return;
      const arr = [...ci.scenarios];
      if (activeCI?.mode !== 'live') {
        if (fromIndex < 0 || toIndex < 0 || fromIndex >= arr.length || toIndex >= arr.length || fromIndex === toIndex) return;
        const [moved] = arr.splice(fromIndex, 1);
        arr.splice(toIndex, 0, moved);
        ci.scenarios = arr;
        return;
      }

      const userFullIndices = arr
        .map((s: any, idx: number) => ({ s, idx }))
        .filter(({ s }: any) => s.scenario_id !== 'current' && s.scenario_id !== 'base')
        .map(({ idx }: any) => idx);

      const fromFull = userFullIndices[fromIndex];
      const toFull = userFullIndices[toIndex];
      if (fromFull == null || toFull == null || fromFull === toFull) return;

      const [moved] = arr.splice(fromFull, 1);
      arr.splice(toFull, 0, moved);
      ci.scenarios = arr;
    }, 'Reorder chart scenarios');
  }, [mutateRecipeScenarios]);

  const onEdit = useCallback((id: string) => {
    // In custom mode, 'current' is the hidden base underlayer — editing its DSL is meaningless.
    if (activeCI?.mode === 'custom' && id === 'current') return;
    if (activeCI?.mode === 'live' && id === 'current') {
      onEditScenarioDsl(id);
      return;
    }
    if (activeCI?.mode === 'live') {
      promoteToCustom();
    }
    onEditScenarioDsl(id);
  }, [activeCI?.mode, promoteToCustom, onEditScenarioDsl]);

  const shouldShowRefresh = useCallback(() => false, []);

  const getEditTooltip = useCallback(() => 'Edit scenario DSL', []);

  return useMemo((): ScenarioCallbacks => ({
    onRename,
    onColourChange,
    onDelete,
    onToggleVisibility,
    onCycleMode,
    onReorder,
    onEdit,
    onRefresh: undefined,
    shouldShowRefresh,
    getEditTooltip,
  }), [onRename, onColourChange, onDelete, onToggleVisibility, onCycleMode, onReorder, onEdit, shouldShowRefresh, getEditTooltip]);
}
