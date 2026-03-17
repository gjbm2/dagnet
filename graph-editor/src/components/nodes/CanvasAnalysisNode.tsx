import React, { useEffect, useRef, useMemo, useState, useCallback } from 'react';
import { NodeProps, NodeResizer, useStore as useReactFlowStore } from 'reactflow';
import type { CanvasAnalysis } from '@/types';
import { useCanvasAnalysisCompute } from '@/hooks/useCanvasAnalysisCompute';
import { useGraphStore, useGraphStoreApi } from '@/contexts/GraphStoreContext';
import { useScenariosContextOptional } from '@/contexts/ScenariosContext';
import { useTabContext } from '@/contexts/TabContext';
import { AnalysisChartContainer } from '../charts/AnalysisChartContainer';
import { AnalysisResultCards } from '../analytics/AnalysisResultCards';
import { AnalysisResultTable } from '../analytics/AnalysisResultTable';
import { resolveAnalysisType } from '@/services/analysisTypeResolutionService';
import { captureTabScenariosToRecipe } from '@/services/captureTabScenariosService';
import { advanceMode } from '@/services/canvasAnalysisMutationService';
import { isSnapshotBootChart, logSnapshotBoot, recordSnapshotBootLedgerStage } from '@/lib/snapshotBootTrace';
import { getLastSnappedResize, clearLastSnappedResize } from '@/services/snapService';
import { groupResizeStart, groupResize, groupResizeEnd } from '../canvas/useGroupResize';
import { beginResizeGuard, endResizeGuard } from '../canvas/syncGuards';
import { Loader2, AlertCircle, ServerOff, ExternalLink, Settings2 } from 'lucide-react';
import { chartOperationsService } from '@/services/chartOperationsService';
import { InlineEditableLabel } from '../InlineEditableLabel';
import type { AvailableAnalysis } from '@/lib/graphComputeClient';
import type { ScenarioLayerItem } from '@/types/scenarioLayerList';
import { getScenarioVisibilityOverlayStyle } from '@/lib/scenarioVisibilityModeStyles';
import { SCENARIO_PALETTE } from '@/contexts/ScenariosContext';
import { ChartFloatingIcon } from '../charts/ChartInlineSettingsFloating';
import { ExpressionToolbarTray } from '../charts/ExpressionToolbarTray';
import type { ViewMode } from '@/types/chartRecipe';
import { resolveDisplaySetting, getDisplaySettings, SCALE_WITH_CANVAS_SETTING } from '@/lib/analysisDisplaySettingsRegistry';
import { filterResultForScenarios } from '@/lib/analysisResultUtils';

interface CanvasAnalysisNodeData {
  analysis: CanvasAnalysis;
  tabId?: string;
  onUpdate: (id: string, updates: Partial<CanvasAnalysis>) => void;
  onDelete: (id: string) => void;
  onResizeStart?: () => void;
  onResizeEnd?: () => void;
}

