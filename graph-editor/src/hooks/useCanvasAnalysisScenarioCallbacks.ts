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
import type { CanvasAnalysis } from '../types';
import type { ScenarioLayerListProps } from '../components/panels/ScenarioLayerList';

type ScenarioCallbacks = Pick<ScenarioLayerListProps,
  'onRename' | 'onColourChange' | 'onDelete' | 'onToggleVisibility' |
  'onCycleMode' | 'onReorder' | 'onEdit' | 'onRefresh' | 'shouldShowRefresh' | 'getEditTooltip'
>;

interface UseCanvasAnalysisScenarioCallbacksArgs {
  analysisId: string;
  analysis: CanvasAnalysis | undefined;
  graph: any;
  setGraph: (g: any) => void;
  saveHistoryState: (action: string) => void;
  tabId?: string;
  onEditScenarioDsl: (scenarioId: string) => void;
}

export function useCanvasAnalysisScenarioCallbacks({
  analysisId,
  analysis,
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

  const promoteToCustom = useCallback((): any[] | null => {
    if (!analysis?.live) return null;
    if (!liveTabId || !scenariosContext) return null;

    const currentTab = tabs.find(t => t.id === liveTabId);
    const whatIfDSL = currentTab?.editorState?.whatIfDSL || null;
    const { scenarios: captured, what_if_dsl } = captureTabScenariosToRecipe({
      tabId: liveTabId,
      currentDSL: graphStore.currentDSL || '',
      operations,
      scenariosContext: scenariosContext as any,
      whatIfDSL,
    });

    const nextGraph = structuredClone(graph);
    const a = nextGraph.canvasAnalyses?.find((item: any) => item.id === analysisId);
    if (!a) return null;
    a.live = false;
    a.recipe = {
      ...a.recipe,
      scenarios: captured,
      analysis: { ...a.recipe.analysis, what_if_dsl },
    };
    if (nextGraph.metadata) nextGraph.metadata.updated_at = new Date().toISOString();
    setGraph(nextGraph);
    return captured;
  }, [analysis?.live, analysisId, graph, setGraph, liveTabId, scenariosContext, tabs, operations, graphStore]);

  const mutateRecipeScenarios = useCallback((mutator: (a: any) => void, label: string) => {
    if (!analysis) return;
    if (analysis.live) {
      const captured = promoteToCustom();
      if (!captured) return;
      const nextGraph = structuredClone(graph);
      const a = nextGraph.canvasAnalyses?.find((item: any) => item.id === analysisId);
      if (!a) return;
      a.live = false;
      a.recipe = { ...a.recipe, scenarios: captured };
      mutator(a);
      if (nextGraph.metadata) nextGraph.metadata.updated_at = new Date().toISOString();
      setGraph(nextGraph);
      saveHistoryState(label);
    } else {
      const nextGraph = structuredClone(graph);
      const a = nextGraph.canvasAnalyses?.find((item: any) => item.id === analysisId);
      if (!a) return;
      mutator(a);
      if (nextGraph.metadata) nextGraph.metadata.updated_at = new Date().toISOString();
      setGraph(nextGraph);
      saveHistoryState(label);
    }
  }, [analysis?.live, analysis, analysisId, graph, setGraph, saveHistoryState, promoteToCustom]);

  const onRename = useCallback((id: string, newName: string) => {
    mutateRecipeScenarios((a) => {
      const s = a?.recipe?.scenarios?.find((sc: any) => sc.scenario_id === id);
      if (s) s.name = newName;
    }, 'Rename chart scenario');
  }, [mutateRecipeScenarios]);

  const onColourChange = useCallback((id: string, colour: string) => {
    mutateRecipeScenarios((a) => {
      const s = a?.recipe?.scenarios?.find((sc: any) => sc.scenario_id === id);
      if (s) s.colour = colour;
    }, 'Change chart scenario colour');
  }, [mutateRecipeScenarios]);

  const onDelete = useCallback((id: string) => {
    mutateRecipeScenarios((a) => {
      if (a?.recipe?.scenarios) {
        a.recipe.scenarios = a.recipe.scenarios.filter((sc: any) => sc.scenario_id !== id);
      }
      if (a?.display && Array.isArray(a.display.hidden_scenarios)) {
        a.display.hidden_scenarios = a.display.hidden_scenarios.filter((sid: string) => sid !== id);
      }
    }, 'Delete chart scenario');
  }, [mutateRecipeScenarios]);

  const onToggleVisibility = useCallback((id: string) => {
    if (analysis?.live && liveTabId) {
      void operations.toggleScenarioVisibility(liveTabId, id);
      return;
    }
    mutateRecipeScenarios((a) => {
      if (!a.display) a.display = {};
      const hidden = Array.isArray(a.display.hidden_scenarios) ? [...a.display.hidden_scenarios] : [];
      const idx = hidden.indexOf(id);
      if (idx >= 0) hidden.splice(idx, 1);
      else hidden.push(id);
      a.display.hidden_scenarios = hidden;
    }, 'Toggle chart scenario visibility');
  }, [analysis?.live, liveTabId, operations, mutateRecipeScenarios]);

  const onCycleMode = useCallback((id: string) => {
    if (analysis?.live && liveTabId) {
      void operations.cycleScenarioVisibilityMode(liveTabId, id);
      return;
    }
    mutateRecipeScenarios((a) => {
      const s = a?.recipe?.scenarios?.find((sc: any) => sc.scenario_id === id);
      if (!s) return;
      const modes: Array<'f+e' | 'f' | 'e'> = ['f+e', 'f', 'e'];
      const cur = (s.visibility_mode || 'f+e') as 'f+e' | 'f' | 'e';
      const idx = modes.indexOf(cur);
      s.visibility_mode = modes[(idx + 1) % modes.length];
    }, 'Cycle chart scenario display mode');
  }, [analysis?.live, liveTabId, operations, mutateRecipeScenarios]);

  const onReorder = useCallback((fromIndex: number, toIndex: number) => {
    mutateRecipeScenarios((a) => {
      if (!a?.recipe?.scenarios) return;
      const arr = [...a.recipe.scenarios];
      const userFullIndices = arr
        .map((s: any, idx: number) => ({ s, idx }))
        .filter(({ s }: any) => s.scenario_id !== 'current' && s.scenario_id !== 'base')
        .map(({ idx }: any) => idx);

      const fromFull = userFullIndices[fromIndex];
      const toFull = userFullIndices[toIndex];
      if (fromFull == null || toFull == null || fromFull === toFull) return;

      const [moved] = arr.splice(fromFull, 1);
      const adjustedTo = fromFull < toFull ? toFull - 1 : toFull;
      arr.splice(adjustedTo, 0, moved);
      a.recipe.scenarios = arr;
    }, 'Reorder chart scenarios');
  }, [mutateRecipeScenarios]);

  const onEdit = useCallback((id: string) => {
    if (analysis?.live && id === 'current') {
      onEditScenarioDsl(id);
      return;
    }
    if (analysis?.live) {
      promoteToCustom();
    }
    onEditScenarioDsl(id);
  }, [analysis?.live, promoteToCustom, onEditScenarioDsl]);

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