function CanvasAnalysisNodeInner({ data, selected }: NodeProps<CanvasAnalysisNodeData>) {
  const { analysis: analysisProp, tabId, onUpdate, onDelete } = data;
  // ── Store access: use targeted selectors to avoid full-store re-renders ──
  // The full `useGraphStore()` without selector subscribes to EVERY store change,
  // causing this component to re-render on ANY graph mutation (node move, edge edit, etc.).
  // Instead, use `analysisProp` (stabilised in GraphCanvas) as the source of truth,
  // a selector only for currentDSL, and imperative store access for effect-only graph reads.
  const currentDSL = useGraphStore(s => s.currentDSL) as string;
  // useGraphStoreApi returns the raw Zustand store — .getState()/.subscribe() for
  // imperative access without reactive re-renders.
  const storeHandle = useGraphStoreApi();
  const analysis = analysisProp;
  const analysisType = analysis.recipe?.analysis?.analysis_type;
  const propAnalysisType = analysisProp.recipe?.analysis?.analysis_type;
  const propDebugSnapshotChart = isSnapshotBootChart(analysisProp);
  const debugSnapshotChart = propDebugSnapshotChart;
  const resizeTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const expressionViewportRef = useRef<HTMLDivElement>(null);
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;
  // ── Context access via refs: avoid re-renders from context value churn ──
  // ScenariosContext rebuilds its value on every graph mutation (graph is a useMemo dep).
  // TabContext creates a new value object on every render (operations not memoized).
  // Using refs means context changes don't trigger re-renders — we read fresh values
  // in callbacks and memos via the ref, which always holds the latest.
  const scenariosContext = useScenariosContextOptional();
  const scenariosContextRef = useRef(scenariosContext);
  scenariosContextRef.current = scenariosContext;
  // Reactive flag: only changes once (false→true) per file load, so adding it as a
  // memo dep doesn't cause churn the way the full context value would.
  const scenariosReady = scenariosContext ? Boolean((scenariosContext as any).scenariosReady) : false;
  const tabContext = useTabContext();
  const tabsRef = useRef(tabContext.tabs);
  tabsRef.current = tabContext.tabs;
  const operationsRef = useRef(tabContext.operations);
  operationsRef.current = tabContext.operations;
  // Subscribe ONLY to zoom — useViewport() fires on every pan/drag frame, causing
  // the entire heavy component tree to re-render on every mouse move.
  const zoom = useReactFlowStore((s) => s.transform[2]);

  // Unified sizing: scale_with_canvas controls whether content scales with ReactFlow zoom.
  const scaleWithCanvas = resolveDisplaySetting(
    analysis.display as Record<string, unknown> | undefined,
    SCALE_WITH_CANVAS_SETTING,
  ) as boolean;
  // When not scaling with canvas, apply inverse zoom so content stays constant screen size.
  const contentZoomStyle = useMemo<React.CSSProperties | undefined>(
    () => !scaleWithCanvas && zoom && zoom !== 1 ? { zoom: 1 / zoom } as any : undefined,
    [scaleWithCanvas, zoom],
  );
  // When content already has inverse zoom, toolbar shouldn't double-compensate.
  const toolbarCanvasZoom = scaleWithCanvas ? zoom : undefined;

  useEffect(() => {
    return () => { if (resizeTimeoutRef.current) clearTimeout(resizeTimeoutRef.current); };
  }, []);

  useEffect(() => {
    if (!debugSnapshotChart) return;
    const storeLooksSnapshot = isSnapshotBootChart(analysis);
    if (storeLooksSnapshot !== propDebugSnapshotChart) {
      logSnapshotBoot('CanvasAnalysisNode:store-payload-mismatch', {
        analysisId: analysisProp.id,
        propAnalysisType,
        propChartKind: analysisProp.chart_kind,
        storeAnalysisType: analysisType,
        storeChartKind: analysis.chart_kind,
        propLooksSnapshot: propDebugSnapshotChart,
        storeLooksSnapshot,
        tabId,
      });
    }
    recordSnapshotBootLedgerStage('node-mounted', {
      analysisId: analysisProp.id,
      analysisType: propAnalysisType,
      chartKind: analysisProp.chart_kind,
      mode: analysisProp.mode,
      tabId,
      source: 'CanvasAnalysisNode',
    });
    logSnapshotBoot('CanvasAnalysisNode:mount', {
      analysisId: analysisProp.id,
      analysisType: propAnalysisType,
      chartKind: analysisProp.chart_kind,
      mode: analysisProp.mode,
      tabId,
    });
    return () => {
      recordSnapshotBootLedgerStage('node-unmounted', {
        analysisId: analysisProp.id,
        analysisType: propAnalysisType,
        chartKind: analysisProp.chart_kind,
        mode: analysisProp.mode,
        tabId,
        source: 'CanvasAnalysisNode',
      });
      logSnapshotBoot('CanvasAnalysisNode:unmount', {
        analysisId: analysisProp.id,
        analysisType: propAnalysisType,
        chartKind: analysisProp.chart_kind,
        mode: analysisProp.mode,
        tabId,
      });
    };
  }, [debugSnapshotChart, analysis, analysisProp, analysisType, propAnalysisType, propDebugSnapshotChart, tabId]);

  const { result, loading, waitingForDeps, error, backendUnavailable, refresh } = useCanvasAnalysisCompute({
    analysis,
    tabId,
    debugSnapshotChartOverride: propDebugSnapshotChart,
  });

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.analysisId === analysis.id) refresh();
    };
    window.addEventListener('dagnet:canvasAnalysisRefresh', handler);
    return () => window.removeEventListener('dagnet:canvasAnalysisRefresh', handler);
  }, [analysis.id, refresh]);

  const lifecycleKey = useMemo(() => JSON.stringify({
    loading,
    waitingForDeps,
    hasResult: !!result,
    error,
    backendUnavailable,
  }), [loading, waitingForDeps, result, error, backendUnavailable]);
  const lastLifecycleKeyRef = useRef<string>('');
  useEffect(() => {
    if (!debugSnapshotChart) return;
    if (lastLifecycleKeyRef.current === lifecycleKey) return;
    lastLifecycleKeyRef.current = lifecycleKey;
    logSnapshotBoot('CanvasAnalysisNode:lifecycle', {
      analysisId: analysisProp.id,
      analysisType: propAnalysisType,
      chartKind: analysisProp.chart_kind,
      loading,
      waitingForDeps,
      hasResult: !!result,
      error,
      backendUnavailable,
    });
  }, [
    debugSnapshotChart,
    lifecycleKey,
    analysisProp.id,
    propAnalysisType,
    analysisProp.chart_kind,
    loading,
    waitingForDeps,
    result,
    error,
    backendUnavailable,
  ]);

  const [availableAnalyses, setAvailableAnalyses] = useState<AvailableAnalysis[]>([]);
  const hasAnalysisType = !!analysis.recipe?.analysis?.analysis_type;
  const analyticsDsl = analysis.recipe?.analysis?.analytics_dsl;

  const visibleScenarioIds = useMemo(() => {
    if (analysis.mode !== 'live' && analysis.recipe.scenarios) {
      const hidden = new Set<string>((((analysis.display as any)?.hidden_scenarios) || []) as string[]);
      return analysis.recipe.scenarios
        .map(s => s.scenario_id)
        .filter((id) => !hidden.has(id));
    }
    if (tabId) {
      const state = operationsRef.current.getScenarioState(tabId);
      // Derive order from scenarioOrder (same source the panel uses) so chart
      // left-to-right matches panel bottom-to-top.  scenarioOrder is newest-first
      // (prepended), so reversing gives composition order (bottom-to-top).
      const visibleSet = new Set(state?.visibleScenarioIds || ['current']);
      const order = state?.scenarioOrder || [];
      const userItems = [...order]
        .reverse()
        .filter(id => id !== 'current' && id !== 'base' && visibleSet.has(id));
      const result: string[] = [];
      if (visibleSet.has('base')) result.push('base');
      result.push(...userItems);
      if (visibleSet.has('current')) result.push('current');
      return result.length > 0 ? result : ['current'];
    }
    return ['current'];
  }, [analysis.mode, analysis.recipe.scenarios, analysis.display, tabId]);

  const scenarioCount = visibleScenarioIds.length || 1;
  // True when Live mode has user scenarios but ScenariosContext hasn't hydrated yet.
  // Used to gate chart/expression rendering so cached results aren't shown with
  // fallback colours before real scenario metadata is available.
  const awaitingScenariosHydration = analysis.mode === 'live'
    && !scenariosReady
    && visibleScenarioIds.some(id => id !== 'current' && id !== 'base');
  // Resolve available analysis types when graph structure changes.
  // Uses store.subscribe() to react to graph changes WITHOUT causing component re-renders.
  const analyticsDslRef = useRef(analyticsDsl);
  analyticsDslRef.current = analyticsDsl;
  const scenarioCountRef = useRef(scenarioCount);
  scenarioCountRef.current = scenarioCount;
  useEffect(() => {
    let cancelled = false;
    const run = () => {
      const graph = storeHandle?.getState?.()?.graph;
      if (!graph || cancelled) return;
      resolveAnalysisType(graph, analyticsDslRef.current || undefined, scenarioCountRef.current).then(({ availableAnalyses: resolved }) => {
        if (!cancelled) setAvailableAnalyses(resolved);
      });
    };
    run(); // initial
    const unsub = storeHandle?.subscribe?.((state: any, prev: any) => {
      if (state.graphRevision !== prev.graphRevision) run();
    });
    return () => { cancelled = true; unsub?.(); };
  }, [storeHandle]);
  // Also re-run when analyticsDsl or scenarioCount change (from props/analysis)
  useEffect(() => {
    const graph = storeHandle?.getState?.()?.graph;
    if (!graph) return;
    let cancelled = false;
    resolveAnalysisType(graph, analyticsDsl || undefined, scenarioCount).then(({ availableAnalyses: resolved }) => {
      if (!cancelled) setAvailableAnalyses(resolved);
    });
    return () => { cancelled = true; };
  }, [analyticsDsl, scenarioCount, storeHandle]);

  const scenarioVisibilityModes = useMemo(() => {
    const m: Record<string, 'f+e' | 'f' | 'e'> = {};
    for (const id of visibleScenarioIds) {
      if (analysis.mode !== 'live' && analysis.recipe.scenarios) {
        const s = analysis.recipe.scenarios.find(s => s.scenario_id === id);
        m[id] = (s?.visibility_mode as any) || 'f+e';
      } else {
        m[id] = tabId ? operationsRef.current.getScenarioVisibilityMode(tabId, id) : 'f+e';
      }
    }
    return m;
  }, [visibleScenarioIds, analysis, tabId]);

  const scenarioMetaById = useMemo(() => {
    const m: Record<string, { name?: string; colour?: string; visibility_mode?: 'f+e' | 'f' | 'e' }> = {};
    for (const id of visibleScenarioIds) {
      if (analysis.mode !== 'live' && analysis.recipe.scenarios) {
        const s = analysis.recipe.scenarios.find(s => s.scenario_id === id);
        if (s) {
          m[id] = {
            name: s.name || id,
            colour: s.colour || '#808080',
            visibility_mode: (s.visibility_mode as any) || 'f+e',
          };
        }
      } else {
        if (id === 'current') {
          m[id] = {
            name: 'Current',
            colour: (scenariosContextRef.current as any)?.currentColour || '#3b82f6',
            visibility_mode: scenarioVisibilityModes[id] || 'f+e',
          };
        } else if (id === 'base') {
          m[id] = {
            name: 'Base',
            colour: (scenariosContextRef.current as any)?.baseColour || '#6b7280',
            visibility_mode: scenarioVisibilityModes[id] || 'f+e',
          };
        } else {
          const s = (scenariosContextRef.current as any)?.scenarios?.find((x: any) => x.id === id);
          m[id] = {
            name: s?.name || id,
            colour: s?.colour || '#808080',
            visibility_mode: scenarioVisibilityModes[id] || 'f+e',
          };
        }
      }
    }
    return m;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- scenariosReady triggers recompute
  // when context hydrates so we read correct colours from the ref instead of fallbacks.
  }, [visibleScenarioIds, analysis.mode, analysis.recipe.scenarios, scenarioVisibilityModes, scenariosReady]);

  // Build scenario layer items for the toolbar popover
  const allScenarioLayerItems = useMemo((): ScenarioLayerItem[] => {
    const hiddenSet = new Set<string>(((analysis.display as any)?.hidden_scenarios || []) as string[]);
    if (analysis.mode === 'live') {
      // Live mode: show tab's scenarios, all visible
      return visibleScenarioIds.map(sid => {
        const meta = scenarioMetaById[sid];
        return {
          id: sid,
          name: meta?.name || sid,
          colour: meta?.colour || '#808080',
          visible: true,
          visibilityMode: (meta?.visibility_mode || 'f+e') as 'f+e' | 'f' | 'e',
          kind: sid === 'current' ? 'current' as const : sid === 'base' ? 'base' as const : 'user' as const,
        };
      });
    }
    // Custom mode: show all recipe scenarios (including hidden)
    const frozenScenarios = analysis.recipe?.scenarios || [];
    return frozenScenarios.map(fs => ({
      id: fs.scenario_id,
      name: fs.name || fs.scenario_id,
      colour: fs.colour || '#808080',
      visible: !hiddenSet.has(fs.scenario_id),
      visibilityMode: (fs.visibility_mode || 'f+e') as 'f+e' | 'f' | 'e',
      kind: 'user' as const,
    }));
  }, [analysis.mode, analysis.recipe?.scenarios, analysis.display, visibleScenarioIds, scenarioMetaById]);

  // DSL subtitles for scenario cards
  const scenarioDslSubtitleById = useMemo(() => {
    const frozenScenarios = analysis.recipe?.scenarios || [];
    const m: Record<string, string> = {};
    for (const s of frozenScenarios) {
      const dsl = typeof s?.effective_dsl === 'string' ? s.effective_dsl.trim() : '';
      if (dsl) m[s.scenario_id] = dsl;
    }
    return Object.keys(m).length ? m : undefined;
  }, [analysis.recipe?.scenarios]);

  // Filtered result for cards/table: only visible scenarios, patched metadata
  const expressionResult = useMemo(() => {
    if (!result) return null;
    return filterResultForScenarios(result, visibleScenarioIds, scenarioMetaById);
  }, [result, visibleScenarioIds, scenarioMetaById]);

  // Mutate recipe scenarios with auto-promotion from live → custom
  const mutateScenarios = useCallback((mutator: (scenarios: any[], display: any) => { scenarios?: any[]; display?: any }) => {
    if (analysis.mode === 'live') {
      const liveTabId = tabId || tabsRef.current[0]?.id;
      if (!liveTabId || !scenariosContextRef.current) return;
      const currentTab = tabsRef.current.find(t => t.id === liveTabId);
      const whatIfDSL = currentTab?.editorState?.whatIfDSL || null;
      const { scenarios: captured, what_if_dsl } = captureTabScenariosToRecipe({
        tabId: liveTabId,
        currentDSL: currentDSL || '',
        operations: operationsRef.current,
        scenariosContext: scenariosContextRef.current as any,
        whatIfDSL,
      });
      const result = mutator(captured, analysis.display || {});
      onUpdate(analysis.id, {
        mode: 'custom' as const,
        recipe: { ...analysis.recipe, scenarios: result.scenarios ?? captured, analysis: { ...analysis.recipe.analysis, what_if_dsl } },
        display: result.display !== undefined ? result.display : analysis.display,
      } as any);
    } else {
      const scenarios = [...(analysis.recipe?.scenarios || [])];
      const result = mutator(scenarios, analysis.display || {});
      const updates: any = {};
      if (result.scenarios !== undefined) updates.recipe = { ...analysis.recipe, scenarios: result.scenarios };
      if (result.display !== undefined) updates.display = result.display;
      if (Object.keys(updates).length > 0) onUpdate(analysis.id, updates);
    }
  }, [analysis, onUpdate, tabId, currentDSL]);

  const handleScenarioToggleVisibility = useCallback((id: string) => {
    mutateScenarios((scenarios, display) => {
      const hidden = [...(((display as any)?.hidden_scenarios) || []) as string[]];
      const idx = hidden.indexOf(id);
      if (idx >= 0) hidden.splice(idx, 1);
      else hidden.push(id);
      return { display: { ...display, hidden_scenarios: hidden } };
    });
  }, [mutateScenarios]);

  const handleScenarioCycleMode = useCallback((id: string) => {
    mutateScenarios((scenarios) => {
      const s = scenarios.find((sc: any) => sc.scenario_id === id);
      if (s) {
        const modes: Array<'f+e' | 'f' | 'e'> = ['f+e', 'f', 'e'];
        const cur = (s.visibility_mode || 'f+e') as 'f+e' | 'f' | 'e';
        s.visibility_mode = modes[(modes.indexOf(cur) + 1) % modes.length];
      }
      return { scenarios };
    });
  }, [mutateScenarios]);

  const handleScenarioColourChange = useCallback((id: string, colour: string) => {
    mutateScenarios((scenarios) => {
      const s = scenarios.find((sc: any) => sc.scenario_id === id);
      if (s) s.colour = colour;
      return { scenarios };
    });
  }, [mutateScenarios]);

  const getScenarioSwatchOverlay = useCallback((id: string) => {
    const item = allScenarioLayerItems.find(entry => entry.id === id);
    return getScenarioVisibilityOverlayStyle(item?.visibilityMode);
  }, [allScenarioLayerItems]);

  const handleAddScenario = useCallback(() => {
    mutateScenarios((scenarios) => {
      const usedColours = new Set(scenarios.map((s: any) => s.colour));
      const colour = SCENARIO_PALETTE.find(c => !usedColours.has(c)) || SCENARIO_PALETTE[scenarios.length % SCENARIO_PALETTE.length];
      const id = `scenario_${Date.now()}`;
      const name = new Date().toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      scenarios.push({ scenario_id: id, name, colour, effective_dsl: '', visibility_mode: 'f+e' });
      return { scenarios };
    });
  }, [mutateScenarios]);

  const analysisIdRef = useRef(analysis.id);
  analysisIdRef.current = analysis.id;

  const handleResizeStart = useCallback(() => {
    if (import.meta.env.DEV) console.log('[CanvasAnalysisNode] handleResizeStart (singleton guard)', { id: analysisIdRef.current });
    // Call module-level singleton directly — no data prop needed.
    // This bypasses ReactFlow's controlled-mode data-prop-loss problem entirely.
    beginResizeGuard();
    groupResizeStart(`analysis-${analysisIdRef.current}`);
  }, []);
  const handleResize = useCallback((_event: any, params: { x: number; y: number; width: number; height: number }) => {
    groupResize(`analysis-${analysisIdRef.current}`, params.width, params.height);
    // No mid-drag onUpdate — saving to graph store during resize triggers the
    // sync effect which applies stale positions from React state, causing the
    // node to bounce. handleResizeEnd saves the final state instead.
  }, []);
  const handleResizeEnd = useCallback((_event: any, params: { x: number; y: number; width: number; height: number }) => {
    if (resizeTimeoutRef.current) clearTimeout(resizeTimeoutRef.current);
    // Use snapped dimensions if available — d3-drag doesn't know about
    // snap adjustments, so its params would cause a "bounce" on release.
    const snap = getLastSnappedResize();
    const useSnap = snap && snap.nodeId === `analysis-${analysisIdRef.current}`;
    const finalW = Math.round(useSnap ? snap.width : params.width);
    const finalH = Math.round(useSnap ? snap.height : params.height);
    onUpdateRef.current(analysisIdRef.current, {
      x: Math.round(useSnap ? snap.x : params.x),
      y: Math.round(useSnap ? snap.y : params.y),
      width: finalW,
      height: finalH,
    });
    clearLastSnappedResize();
    groupResizeEnd(`analysis-${analysisIdRef.current}`, finalW, finalH);
    endResizeGuard();
  }, []);


  const handleModeCycle = useCallback(() => {
    // Live → Custom: capture tab scenarios and rebase to delta DSLs
    // Custom → Fixed: bake deltas into absolute DSLs
    // Fixed → Live: clear scenarios
    const clone = structuredClone(analysis);
    let captured: { scenarios: any[]; what_if_dsl?: string } | null = null;
    if (analysis.mode === 'live') {
      const liveTabId = tabId || tabsRef.current[0]?.id;
      if (!liveTabId || !scenariosContextRef.current) return;
      const currentTab = tabsRef.current.find(t => t.id === liveTabId);
      const whatIfDSL = currentTab?.editorState?.whatIfDSL || null;
      captured = captureTabScenariosToRecipe({
        tabId: liveTabId,
        currentDSL: currentDSL || '',
        operations: operationsRef.current,
        scenariosContext: scenariosContextRef.current as any,
        whatIfDSL,
      });
    }
    advanceMode(clone, currentDSL || '', captured);
    onUpdate(analysis.id, {
      mode: clone.mode,
      recipe: clone.recipe,
    } as any);
  }, [analysis, onUpdate, tabId, currentDSL]);

  const handleOverlayToggle = useCallback((active: boolean) => {
    const colour = analysis.display?.subject_overlay_colour || '#3b82f6';
    onUpdate(analysis.id, {
      display: { ...analysis.display, show_subject_overlay: active, ...(active ? { subject_overlay_colour: colour } : {}) },
    });
  }, [analysis, onUpdate]);

  const handleOverlayColourChange = useCallback((colour: string | null) => {
    if (colour) {
      onUpdate(analysis.id, {
        display: { ...analysis.display, show_subject_overlay: true, subject_overlay_colour: colour },
      });
    } else {
      onUpdate(analysis.id, {
        display: { ...analysis.display, show_subject_overlay: false, subject_overlay_colour: undefined },
      });
    }
  }, [analysis, onUpdate]);

  const chartSource = useMemo(() => {
    const currentTab = tabId ? tabsRef.current.find(t => t.id === tabId) : undefined;
    return {
      parent_tab_id: tabId,
      parent_file_id: currentTab?.fileId,
      query_dsl: analysis.recipe?.analysis?.analytics_dsl,
      analysis_type: analysis.recipe?.analysis?.analysis_type,
    };
  }, [tabId, analysis.recipe?.analysis?.analytics_dsl, analysis.recipe?.analysis?.analysis_type]);

  const displayTitle = analysis.title || result?.analysis_name || analysis.recipe.analysis.analysis_type || 'Analysis';

  // Graph for DSL editor in toolbar badge popover (autocomplete suggestions)
  const graphForDsl = useGraphStore(s => s.graph);

  const handleDslChange = useCallback((dsl: string) => {
    onUpdate(analysis.id, {
      recipe: { ...analysis.recipe, analysis: { ...analysis.recipe.analysis, analytics_dsl: dsl || undefined } },
    });
  }, [analysis.id, analysis.recipe, onUpdate]);

  // ── Stable callbacks for table/cards view (prevent re-renders from inline closures) ──
  const handleDisplayChangeBatch = useCallback((keyOrBatch: string | Record<string, any>, value?: any) => {
    if (typeof keyOrBatch === 'object') {
      onUpdate(analysis.id, { display: { ...analysis.display, ...keyOrBatch } });
    } else {
      onUpdate(analysis.id, { display: { ...analysis.display, [keyOrBatch]: value } });
    }
  }, [analysis.id, analysis.display, onUpdate]);

  const handleViewModeChange = useCallback((mode: ViewMode) => {
    onUpdate(analysis.id, { view_mode: mode } as any);
  }, [analysis.id, onUpdate]);

  const handleTableSortChange = useCallback((col: string, dir: 'asc' | 'desc') => {
    onUpdate(analysis.id, {
      display: { ...analysis.display, table_sort_column: col, table_sort_direction: dir },
    });
  }, [analysis.id, analysis.display, onUpdate]);

  const handleTableHiddenColumnsChange = useCallback((hidden: string[]) => {
    onUpdate(analysis.id, { display: { ...analysis.display, table_hidden_columns: hidden } });
  }, [analysis.id, analysis.display, onUpdate]);

  const handleTableColumnOrderChange = useCallback((order: string[]) => {
    onUpdate(analysis.id, { display: { ...analysis.display, table_column_order: order } });
  }, [analysis.id, analysis.display, onUpdate]);

  const handleTableColumnWidthsChange = useCallback((widths: string) => {
    onUpdate(analysis.id, { display: { ...analysis.display, table_column_widths: widths } });
  }, [analysis.id, analysis.display, onUpdate]);

  const handleCollapsedCardsChange = useCallback((collapsed: string[]) => {
    onUpdate(analysis.id, { display: { ...analysis.display, cards_collapsed: collapsed } });
  }, [analysis.id, analysis.display, onUpdate]);

  const handleDeleteSelf = useCallback(() => onDelete(analysis.id), [analysis.id, onDelete]);

  // ── Pre-resolved display settings for table/cards (avoids IIFE + inline resolve) ──
  const expressionViewMode = (analysis.view_mode === 'cards' || analysis.view_mode === 'table')
    ? analysis.view_mode as ViewMode : null;
  const resolvedExpressionDisplay = useMemo(() => {
    if (!expressionViewMode) return null;
    const settings = getDisplaySettings(undefined, expressionViewMode);
    const resolve = (key: string) => {
      const s = settings.find(s => s.key === key);
      return s ? resolveDisplaySetting(analysis.display as Record<string, unknown> | undefined, s) : undefined;
    };
    return {
      fontSize: resolve('font_size') as number | string | undefined,
      striped: resolve('table_striped') as boolean | undefined,
      sortColumn: resolve('table_sort_column') as string | undefined,
      sortDirection: resolve('table_sort_direction') as 'asc' | 'desc' | undefined,
      hiddenColumns: resolve('table_hidden_columns') as string[] | undefined,
      columnOrder: resolve('table_column_order') as string[] | undefined,
      columnWidths: resolve('table_column_widths') as string | undefined,
      collapsedCards: resolve('cards_collapsed') as string[] | undefined,
    };
  }, [expressionViewMode, analysis.display]);

  // Memoize the tray element to prevent ChartFloatingIcon re-renders
  const expressionTray = useMemo(() => {
    if (!expressionViewMode) return null;
    return (
      <ExpressionToolbarTray
        viewMode={expressionViewMode}
        result={result}
        display={analysis.display as Record<string, unknown> | undefined}
        onViewModeChange={handleViewModeChange}
        onDisplayChange={handleDisplayChangeBatch}
        onDelete={handleDeleteSelf}
      />
    );
  }, [expressionViewMode, result, analysis.display, handleViewModeChange, handleDisplayChangeBatch, handleDeleteSelf]);

  const handleChartKindChange = useCallback((kind: string | undefined) => {
    onUpdate(analysis.id, { chart_kind: kind || undefined } as any);
  }, [analysis.id, onUpdate]);

  const handleAnalysisTypeChange = useCallback((id: string) => {
    onUpdate(analysis.id, {
      recipe: { ...analysis.recipe, analysis: { ...analysis.recipe.analysis, analysis_type: id } },
      analysis_type_overridden: true,
      chart_kind: undefined,
    } as any);
  }, [analysis.id, analysis.recipe, onUpdate]);

  return (
    <div
      className={`canvas-analysis-node${selected ? ' nowheel' : ''}`}
      style={{
        width: '100%',
        height: '100%',
        background: 'var(--canvas-analysis-bg, #ffffff)',
        border: '1px solid var(--canvas-analysis-border, #d1d5db)',
        outline: (selected || analysis.display?.show_subject_overlay)
          ? `12px solid ${analysis.display?.subject_overlay_colour || '#3b82f6'}${selected ? '1a' : '0d'}`
          : 'none',
        outlineOffset: -1,
        borderRadius: 8,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        boxShadow: selected
          ? '0 4px 12px rgba(0,0,0,0.10), 0 12px 32px rgba(0,0,0,0.12)'
          : '0 1px 3px rgba(0,0,0,0.08), 0 4px 12px rgba(0,0,0,0.06)',
        transition: 'box-shadow 0.15s ease-out',
      }}
      onMouseEnter={() => {
        window.dispatchEvent(new CustomEvent('dagnet:analysisHover', { detail: { analysisId: analysis.id } }));
      }}
      onMouseLeave={() => {
        window.dispatchEvent(new CustomEvent('dagnet:analysisHover', { detail: { analysisId: null } }));
      }}
    >
      <NodeResizer
        isVisible={selected}
        minWidth={300}
        minHeight={200}
        onResizeStart={handleResizeStart}
        onResize={handleResize}
        onResizeEnd={handleResizeEnd}
        lineStyle={{ display: 'none' }}
        handleStyle={{ width: 8 / zoom, height: 8 / zoom, borderRadius: 2, backgroundColor: '#3b82f6', border: '1px solid var(--bg-primary)' }}
      />

      {selected && (
        <button
          className="nodrag"
          onClick={(e) => { e.stopPropagation(); onDelete(analysis.id); }}
          title="Delete canvas analysis"
          style={{
            position: 'absolute', top: -24 / zoom, right: -24 / zoom, width: 20 / zoom, height: 20 / zoom,
            borderRadius: '50%', border: '1px solid var(--border-primary)', background: 'var(--bg-primary)',
            color: 'var(--color-danger)', fontSize: 12 / zoom, lineHeight: `${18 / zoom}px`, textAlign: 'center',
            cursor: 'pointer', zIndex: 10, padding: 0, boxShadow: '0 1px 3px rgba(0,0,0,0.15)',
          }}
        >
          ×
        </button>
      )}

      {/* Title bar */}
      <div
        style={{
          padding: '4px 8px',
          fontSize: 8,
          fontWeight: 600,
          color: 'var(--canvas-analysis-title, #374151)',
          borderBottom: '1px solid var(--canvas-analysis-border, #e5e7eb)',
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          background: 'var(--canvas-analysis-title-bg, #f9fafb)',
        }}
      >
        <InlineEditableLabel
          value={analysis.title || ''}
          placeholder={result?.analysis_name || analysis.recipe.analysis.analysis_type || 'Choose analysis type'}
          selected={!!selected}
          onCommit={(v) => onUpdate(analysis.id, { title: v })}
          displayStyle={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}
          editStyle={{ minWidth: 0 }}
        />
        <span className={`canvas-analysis-mode-badge canvas-analysis-mode-badge--${analysis.mode === 'live' && !analysis.chart_current_layer_dsl ? 'live' : analysis.mode}`}>
          {analysis.mode === 'live' && !analysis.chart_current_layer_dsl ? 'LIVE' : analysis.mode === 'custom' ? 'CUSTOM' : 'FIXED'}
        </span>
        {hasAnalysisType && (loading || waitingForDeps) && <Loader2 size={12} style={{ animation: 'spin 1s linear infinite', flexShrink: 0 }} />}
        <span style={{ flex: 1 }} />
        {result && (
          <button
            type="button"
            className="canvas-analysis-title-btn"
            onClick={(e) => {
              e.stopPropagation();
              const chartKind = analysis.chart_kind || result?.semantics?.chart?.recommended;
              if (chartKind) {
                chartOperationsService.openAnalysisChartTabFromAnalysis({
                  chartKind: chartKind as any,
                  analysisResult: result,
                  scenarioIds: visibleScenarioIds,
                  source: chartSource,
                  render: {
                    view_mode: analysis.view_mode as ViewMode | undefined,
                    chart_kind: analysis.chart_kind,
                    display: analysis.display as Record<string, unknown> | undefined,
                  },
                });
              }
            }}
            title="Open as Tab"
          >
            <ExternalLink size={10} />
          </button>
        )}
        <button
          type="button"
          className="canvas-analysis-title-btn"
          onClick={(e) => {
            e.stopPropagation();
            window.dispatchEvent(new CustomEvent('dagnet:openAnalysisProperties', { detail: { analysisId: analysis.id } }));
          }}
          title="Open Properties"
        >
          <Settings2 size={10} />
        </button>
      </div>

      {/* Content area — interactive only when selected; unselected nodes just drag */}
      <div style={{ flex: 1, overflow: 'hidden', position: 'relative', minHeight: 0, ...contentZoomStyle }}>
        {/* When not selected, a transparent overlay captures mouse events for dragging
            instead of letting them fall into scrollable table/chart content */}
        {!selected && (
          <div style={{ position: 'absolute', inset: 0, zIndex: 10, cursor: 'grab' }} />
        )}
        {/* Recomputing overlay: shown when loading with a stale result still visible */}
        {result && loading && (
          <div style={{
            position: 'absolute', inset: 0, zIndex: 5,
            background: 'var(--canvas-analysis-recompute-overlay, rgba(255,255,255,0.55))',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            pointerEvents: 'none',
          }}>
            <Loader2 size={20} style={{ animation: 'spin 1s linear infinite', color: 'var(--text-muted, #6b7280)' }} />
          </div>
        )}
        {hasAnalysisType && backendUnavailable && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 8, color: 'var(--text-muted)', padding: 16 }}>
            <ServerOff size={28} />
            <span style={{ fontSize: 12, textAlign: 'center' }}>Analysis backend unavailable</span>
          </div>
        )}

        {hasAnalysisType && !backendUnavailable && error && !result && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 8, color: 'var(--color-danger)', padding: 16 }}>
            <AlertCircle size={24} />
            <span style={{ fontSize: 11, textAlign: 'center', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', WebkitLineClamp: 3, display: '-webkit-box', WebkitBoxOrient: 'vertical' }}>{error}</span>
          </div>
        )}

        {hasAnalysisType && !backendUnavailable && !result && !error && (loading || waitingForDeps) && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 8, color: 'var(--text-muted)' }}>
            <Loader2 size={28} style={{ animation: 'spin 1s linear infinite' }} />
            <span style={{ fontSize: 12 }}>{waitingForDeps ? 'Loading chart dependencies...' : 'Computing...'}</span>
          </div>
        )}

        {/* Gate: don't render chart until scenarios are hydrated (Live mode with user scenarios).
            Without this, a cached result renders with fallback '#808080' colours before
            ScenariosContext has loaded the real scenario metadata from IDB. */}
        {awaitingScenariosHydration && result && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 8, color: 'var(--text-muted)' }}>
            <Loader2 size={28} style={{ animation: 'spin 1s linear infinite' }} />
            <span style={{ fontSize: 12 }}>Loading scenarios...</span>
          </div>
        )}

        {analysis.view_mode === 'chart' && (result || !hasAnalysisType) && !(awaitingScenariosHydration) && (
          <AnalysisChartContainer
            result={result}
            chartKindOverride={analysis.chart_kind}
            visibleScenarioIds={visibleScenarioIds}
            scenarioVisibilityModes={scenarioVisibilityModes}
            scenarioMetaById={scenarioMetaById}
            display={analysis.display}
            onChartKindChange={handleChartKindChange}
            onDisplayChange={handleDisplayChangeBatch}
            source={chartSource}
            fillHeight
            chartContext="canvas"
            canvasZoom={toolbarCanvasZoom}
            hideScenarioLegend={analysis.mode === 'live' && analysis.display?.show_legend !== true}
            analysisTypeId={analysis.recipe?.analysis?.analysis_type}
            availableAnalyses={availableAnalyses}
            onAnalysisTypeChange={handleAnalysisTypeChange}
            analysisMode={analysis.mode}
            onModeCycle={handleModeCycle}
            scenarioLayerItems={allScenarioLayerItems}
            onScenarioToggleVisibility={handleScenarioToggleVisibility}
            onScenarioCycleMode={handleScenarioCycleMode}
            onScenarioColourChange={handleScenarioColourChange}
            getScenarioSwatchOverlayStyle={getScenarioSwatchOverlay}
            onAddScenario={handleAddScenario}
            overlayActive={!!analysis.display?.show_subject_overlay}
            overlayColour={analysis.display?.subject_overlay_colour as string | undefined}
            onOverlayToggle={handleOverlayToggle}
            onOverlayColourChange={handleOverlayColourChange}
            graph={graphForDsl}
            onDslChange={handleDslChange}
            analysisId={analysis.id}
            onDelete={handleDeleteSelf}
            viewMode={analysis.view_mode as ViewMode | undefined}
            onViewModeChange={handleViewModeChange}
          />
        )}

        {expressionResult && expressionViewMode && resolvedExpressionDisplay && !(awaitingScenariosHydration) && (
          <div
            ref={expressionViewportRef}
            style={{ position: 'relative', overflow: 'auto', height: '100%' }}
          >
            <ChartFloatingIcon
              containerRef={expressionViewportRef}
              tray={expressionTray}
              canvasZoom={toolbarCanvasZoom}
              defaultAnchor="top-right"
            />
            <div
              style={{ padding: 8, height: '100%', boxSizing: 'border-box' }}
            >
              {expressionViewMode === 'cards' && (
                <AnalysisResultCards
                  result={expressionResult}
                  scenarioDslSubtitleById={scenarioDslSubtitleById}
                  fontSize={resolvedExpressionDisplay.fontSize}
                  collapsedCards={resolvedExpressionDisplay.collapsedCards}
                  onCollapsedCardsChange={handleCollapsedCardsChange}
                />
              )}
              {expressionViewMode === 'table' && (
                <AnalysisResultTable
                  result={expressionResult}
                  fontSize={resolvedExpressionDisplay.fontSize}
                  striped={resolvedExpressionDisplay.striped}
                  sortColumn={resolvedExpressionDisplay.sortColumn}
                  sortDirection={resolvedExpressionDisplay.sortDirection}
                  onSortChange={handleTableSortChange}
                  hiddenColumns={resolvedExpressionDisplay.hiddenColumns}
                  onHiddenColumnsChange={handleTableHiddenColumnsChange}
                  columnOrder={resolvedExpressionDisplay.columnOrder}
                  onColumnOrderChange={handleTableColumnOrderChange}
                  columnWidths={resolvedExpressionDisplay.columnWidths}
                  onColumnWidthsChange={handleTableColumnWidthsChange}
                />
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// React.memo: prevents re-render when ReactFlow calls setNodes() for unrelated changes
// (e.g. dragging another node). GraphCanvas stabilises data.analysis reference so shallow
// comparison on `data` is sufficient to skip re-renders for unchanged analyses.
const CanvasAnalysisNode = React.memo(CanvasAnalysisNodeInner);
export default CanvasAnalysisNode;
