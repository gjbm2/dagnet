import React, { useEffect, useRef, useMemo, useState, useCallback } from 'react';
import ReactDOM from 'react-dom';
import { NodeProps, NodeResizer, useStore as useReactFlowStore } from 'reactflow';
import type { CanvasAnalysis, ContentItem } from '@/types';
import { getActiveContentItem, getContentItems, deriveDslSubjectLabel } from '@/utils/canvasAnalysisAccessors';
import { CanvasAnalysisCard } from '../CanvasAnalysisCard';
import type { TabDragOutcome } from '../CanvasAnalysisCard';
import { useCanvasAnalysisCompute, contentItemResultCache, canvasAnalysisResultCache } from '@/hooks/useCanvasAnalysisCompute';
import { useGraphStore, useGraphStoreApi } from '@/contexts/GraphStoreContext';
import { useScenariosContextOptional } from '@/contexts/ScenariosContext';
import { useTabContext } from '@/contexts/TabContext';
import { AnalysisChartContainer } from '../charts/AnalysisChartContainer';
import { AnalysisInfoCard } from '../analytics/AnalysisInfoCard';
import { buildContextMenuSettingItems } from '@/lib/analysisDisplaySettingsRegistry';
import { OVERLAY_PRESET_COLOURS } from '../ColourSelector';
import type { ContextMenuItem } from '../ContextMenu';
import { AnalysisResultCards } from '../analytics/AnalysisResultCards';
import { AnalysisResultTable } from '../analytics/AnalysisResultTable';
import { resolveAnalysisType } from '@/services/analysisTypeResolutionService';
import { captureTabScenariosToRecipe } from '@/services/captureTabScenariosService';
import { advanceMode, removeContentItem, addContentItem, humaniseAnalysisType, setContentItemAnalysisType } from '@/services/canvasAnalysisMutationService';
import { isSnapshotBootChart, logSnapshotBoot, recordSnapshotBootLedgerStage } from '@/lib/snapshotBootTrace';
import { getLastSnappedResize, clearLastSnappedResize } from '@/services/snapService';
import { groupResizeStart, groupResize, groupResizeEnd } from '../canvas/useGroupResize';
import { beginResizeGuard, endResizeGuard } from '../canvas/syncGuards';
import { Loader2, AlertCircle, ServerOff, ExternalLink, Settings2, ChevronDown, Crosshair, SlidersHorizontal, RefreshCw, X, BarChart3 } from 'lucide-react';
import { chartOperationsService } from '@/services/chartOperationsService';
import { InlineEditableLabel } from '../InlineEditableLabel';
import type { AvailableAnalysis } from '@/lib/graphComputeClient';
import { getAnalysisTypeMeta, getKindsForView } from '../panels/analysisTypes';
import { AnalysisTypeCardList } from '../panels/AnalysisTypeCardList';
import type { ScenarioLayerItem } from '@/types/scenarioLayerList';
import { getScenarioVisibilityOverlayStyle } from '@/lib/scenarioVisibilityModeStyles';
import { SCENARIO_PALETTE } from '@/contexts/ScenariosContext';
import { ChartFloatingIcon } from '../charts/ChartInlineSettingsFloating';
import { ExpressionToolbarTray } from '../charts/ExpressionToolbarTray';
import type { ViewMode } from '@/types/chartRecipe';
import { resolveDisplaySetting, getDisplaySettings, SCALE_WITH_CANVAS_SETTING } from '@/lib/analysisDisplaySettingsRegistry';
import { MinimiseChevron } from '../canvas/MinimiseChevron';
import { MinimiseCornerArrows, CORNER_ORIGINS } from '../canvas/MinimiseCornerArrows';
import type { AnchorCorner } from '../canvas/MinimiseCornerArrows';
import { filterResultForScenarios } from '@/lib/analysisResultUtils';

interface CanvasAnalysisNodeData {
  analysis: CanvasAnalysis;
  tabId?: string;
  onUpdate: (id: string, updates: Partial<CanvasAnalysis>) => void;
  onDelete: (id: string) => void;
  onResizeStart?: () => void;
  onResizeEnd?: () => void;
}


function CanvasAnalysisNodeInner({ data, selected, dragging }: NodeProps<CanvasAnalysisNodeData>) {
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
  const minimised = !!analysis.minimised;
  const prevMinimisedRef = useRef(minimised);
  const prevAnchorRef = useRef<string | undefined>((analysis as any).minimised_anchor);
  const restoreAnimUntilRef = useRef(0);
  const restoredAnchorStash = useRef('tl');
  const [, forceRender] = useState(0);
  if (prevMinimisedRef.current && !minimised) {
    restoreAnimUntilRef.current = Date.now() + 180;
    restoredAnchorStash.current = prevAnchorRef.current || 'tl';
  }
  prevMinimisedRef.current = minimised;
  prevAnchorRef.current = (analysis as any).minimised_anchor;
  const justRestored = Date.now() < restoreAnimUntilRef.current;
  const restoredAnchor = justRestored ? restoredAnchorStash.current : undefined;
  useEffect(() => {
    if (!justRestored) return;
    const remaining = restoreAnimUntilRef.current - Date.now();
    if (remaining <= 0) return;
    const t = setTimeout(() => forceRender(n => n + 1), remaining);
    return () => clearTimeout(t);
  }, [justRestored]);
  const [hovered, setHovered] = useState(false);
  const [iconHovered, setIconHovered] = useState(false);
  const hoverOffTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverOn = useCallback(() => { if (hoverOffTimer.current) { clearTimeout(hoverOffTimer.current); hoverOffTimer.current = null; } setHovered(true); setIconHovered(true); }, []);
  const hoverOff = useCallback(() => { setIconHovered(false); hoverOffTimer.current = setTimeout(() => setHovered(false), 800); }, []);
  const [cornerHint, setCornerHint] = useState<AnchorCorner | null>(null);
  const lastCornerRef = useRef<AnchorCorner | null>((analysis as any).minimised_anchor ?? null);
  if (cornerHint) lastCornerRef.current = cornerHint;
  else if (!lastCornerRef.current && (analysis as any).minimised_anchor) lastCornerRef.current = (analysis as any).minimised_anchor;
  const hintSuppressedUntil = useRef(0);
  const setCornerHintGuarded = useCallback((c: AnchorCorner | null) => {
    if (c && Date.now() < hintSuppressedUntil.current) return;
    setCornerHint(c);
  }, []);
  const suppressHint = useCallback(() => { hintSuppressedUntil.current = Date.now() + 500; setCornerHint(null); }, []);
  // Cancel expand hint when dragging starts
  if (dragging && cornerHint) setCornerHint(null);
  const contentItems = getContentItems(analysis);
  const [activeContentIndex, setActiveContentIndex] = useState(0);
  // Clamp index if content items shrink
  const clampedIndex = Math.min(activeContentIndex, contentItems.length - 1);
  const contentItem = contentItems[clampedIndex] || getActiveContentItem(analysis);
  const analysisType = contentItem?.analysis_type;

  // Broadcast active tab changes so SelectionConnectors + PropertiesPanel can track the active tab
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('dagnet:analysisActiveTabChanged', {
      detail: { analysisId: analysis.id, activeContentIndex: clampedIndex },
    }));
  }, [analysis.id, clampedIndex]);

  // Respond to tab state requests (e.g. PropertiesPanel mounting after the node)
  useEffect(() => {
    const handler = (e: Event) => {
      const { analysisId: aid } = (e as CustomEvent).detail || {};
      if (aid === analysis.id) {
        window.dispatchEvent(new CustomEvent('dagnet:analysisActiveTabChanged', {
          detail: { analysisId: analysis.id, activeContentIndex: clampedIndex },
        }));
      }
    };
    window.addEventListener('dagnet:requestAnalysisActiveTab', handler);
    return () => window.removeEventListener('dagnet:requestAnalysisActiveTab', handler);
  }, [analysis.id, clampedIndex]);

  // Subject label derived from active tab's DSL + graph nodes
  const analyticsDslForSubject = contentItem?.analytics_dsl;
  const subjectLabel = useMemo(() => {
    if (!analyticsDslForSubject) return undefined;
    const graphNodes = storeHandle.getState().graph?.nodes || [];
    return deriveDslSubjectLabel(analyticsDslForSubject, graphNodes);
  }, [analyticsDslForSubject, storeHandle]);

  const propContentItem = getContentItems(analysisProp)[0];
  const propAnalysisType = propContentItem?.analysis_type;
  const propDebugSnapshotChart = isSnapshotBootChart({ content_items: [propContentItem] });
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
  // Reads from container-level display (not per-tab) — switching tabs must not change zoom.
  const scaleWithCanvas = resolveDisplaySetting(
    contentItem?.display as Record<string, unknown> | undefined,
    SCALE_WITH_CANVAS_SETTING,
  ) as boolean;
  // When not scaling with canvas, apply inverse zoom so content stays constant screen size.
  const contentZoomStyle = useMemo<React.CSSProperties | undefined>(
    () => !scaleWithCanvas && zoom && zoom !== 1 ? { zoom: 1 / zoom } as any : undefined,
    [scaleWithCanvas, zoom],
  );
  // Chrome (title bar, tab bar) always gets inverse zoom so it stays readable.
  const chromeZoomStyle = useMemo<React.CSSProperties | undefined>(
    () => zoom && zoom !== 1 ? { zoom: 1 / zoom } as any : undefined,
    [zoom],
  );
  // When content already has inverse zoom, toolbar shouldn't double-compensate.
  const toolbarCanvasZoom = scaleWithCanvas ? zoom : undefined;

  useEffect(() => {
    return () => { if (resizeTimeoutRef.current) clearTimeout(resizeTimeoutRef.current); };
  }, []);

  useEffect(() => {
    if (!debugSnapshotChart) return;
    const storeLooksSnapshot = isSnapshotBootChart({ content_items: [contentItem] });
    if (storeLooksSnapshot !== propDebugSnapshotChart) {
      logSnapshotBoot('CanvasAnalysisNode:store-payload-mismatch', {
        analysisId: analysisProp.id,
        propAnalysisType,
        propChartKind: propContentItem?.kind,
        storeAnalysisType: analysisType,
        storeChartKind: contentItem?.kind,
        propLooksSnapshot: propDebugSnapshotChart,
        storeLooksSnapshot,
        tabId,
      });
    }
    recordSnapshotBootLedgerStage('node-mounted', {
      analysisId: analysisProp.id,
      analysisType: propAnalysisType,
      chartKind: propContentItem?.kind,
      mode: contentItem?.mode,
      tabId,
      source: 'CanvasAnalysisNode',
    });
    logSnapshotBoot('CanvasAnalysisNode:mount', {
      analysisId: analysisProp.id,
      analysisType: propAnalysisType,
      chartKind: propContentItem?.kind,
      mode: contentItem?.mode,
      tabId,
    });
    return () => {
      recordSnapshotBootLedgerStage('node-unmounted', {
        analysisId: analysisProp.id,
        analysisType: propAnalysisType,
        chartKind: propContentItem?.kind,
        mode: contentItem?.mode,
        tabId,
        source: 'CanvasAnalysisNode',
      });
      logSnapshotBoot('CanvasAnalysisNode:unmount', {
        analysisId: analysisProp.id,
        analysisType: propAnalysisType,
        chartKind: propContentItem?.kind,
        mode: contentItem?.mode,
        tabId,
      });
    };
  }, [debugSnapshotChart, analysis, analysisProp, analysisType, propAnalysisType, propDebugSnapshotChart, tabId]);

  const { result, loading, waitingForDeps, error, backendUnavailable, refresh } = useCanvasAnalysisCompute({
    analysis,
    tabId,
    activeContentIndex: clampedIndex,
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
      chartKind: propContentItem?.kind,
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
    propContentItem?.kind,
    loading,
    waitingForDeps,
    result,
    error,
    backendUnavailable,
  ]);

  const [availableAnalyses, setAvailableAnalyses] = useState<AvailableAnalysis[]>([]);
  const hasAnalysisType = !!contentItem?.analysis_type;
  const analyticsDsl = contentItem?.analytics_dsl;

  // Reactive scenario state for live mode — drives visibleScenarioIds, scenarioMetaById, etc.
  // Must depend on tabContext.tabs (not the ref) so the memo re-evaluates when scenario
  // visibility changes.
  const liveScenarioState = useMemo(() => {
    if (contentItem?.mode !== 'live' || !tabId) return null;
    const tab = tabContext.tabs.find((t: any) => t.id === tabId);
    return tab?.editorState?.scenarioState ?? null;
  }, [contentItem?.mode, tabId, tabContext.tabs]);

  const visibleScenarioIds = useMemo(() => {
    if (contentItem?.mode !== 'live' && contentItem?.scenarios) {
      const hidden = new Set<string>((((contentItem.display as any)?.hidden_scenarios) || []) as string[]);
      return contentItem.scenarios
        .map(s => s.scenario_id)
        .filter((id) => !hidden.has(id));
    }
    if (tabId && liveScenarioState) {
      // Derive order from scenarioOrder (same source the panel uses) so chart
      // left-to-right matches panel bottom-to-top.  scenarioOrder is newest-first
      // (prepended), so reversing gives composition order (bottom-to-top).
      const visibleSet = new Set(liveScenarioState.visibleScenarioIds || ['current']);
      const order = liveScenarioState.scenarioOrder || [];
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
  }, [contentItem?.mode, contentItem?.scenarios, contentItem?.display, tabId, liveScenarioState]);

  const scenarioCount = visibleScenarioIds.length || 1;
  // True when Live mode has user scenarios but ScenariosContext hasn't hydrated yet.
  // Used to gate chart/expression rendering so cached results aren't shown with
  // fallback colours before real scenario metadata is available.
  const awaitingScenariosHydration = contentItem?.mode === 'live'
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
    console.log('[CanvasAnalysisNode] resolveAnalysisType', { analysisId: analysis.id?.slice(0, 8), analyticsDsl, scenarioCount, mode: contentItem?.mode });
    resolveAnalysisType(graph, analyticsDsl || undefined, scenarioCount).then(({ availableAnalyses: resolved }) => {
      if (!cancelled) {
        console.log('[CanvasAnalysisNode] resolved', { analysisId: analysis.id?.slice(0, 8), availableIds: resolved.map(a => a.id), scenarioCount });
        setAvailableAnalyses(resolved);
      }
    });
    return () => { cancelled = true; };
  }, [analyticsDsl, scenarioCount, storeHandle]);

  const scenarioVisibilityModes = useMemo(() => {
    const m: Record<string, 'f+e' | 'f' | 'e'> = {};
    for (const id of visibleScenarioIds) {
      if (contentItem?.mode !== 'live' && contentItem?.scenarios) {
        const s = contentItem.scenarios.find(s => s.scenario_id === id);
        m[id] = (s?.visibility_mode as any) || 'f+e';
      } else {
        m[id] = tabId ? operationsRef.current.getScenarioVisibilityMode(tabId, id) : 'f+e';
      }
    }
    return m;
  }, [visibleScenarioIds, contentItem, tabId]);

  const scenarioMetaById = useMemo(() => {
    const m: Record<string, { name?: string; colour?: string; visibility_mode?: 'f+e' | 'f' | 'e' }> = {};
    for (const id of visibleScenarioIds) {
      if (contentItem?.mode !== 'live' && contentItem?.scenarios) {
        const s = contentItem.scenarios.find(s => s.scenario_id === id);
        if (s) {
          // In custom mode, 'current' underlayer gets its colour from the tab context
          const colour = contentItem.mode === 'custom' && id === 'current' && tabId
            ? operationsRef.current.getEffectiveScenarioColour(tabId, 'current', scenariosContext as any)
            : (s.colour || '#808080');
          m[id] = {
            name: s.name || id,
            colour,
            visibility_mode: (s.visibility_mode as any) || 'f+e',
          };
        }
      } else {
        // Solo scenario → neutral grey; multi-scenario → real colour
        const isSolo = visibleScenarioIds.length <= 1;
        const resolveColour = (scenarioId: string): string => {
          if (isSolo) return '#808080';
          if (scenarioId === 'current') return (scenariosContextRef.current as any)?.currentColour || '#3b82f6';
          if (scenarioId === 'base') return (scenariosContextRef.current as any)?.baseColour || '#6b7280';
          const s = (scenariosContextRef.current as any)?.scenarios?.find((x: any) => x.id === scenarioId);
          return s?.colour || '#808080';
        };
        if (id === 'current') {
          m[id] = {
            name: 'Current',
            colour: resolveColour(id),
            visibility_mode: scenarioVisibilityModes[id] || 'f+e',
          };
        } else if (id === 'base') {
          m[id] = {
            name: 'Base',
            colour: resolveColour(id),
            visibility_mode: scenarioVisibilityModes[id] || 'f+e',
          };
        } else {
          const s = (scenariosContextRef.current as any)?.scenarios?.find((x: any) => x.id === id);
          m[id] = {
            name: s?.name || id,
            colour: resolveColour(id),
            visibility_mode: scenarioVisibilityModes[id] || 'f+e',
          };
        }
      }
    }
    return m;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- scenariosReady triggers recompute
  // when context hydrates so we read correct colours from the ref instead of fallbacks.
  }, [visibleScenarioIds, contentItem?.mode, contentItem?.scenarios, scenarioVisibilityModes, scenariosReady]);

  // Build scenario layer items for the toolbar popover
  const allScenarioLayerItems = useMemo((): ScenarioLayerItem[] => {
    const hiddenSet = new Set<string>(((contentItem?.display as any)?.hidden_scenarios || []) as string[]);
    if (contentItem?.mode === 'live') {
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
    // Custom/fixed mode: show all recipe scenarios (including hidden)
    const frozenScenarios = contentItem?.scenarios || [];
    const isCustom = contentItem?.mode === 'custom';
    return frozenScenarios.map(fs => {
      const colour = isCustom && fs.scenario_id === 'current' && tabId
        ? operationsRef.current.getEffectiveScenarioColour(tabId, 'current', scenariosContext as any)
        : (fs.colour || '#808080');
      return {
        id: fs.scenario_id,
        name: fs.name || fs.scenario_id,
        colour,
        visible: !hiddenSet.has(fs.scenario_id),
        visibilityMode: (fs.visibility_mode || 'f+e') as 'f+e' | 'f' | 'e',
        kind: (isCustom && fs.scenario_id === 'current' ? 'base' as const : 'user' as const),
      };
    });
  }, [contentItem?.mode, contentItem?.scenarios, contentItem?.display, visibleScenarioIds, scenarioMetaById, scenariosContext]);

  // DSL subtitles for scenario cards
  const scenarioDslSubtitleById = useMemo(() => {
    const frozenScenarios = contentItem?.scenarios || [];
    const m: Record<string, string> = {};
    for (const s of frozenScenarios) {
      const dsl = typeof s?.effective_dsl === 'string' ? s.effective_dsl.trim() : '';
      if (dsl) m[s.scenario_id] = dsl;
    }
    return Object.keys(m).length ? m : undefined;
  }, [contentItem?.scenarios]);

  // Filtered result for cards/table: only visible scenarios, patched metadata
  const expressionResult = useMemo(() => {
    if (!result) return null;
    return filterResultForScenarios(result, visibleScenarioIds, scenarioMetaById);
  }, [result, visibleScenarioIds, scenarioMetaById]);

  // Mutate recipe scenarios with auto-promotion from live → custom
  const mutateScenarios = useCallback((mutator: (scenarios: any[], display: any) => { scenarios?: any[]; display?: any }) => {
    const ci = contentItem;
    if (!ci) return;
    if (ci.mode === 'live') {
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
      const result = mutator(captured, ci.display || {});
      onUpdate(analysis.id, {
        content_items: analysis.content_items.map((item, i) =>
          i === clampedIndex
            ? { ...item, mode: 'custom' as const, scenarios: result.scenarios ?? captured, what_if_dsl, display: result.display !== undefined ? result.display : item.display }
            : item,
        ),
      } as any);
    } else {
      const scenarios = [...(ci.scenarios || [])];
      const result = mutator(scenarios, ci.display || {});
      const changes: Partial<ContentItem> = {};
      if (result.scenarios !== undefined) changes.scenarios = result.scenarios;
      if (result.display !== undefined) changes.display = result.display as any;
      if (Object.keys(changes).length > 0) {
        onUpdate(analysis.id, {
          content_items: analysis.content_items.map((item, i) =>
            i === clampedIndex ? { ...item, ...changes } : item,
          ),
        } as any);
      }
    }
  }, [analysis, contentItem, clampedIndex, onUpdate, tabId, currentDSL]);

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

  const handleScenarioDelete = useCallback((id: string) => {
    mutateScenarios((scenarios, display) => {
      const filtered = scenarios.filter((sc: any) => sc.scenario_id !== id);
      const hidden = [...(((display as any)?.hidden_scenarios) || []) as string[]].filter(sid => sid !== id);
      return { scenarios: filtered, display: { ...display, hidden_scenarios: hidden } };
    });
  }, [mutateScenarios]);

  const handleScenarioReorder = useCallback((fromIndex: number, toIndex: number) => {
    mutateScenarios((scenarios) => {
      const userScenarios = scenarios.filter((s: any) => s.scenario_id !== 'current' || contentItem?.mode !== 'custom');
      const currentUnderlayer = contentItem?.mode === 'custom' ? scenarios.find((s: any) => s.scenario_id === 'current') : null;
      const arr = [...userScenarios];
      const [moved] = arr.splice(fromIndex, 1);
      arr.splice(toIndex, 0, moved);
      if (currentUnderlayer) arr.push(currentUnderlayer);
      return { scenarios: arr };
    });
  }, [mutateScenarios, contentItem?.mode]);

  const handleScenarioEdit = useCallback((id: string) => {
    // In custom mode, 'current' underlayer is not editable
    if (contentItem?.mode === 'custom' && id === 'current') return;
    // Open the properties panel and request DSL edit for this scenario
    window.dispatchEvent(new CustomEvent('dagnet:openAnalysisProperties', { detail: { analysisId: analysis.id } }));
    // Small delay to let the panel mount before requesting edit
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('dagnet:editScenarioDsl', { detail: { analysisId: analysis.id, scenarioId: id } }));
    }, 100);
  }, [analysis.id, contentItem?.mode]);

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
    if (!contentItem) return;
    const ciClone = structuredClone(contentItem);
    let captured: { scenarios: any[]; what_if_dsl?: string } | null = null;
    if (contentItem.mode === 'live') {
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
    const liveColour = tabId ? operationsRef.current.getEffectiveScenarioColour(tabId, 'current', scenariosContext as any) : undefined;
    advanceMode(ciClone, currentDSL || '', captured, liveColour);
    onUpdate(analysis.id, {
      content_items: analysis.content_items.map((item, i) =>
        i === clampedIndex ? ciClone : item,
      ),
    } as any);
  }, [analysis, contentItem, clampedIndex, onUpdate, tabId, currentDSL]);

  const handleOverlayToggle = useCallback((active: boolean) => {
    const ciDisplay = contentItem?.display || {};
    const colour = (ciDisplay as any).subject_overlay_colour || '#3b82f6';
    // Write to active content item's display (per-tab overlay)
    onUpdate(analysis.id, {
      content_items: analysis.content_items?.map((ci, i) =>
        i === clampedIndex
          ? { ...ci, display: { ...ci.display, show_subject_overlay: active, ...(active ? { subject_overlay_colour: colour } : {}) } as any }
          : ci,
      ),
    } as any);
  }, [analysis, onUpdate, contentItem, clampedIndex]);

  const handleOverlayColourChange = useCallback((colour: string | null) => {
    onUpdate(analysis.id, {
      content_items: analysis.content_items?.map((ci, i) =>
        i === clampedIndex
          ? { ...ci, display: { ...ci.display, show_subject_overlay: !!colour, subject_overlay_colour: colour || undefined } as any }
          : ci,
      ),
    } as any);
  }, [analysis, onUpdate, clampedIndex]);

  const handleRemoveContentItem = useCallback((contentItemId: string) => {
    const clone = structuredClone(analysis);
    const shouldDelete = removeContentItem(clone, contentItemId);
    if (shouldDelete) {
      onDelete(analysis.id);
    } else {
      onUpdate(analysis.id, { content_items: clone.content_items } as any);
    }
  }, [analysis, onUpdate, onDelete]);

  // --- Analysis type picker popover (title bar dropdown) ---
  const [typePickerAnchor, setTypePickerAnchor] = useState<{ x: number; y: number } | null>(null);

  const handleAddContentItem = useCallback(() => {
    console.log('[CanvasAnalysisNode] handleAddContentItem FIRED (+ button)', {
      analysisId: analysis.id?.slice(0, 12),
      existingItems: analysis.content_items?.length,
    });
    const clone = structuredClone(analysis);
    // New tab inherits the active tab's DSL
    const activeItem = clone.content_items?.[clampedIndex];
    addContentItem(clone, {
      analytics_dsl: activeItem?.analytics_dsl,
      chart_current_layer_dsl: activeItem?.chart_current_layer_dsl,
      title: 'New analysis',
    });
    onUpdate(analysis.id, { content_items: clone.content_items } as any);
    setActiveContentIndex(clone.content_items!.length - 1);
  }, [analysis, clampedIndex, onUpdate]);

  const handleShowChangeTypePicker = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setTypePickerAnchor({ x: rect.left, y: rect.bottom + 2 });
  }, []);

  // ── Tab drag complete → dispatch extraction event ──
  const handleTabDragComplete = useCallback((outcome: TabDragOutcome) => {
    window.dispatchEvent(new CustomEvent('dagnet:extractContentItem', {
      detail: {
        sourceAnalysisId: analysis.id,
        contentItemId: outcome.contentItem.id,
        screenX: outcome.screenX,
        screenY: outcome.screenY,
        duplicate: outcome.duplicate,
        targetAnalysisId: outcome.targetAnalysisId,
      },
    }));
  }, [analysis.id]);

  const handleOpenContentItemAsTab = useCallback((ci: ContentItem) => {
    if (!result) return;
    const ciKind = ci.kind || result?.semantics?.chart?.recommended;
    if (!ciKind) return;
    const currentTab = tabId ? tabsRef.current.find(t => t.id === tabId) : undefined;
    chartOperationsService.openAnalysisChartTabFromAnalysis({
      chartKind: ciKind as any,
      analysisResult: result,
      scenarioIds: visibleScenarioIds,
      source: {
        parent_tab_id: tabId,
        parent_file_id: currentTab?.fileId,
        query_dsl: contentItem?.analytics_dsl,
        analysis_type: ci.analysis_type,
      },
      render: {
        view_mode: ci.view_type as ViewMode | undefined,
        chart_kind: ci.kind,
        display: ci.display as Record<string, unknown> | undefined,
      },
    });
  }, [result, tabId, visibleScenarioIds, contentItem?.analytics_dsl]);

  const chartSource = useMemo(() => {
    const currentTab = tabId ? tabsRef.current.find(t => t.id === tabId) : undefined;
    return {
      parent_tab_id: tabId,
      parent_file_id: currentTab?.fileId,
      query_dsl: contentItem?.analytics_dsl,
      analysis_type: contentItem?.analysis_type,
    };
  }, [tabId, contentItem?.analytics_dsl, contentItem?.analysis_type]);

  const displayTitle = contentItem.title || result?.analysis_name || contentItem.analysis_type || 'Analysis';

  // Graph for DSL editor in toolbar badge popover (autocomplete suggestions)
  const graphForDsl = useGraphStore(s => s.graph);

  const handleDslChange = useCallback((dsl: string) => {
    onUpdate(analysis.id, {
      content_items: analysis.content_items.map((item, i) =>
        i === clampedIndex ? { ...item, analytics_dsl: dsl || undefined } : item,
      ),
    } as any);
  }, [analysis, clampedIndex, onUpdate]);

  // ── Stable callbacks for table/cards view (prevent re-renders from inline closures) ──
  const handleDisplayChangeBatch = useCallback((keyOrBatch: string | Record<string, any>, value?: any) => {
    const patch = typeof keyOrBatch === 'object' ? keyOrBatch : { [keyOrBatch]: value };
    onUpdate(analysis.id, {
      content_items: analysis.content_items.map((item, i) =>
        i === clampedIndex ? { ...item, display: { ...item.display, ...patch } } : item,
      ),
    } as any);
  }, [analysis, clampedIndex, onUpdate]);

  const handleViewModeChange = useCallback((mode: ViewMode) => {
    onUpdate(analysis.id, {
      content_items: analysis.content_items.map((item, i) =>
        i === clampedIndex ? { ...item, view_type: mode } : item,
      ),
    } as any);
  }, [analysis, clampedIndex, onUpdate]);

  const handleTableSortChange = useCallback((col: string, dir: 'asc' | 'desc') => {
    onUpdate(analysis.id, {
      content_items: analysis.content_items.map((item, i) =>
        i === clampedIndex ? { ...item, display: { ...item.display, table_sort_column: col, table_sort_direction: dir } } : item,
      ),
    } as any);
  }, [analysis, clampedIndex, onUpdate]);

  const handleTableHiddenColumnsChange = useCallback((hidden: string[]) => {
    onUpdate(analysis.id, {
      content_items: analysis.content_items.map((item, i) =>
        i === clampedIndex ? { ...item, display: { ...item.display, table_hidden_columns: hidden } } : item,
      ),
    } as any);
  }, [analysis, clampedIndex, onUpdate]);

  const handleTableColumnOrderChange = useCallback((order: string[]) => {
    onUpdate(analysis.id, {
      content_items: analysis.content_items.map((item, i) =>
        i === clampedIndex ? { ...item, display: { ...item.display, table_column_order: order } } : item,
      ),
    } as any);
  }, [analysis, clampedIndex, onUpdate]);

  const handleTableColumnWidthsChange = useCallback((widths: string) => {
    onUpdate(analysis.id, {
      content_items: analysis.content_items.map((item, i) =>
        i === clampedIndex ? { ...item, display: { ...item.display, table_column_widths: widths } } : item,
      ),
    } as any);
  }, [analysis, clampedIndex, onUpdate]);

  const handleCollapsedCardsChange = useCallback((collapsed: string[]) => {
    onUpdate(analysis.id, {
      content_items: analysis.content_items.map((item, i) =>
        i === clampedIndex ? { ...item, display: { ...item.display, cards_collapsed: collapsed } } : item,
      ),
    } as any);
  }, [analysis, clampedIndex, onUpdate]);

  const handleDeleteSelf = useCallback(() => onDelete(analysis.id), [analysis.id, onDelete]);

  // ── Pre-resolved display settings for table/cards (avoids IIFE + inline resolve) ──
  // Expression view (generic cards/table) only applies when the content item
  // doesn't have a specific kind — card-kind items (overview, evidence, etc.)
  // are rendered by the cards branch in renderContent, not by renderExtra.
  const expressionViewMode = (contentItem.view_type === 'cards' || contentItem.view_type === 'table')
    && !contentItem.kind
    ? contentItem.view_type as ViewMode : null;
  const resolvedExpressionDisplay = useMemo(() => {
    if (!expressionViewMode) return null;
    const settings = getDisplaySettings(undefined, expressionViewMode);
    const resolve = (key: string) => {
      const s = settings.find(s => s.key === key);
      return s ? resolveDisplaySetting(contentItem.display as Record<string, unknown> | undefined, s) : undefined;
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
  }, [expressionViewMode, contentItem.display]);

  // Memoize the tray element to prevent ChartFloatingIcon re-renders
  const expressionTray = useMemo(() => {
    if (!expressionViewMode) return null;
    return (
      <ExpressionToolbarTray
        viewMode={expressionViewMode}
        result={result}
        display={contentItem.display as Record<string, unknown> | undefined}
        onViewModeChange={handleViewModeChange}
        onDisplayChange={handleDisplayChangeBatch}
        onDelete={handleDeleteSelf}
      />
    );
  }, [expressionViewMode, result, contentItem.display, handleViewModeChange, handleDisplayChangeBatch, handleDeleteSelf]);

  const handleChartKindChange = useCallback((kind: string | undefined) => {
    const currentGraph = storeHandle?.getState?.()?.graph;
    const currentAnalysis = currentGraph?.canvasAnalyses?.find((a: any) => a.id === analysis.id);
    const items = currentAnalysis?.content_items || analysis.content_items;
    const ci = items[clampedIndex];
    // Update title from kind registry if available
    const kindMeta = ci?.analysis_type ? getKindsForView(ci.analysis_type, ci.view_type || 'chart').find(k => k.id === kind) : undefined;
    const title = kindMeta?.name || kind?.replace(/[_-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) || ci?.title;
    onUpdate(analysis.id, {
      content_items: items.map((item: any, i: number) =>
        i === clampedIndex ? { ...item, kind: kind || undefined, title } : item,
      ),
    } as any);
  }, [analysis, clampedIndex, onUpdate, storeHandle]);

  const handleAnalysisTypeChange = useCallback((typeId: string) => {
    const currentGraph = storeHandle?.getState?.()?.graph;
    const nextGraph = setContentItemAnalysisType(currentGraph, analysis.id, clampedIndex, typeId);
    if (nextGraph) onUpdate(analysis.id, { content_items: nextGraph.canvasAnalyses?.find((a: any) => a.id === analysis.id)?.content_items } as any);
  }, [analysis.id, clampedIndex, onUpdate, storeHandle]);

  const handleTypePickerSelect = useCallback((typeId: string) => {
    handleAnalysisTypeChange(typeId);
    setTypePickerAnchor(null);
  }, [handleAnalysisTypeChange]);

  const minimisedAnchor = (analysis as any).minimised_anchor as 'tl' | 'tr' | 'bl' | 'br' | undefined;

  // Dynamic minimised dimensions — use analysis type's declared size if available
  const typeMeta = getAnalysisTypeMeta(contentItem?.analysis_type || '');
  const minimisedDims = (typeMeta?.renderMinimised && typeMeta?.minimisedSize)
    ? typeMeta.minimisedSize
    : { width: 32, height: 32 };

  const handleMinimise = useCallback((anchor: 'tl' | 'tr' | 'bl' | 'br') => {
    suppressHint();
    window.dispatchEvent(new Event('dagnet:hideConnectors'));
    const mw = minimisedDims.width, mh = minimisedDims.height;
    const dx = (anchor === 'tr' || anchor === 'br') ? analysis.width - mw : 0;
    const dy = (anchor === 'bl' || anchor === 'br') ? analysis.height - mh : 0;
    onUpdate(analysis.id, {
      minimised: true, minimised_anchor: anchor,
      x: analysis.x + dx, y: analysis.y + dy,
    } as any);
  }, [analysis.id, analysis.x, analysis.y, analysis.width, analysis.height, minimisedDims.width, minimisedDims.height, onUpdate, suppressHint]);

  const handleRestore = useCallback(() => {
    suppressHint();
    window.dispatchEvent(new Event('dagnet:hideConnectors'));
    const anchor = minimisedAnchor || 'tl';
    const mw = minimisedDims.width, mh = minimisedDims.height;
    const dx = (anchor === 'tr' || anchor === 'br') ? analysis.width - mw : 0;
    const dy = (anchor === 'bl' || anchor === 'br') ? analysis.height - mh : 0;
    onUpdate(analysis.id, {
      minimised: false,
      x: analysis.x - dx, y: analysis.y - dy,
    } as any);
  }, [analysis.id, analysis.x, analysis.y, analysis.width, analysis.height, minimisedAnchor, minimisedDims.width, minimisedDims.height, onUpdate, suppressHint]);

  // Auto-dismiss hover label after 5s to prevent stale labels
  useEffect(() => {
    if (!hovered || !minimised) return;
    const t = setTimeout(() => hoverOff(), 5000);
    return () => clearTimeout(t);
  }, [hovered, minimised]);

  // ── Minimised rendering ──────────────────────────────────────────────
  if (minimised) {
    const iconSize = 22;
    const TypeIcon = typeMeta?.icon || BarChart3;
    const mw = minimisedDims.width;
    const mh = minimisedDims.height;

    // Try custom minimised renderer — falls back to generic icon if null
    const cachedResult = contentItemResultCache.get(contentItem?.id) || canvasAnalysisResultCache.get(analysis.id) || result;
    const resolvedSettings = contentItem?.display as Record<string, any> || {};

    const defaultLabel = subjectLabel
      ? `${subjectLabel} — ${contentItem.title || contentItem.analysis_type || 'Analysis'}`
      : (contentItem.title || contentItem.analysis_type || 'Analysis');
    const minimisedLabel = typeMeta?.minimisedLabel?.({ result: cachedResult, settings: resolvedSettings, label: subjectLabel })
      || defaultLabel;
    const customContent = typeMeta?.renderMinimised
      ? typeMeta.renderMinimised({ result: cachedResult, settings: resolvedSettings, label: subjectLabel })
      : null;
    const hasCustomContent = customContent != null;

    return (
      <>
        <MinimiseCornerArrows
          minimisedAnchor={minimisedAnchor || 'tl'}
          visible={hovered}
          disabled={dragging || selected}
          zoom={zoom}
          nodeWidth={mw}
          nodeHeight={mh}
          colour="var(--text-primary, #555)"
          onMinimise={handleMinimise}
          onRestore={handleRestore}
          onMouseEnter={hoverOn}
          onMouseLeave={hoverOff}
          onCornerHover={setCornerHintGuarded}
        />

        {/* Selection UI: delete button + border highlight */}
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

        {/* Ghost outline showing full-size bounds on hover */}
        {(() => {
          const anchor = minimisedAnchor || 'tl';
          const ghostLeft = (anchor === 'tr' || anchor === 'br') ? -(analysis.width - mw) : 0;
          const ghostTop = (anchor === 'bl' || anchor === 'br') ? -(analysis.height - mh) : 0;
          const originX = (anchor === 'tr' || anchor === 'br') ? 'right' : 'left';
          const originY = (anchor === 'bl' || anchor === 'br') ? 'bottom' : 'top';
          return (
            <div
              className={iconHovered ? 'minimised-ghost-expand' : 'minimised-ghost-collapse'}
              style={{
                position: 'absolute', left: ghostLeft, top: ghostTop,
                width: analysis.width, height: analysis.height,
                border: '1.5px dashed var(--canvas-analysis-border, rgba(0,0,0,0.12))',
                borderRadius: 8 / zoom,
                pointerEvents: 'none',
                transformOrigin: `${originY} ${originX}`,
              }}
            />
          );
        })()}

        <div
          className="canvas-analysis-node canvas-annotation-minimised"
          data-anchor={minimisedAnchor || 'tl'}
          onClick={(e) => {
            if (!e.ctrlKey && !e.metaKey && !e.shiftKey) {
              e.stopPropagation();
              suppressHint();
              window.dispatchEvent(new Event('dagnet:hideConnectors'));
              const anchor = minimisedAnchor || 'tl';
              const dx = (anchor === 'tr' || anchor === 'br') ? analysis.width - mw : 0;
              const dy = (anchor === 'bl' || anchor === 'br') ? analysis.height - mh : 0;
              const rid = analysis.id, rx = analysis.x - dx, ry = analysis.y - dy;
              requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => {
                onUpdate(rid, { minimised: false, x: rx, y: ry } as any);
              })));
            }
          }}
          onMouseEnter={() => {
            hoverOn();
            window.dispatchEvent(new CustomEvent('dagnet:analysisHover', { detail: { analysisId: analysis.id } }));
          }}
          onMouseLeave={() => {
            hoverOff();
            window.dispatchEvent(new CustomEvent('dagnet:analysisHover', { detail: { analysisId: null } }));
          }}
          style={{
            width: mw, height: mh,
            ...(hasCustomContent ? {
              // Custom minimised content: soft box — present but quiet
              background: 'color-mix(in srgb, var(--canvas-analysis-bg, #ffffff) 50%, transparent)',
              border: selected ? '2px solid #3b82f6' : '0.5px solid rgba(0,0,0,0.08)',
              outline: selected
                ? `6px solid ${contentItem.display?.subject_overlay_colour || '#3b82f6'}1a`
                : 'none',
              boxShadow: selected
                ? '0 0 0 1px #3b82f6'
                : '0 1px 2px rgba(0,0,0,0.06)',
            } : {
              // Generic icon: standard boxed appearance
              background: 'var(--canvas-analysis-bg, #ffffff)',
              border: selected ? '2px solid #3b82f6' : '1px solid var(--canvas-analysis-border, #d1d5db)',
              outline: (selected || contentItem.display?.show_subject_overlay)
                ? `6px solid ${contentItem.display?.subject_overlay_colour || '#3b82f6'}${selected ? '1a' : '0d'}`
                : 'none',
              boxShadow: selected
                ? '0 0 0 1px #3b82f6, 0 1px 3px rgba(0,0,0,0.08)'
                : '0 1px 3px rgba(0,0,0,0.08), 0 4px 12px rgba(0,0,0,0.06)',
            }),
            outlineOffset: -1,
            borderRadius: 8 / zoom,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'hidden',
          }}
        >
          {hasCustomContent
            ? customContent
            : <TypeIcon size={iconSize} style={{ color: 'var(--canvas-analysis-title, #374151)', opacity: 0.85 }} />
          }
        </div>

        {/* Hover label — vertically centred beside the minimised box */}
        {hovered && (
          <div className="nodrag nopan" style={{
            position: 'absolute',
            ...((minimisedAnchor === 'tr' || minimisedAnchor === 'br') ? { right: mw + 2 } : { left: mw + 2 }),
            top: 0, height: mh,
            display: 'flex', alignItems: 'center',
            fontSize: 12 / zoom, lineHeight: 1,
            color: 'var(--canvas-analysis-title, #374151)',
            whiteSpace: 'nowrap', pointerEvents: 'none', userSelect: 'none',
            background: 'color-mix(in srgb, var(--canvas-analysis-bg, #ffffff) 70%, transparent)',
            backdropFilter: 'blur(6px)',
            borderRadius: 8 / zoom, padding: `${2 / zoom}px ${6 / zoom}px`,
            transition: 'left 300ms cubic-bezier(0.25, 0.1, 0.25, 1) 80ms',
          }}>
            {minimisedLabel}
          </div>
        )}
      </>
    );
  }

  // ── Normal rendering ─────────────────────────────────────────────────
  return (
    <>
    <MinimiseCornerArrows
      visible={hovered && !dragging && !selected}
      zoom={zoom}
      nodeWidth={analysis.width}
      nodeHeight={analysis.height}
      colour="var(--text-primary, #555)"
      onMinimise={handleMinimise}
      onRestore={handleRestore}
      onMouseEnter={hoverOn}
      onMouseLeave={hoverOff}
      onCornerHover={setCornerHintGuarded}
    />
    {/* Ghost outline — original bounds while shrinking */}
    <div style={{
      position: 'absolute', inset: 0,
      border: '1.5px dashed var(--canvas-analysis-border, rgba(0,0,0,0.12))',
      borderRadius: 8 / zoom,
      opacity: cornerHint ? 0.8 : 0,
      transition: cornerHint
        ? 'opacity 300ms ease 200ms'
        : 'opacity 200ms ease',
      pointerEvents: 'none',
    }} />
    <div
      className={`canvas-analysis-node${selected ? ' nowheel' : ''}${justRestored ? ' canvas-annotation-normal' : ''}`}
      {...(restoredAnchor ? { 'data-anchor': restoredAnchor } : {})}
      onMouseEnter={() => {
        hoverOn();
        window.dispatchEvent(new CustomEvent('dagnet:analysisHover', { detail: { analysisId: analysis.id } }));
      }}
      onMouseLeave={() => {
        hoverOff();
        window.dispatchEvent(new CustomEvent('dagnet:analysisHover', { detail: { analysisId: null } }));
      }}
      style={{
        width: '100%',
        height: '100%',
        background: 'var(--canvas-analysis-bg, #ffffff)',
        border: '1px solid var(--canvas-analysis-border, #d1d5db)',
        outline: (selected || contentItem.display?.show_subject_overlay)
          ? `12px solid ${contentItem.display?.subject_overlay_colour || '#3b82f6'}${selected ? '1a' : '0d'}`
          : 'none',
        outlineOffset: -1,
        borderRadius: 8 / zoom,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        boxShadow: selected
          ? '0 4px 12px rgba(0,0,0,0.10), 0 12px 32px rgba(0,0,0,0.12)'
          : '0 1px 3px rgba(0,0,0,0.08), 0 4px 12px rgba(0,0,0,0.06)',
        transform: cornerHint
          ? `scale(${(analysis.width - 12) / analysis.width}, ${(analysis.height - 12) / analysis.height})`
          : undefined,
        transformOrigin: CORNER_ORIGINS[cornerHint ?? lastCornerRef.current ?? 'tl'],
        transition: 'transform 300ms cubic-bezier(0.25, 0.1, 0.25, 1) 200ms, box-shadow 0.15s ease-out',
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
        handleStyle={{ width: 8 / zoom, height: 8 / zoom, borderRadius: 2 / zoom, backgroundColor: '#3b82f6', border: '1px solid var(--bg-primary)' }}
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

      {/* Title bar — dropzone for tab drag. Chrome: inverse zoom so always readable. */}
      <div
        data-dropzone={`analysis-${analysis.id}`}
        style={{
          padding: '4px 8px',
          fontSize: 10,
          fontWeight: 600,
          color: 'var(--canvas-analysis-title, #374151)',
          borderBottom: '1px solid var(--canvas-analysis-border, #e5e7eb)',
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          background: 'var(--canvas-analysis-title-bg, #f9fafb)',
          minWidth: 0,
          ...chromeZoomStyle,
        }}
      >
        {/* Subject label (from DSL) + analysis type select (folded when single tab) */}
        {subjectLabel ? (
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flexShrink: 1 }}>
            <span title={subjectLabel}>{subjectLabel}</span>
            {contentItems.length <= 1 && (
              <>
                <span style={{ fontWeight: 400, color: 'var(--text-muted, #6b7280)' }}>{' — '}</span>
                <button
                  type="button"
                  className="nodrag canvas-analysis-type-select"
                  onClick={handleShowChangeTypePicker}
                  title="Change analysis type"
                  style={{
                    all: 'unset', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 2,
                    fontWeight: 400, color: 'var(--text-muted, #6b7280)', fontSize: 'inherit',
                  }}
                >
                  {(() => {
                    const meta = getAnalysisTypeMeta(contentItem.analysis_type || '');
                    const Icon = meta?.icon;
                    return (
                      <>
                        {Icon && <Icon size={9} strokeWidth={2} />}
                        {meta?.name || contentItem.analysis_type || 'Choose type'}
                        <ChevronDown size={8} />
                      </>
                    );
                  })()}
                </button>
              </>
            )}
          </span>
        ) : (
          <InlineEditableLabel
            value={contentItem.title || ''}
            placeholder={result?.analysis_name || contentItem.analysis_type || 'Choose analysis type'}
            selected={!!selected}
            onCommit={(v) => onUpdate(analysis.id, {
              content_items: analysis.content_items.map((item, i) =>
                i === clampedIndex ? { ...item, title: v } : item,
              ),
            } as any)}
            displayStyle={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}
            editStyle={{ minWidth: 0 }}
          />
        )}
        <span className={`canvas-analysis-mode-badge canvas-analysis-mode-badge--${contentItem?.mode === 'live' && !contentItem?.chart_current_layer_dsl ? 'live' : contentItem?.mode}`}>
          {contentItem?.mode === 'live' && !contentItem?.chart_current_layer_dsl ? 'LIVE' : contentItem?.mode === 'custom' ? 'CUSTOM' : 'FIXED'}
        </span>
        {hasAnalysisType && (loading || waitingForDeps) && <Loader2 size={12} style={{ animation: 'spin 1s linear infinite', flexShrink: 0 }} />}
        <span style={{ flex: 1 }} />
        {result && (
          <button
            type="button"
            className="canvas-analysis-title-btn"
            onClick={(e) => {
              e.stopPropagation();
              const ciKind = contentItem.kind || result?.semantics?.chart?.recommended;
              if (ciKind) {
                chartOperationsService.openAnalysisChartTabFromAnalysis({
                  chartKind: ciKind as any,
                  analysisResult: result,
                  scenarioIds: visibleScenarioIds,
                  source: chartSource,
                  render: {
                    view_mode: contentItem.view_type as ViewMode | undefined,
                    chart_kind: contentItem.kind,
                    display: contentItem.display as Record<string, unknown> | undefined,
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

      <CanvasAnalysisCard
        analysisId={analysis.id}
        contentItems={contentItems}
        activeContentIndex={activeContentIndex}
        onActiveContentIndexChange={setActiveContentIndex}
        connectorColour={(contentItem.display as any)?.show_subject_overlay ? ((contentItem.display as any)?.subject_overlay_colour as string | undefined) : undefined}
        style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}
        result={result}
        loading={loading}
        error={error}
        backendUnavailable={backendUnavailable}
        waitingForDeps={waitingForDeps}
        hasAnalysisType={hasAnalysisType}
        awaitingScenariosHydration={awaitingScenariosHydration}
        interactive={!!selected}
        contentZoomStyle={contentZoomStyle}
        chromeZoomStyle={chromeZoomStyle}
        onRemoveContentItem={handleRemoveContentItem}
        onAddContentItem={handleAddContentItem}
        onOpenContentItemAsTab={handleOpenContentItemAsTab}
        buildTabContextMenuItems={(ci, closeMenu) => {
          const hasOverlay = !!(ci.display as any)?.show_subject_overlay;
          const ciColour = (ci.display as any)?.subject_overlay_colour || '#3b82f6';
          const items: ContextMenuItem[] = [];

          // View Mode
          items.push({
            label: 'View Mode', onClick: () => {},
            submenu: (['chart', 'cards', 'table'] as const).map(mode => ({
              label: mode.charAt(0).toUpperCase() + mode.slice(1),
              checked: ci.view_type === mode,
              onClick: () => {
                onUpdate(analysis.id, {
                  content_items: analysis.content_items?.map(item =>
                    item.id === ci.id ? { ...item, view_type: mode } : item,
                  ),
                } as any);
                closeMenu();
              },
            })),
          });

          // Connectors
          const connectorItems: ContextMenuItem[] = [
            {
              label: 'Show connectors',
              icon: <Crosshair size={14} />,
              checked: hasOverlay,
              onClick: () => {
                onUpdate(analysis.id, {
                  content_items: analysis.content_items?.map(item =>
                    item.id === ci.id
                      ? { ...item, display: { ...item.display, show_subject_overlay: !hasOverlay, ...(!hasOverlay ? { subject_overlay_colour: ciColour } : {}) } as any }
                      : item,
                  ),
                } as any);
                closeMenu();
              },
            },
            { label: '', onClick: () => {}, divider: true },
          ];
          for (const { name, value: hex } of OVERLAY_PRESET_COLOURS) {
            connectorItems.push({
              label: name,
              checked: hasOverlay && ciColour === hex,
              onClick: () => {
                onUpdate(analysis.id, {
                  content_items: analysis.content_items?.map(item =>
                    item.id === ci.id
                      ? { ...item, display: { ...item.display, show_subject_overlay: true, subject_overlay_colour: hex } as any }
                      : item,
                  ),
                } as any);
                closeMenu();
              },
            });
          }
          items.push({ label: 'Connectors', icon: <Crosshair size={14} />, onClick: () => {}, submenu: connectorItems });

          // Display
          const ciKind = ci.kind;
          if (ciKind) {
            const displayItems = buildContextMenuSettingItems(
              ciKind, ci.view_type || 'chart', ci.display as Record<string, unknown> | undefined,
              (key, value) => {
                onUpdate(analysis.id, {
                  content_items: analysis.content_items?.map(item =>
                    item.id === ci.id
                      ? { ...item, display: { ...item.display, [key]: value } as any }
                      : item,
                  ),
                } as any);
              },
            );
            if (displayItems.length > 0) {
              items.push({ label: 'Display', icon: <SlidersHorizontal size={14} />, onClick: () => {}, submenu: displayItems as ContextMenuItem[] });
            }
          }

          items.push({ label: '', onClick: () => {}, divider: true });

          // Open as Tab
          items.push({
            label: 'Open as Tab',
            icon: <ExternalLink size={14} />,
            disabled: !result,
            onClick: () => { handleOpenContentItemAsTab(ci); closeMenu(); },
          });

          // Refresh
          items.push({
            label: 'Refresh',
            icon: <RefreshCw size={14} />,
            onClick: () => { refresh(); closeMenu(); },
          });

          // Close tab
          items.push({ label: '', onClick: () => {}, divider: true });
          items.push({
            label: 'Close tab',
            icon: <X size={14} />,
            onClick: () => { handleRemoveContentItem(ci.id); closeMenu(); },
          });

          return items;
        }}
        onTabOverlayToggle={(ci, active) => {
          const colour = (ci.display as any)?.subject_overlay_colour || '#3b82f6';
          onUpdate(analysis.id, {
            content_items: analysis.content_items?.map(item =>
              item.id === ci.id
                ? { ...item, display: { ...item.display, show_subject_overlay: active, ...(active ? { subject_overlay_colour: colour } : {}) } as any }
                : item,
            ),
          } as any);
        }}
        onTabOverlayColourChange={(ci, colour) => {
          onUpdate(analysis.id, {
            content_items: analysis.content_items?.map(item =>
              item.id === ci.id
                ? { ...item, display: { ...item.display, show_subject_overlay: !!colour, subject_overlay_colour: colour || undefined } as any }
                : item,
            ),
          } as any);
        }}
        onTabDragComplete={handleTabDragComplete}
        renderContent={(ci, previewOverlay) => {
          // Resolve the best available result for this content item:
          // 1. Per-item cache (snapped-in tabs with their own result)
          // 2. Hook result, if its analysis_type matches this tab
          // 3. Container-level cache (previous compute for this analysis)
          // 4. Hook result as last resort
          const perItemResult = contentItemResultCache.get(ci.id);
          const hookResultMatchesTab = result?.analysis_type === ci.analysis_type;
          const containerCachedResult = canvasAnalysisResultCache.get(analysis.id);
          const containerCacheMatchesTab = containerCachedResult?.analysis_type === ci.analysis_type;
          // Use the best matching result. If nothing matches, show null
          // (loading state) rather than wrong data from a different analysis type.
          const ciResult = perItemResult
            || (hookResultMatchesTab ? result : null)
            || (containerCacheMatchesTab ? containerCachedResult : null)
            || null;
          return (
          <>
            {ci.view_type === 'cards' && ciResult && !(awaitingScenariosHydration) && (() => {
              const cardViewportRef = React.createRef<HTMLDivElement>();
              const ciOverlayActive = !!(ci.display as any)?.show_subject_overlay;
              const ciOverlayColour = (ci.display as any)?.subject_overlay_colour;
              const cardTray = (
                <ExpressionToolbarTray
                  viewMode="cards"
                  result={ciResult}
                  display={ci.display as Record<string, unknown> | undefined}
                  kind={ci.kind}
                  analysisTypeId={ci.analysis_type}
                  availableAnalyses={availableAnalyses}
                  onAnalysisTypeChange={handleAnalysisTypeChange}
                  onKindChange={handleChartKindChange}
                  onViewModeChange={handleViewModeChange}
                  onDisplayChange={handleDisplayChangeBatch}
                  overlayActive={ciOverlayActive}
                  overlayColour={ciOverlayColour}
                  onOverlayToggle={handleOverlayToggle}
                  onOverlayColourChange={handleOverlayColourChange}
                  analysisMode={contentItem?.mode}
                  onModeCycle={handleModeCycle}
                  scenarioLayerItems={allScenarioLayerItems}
                  onScenarioToggleVisibility={handleScenarioToggleVisibility}
                  onScenarioCycleMode={handleScenarioCycleMode}
                  onScenarioColourChange={handleScenarioColourChange}
                  onScenarioDelete={handleScenarioDelete}
                  onScenarioReorder={handleScenarioReorder}
                  onScenarioEdit={handleScenarioEdit}
                  analysisId={analysis.id}
                />
              );
              return (
                <div ref={cardViewportRef} style={{ flex: 1, minHeight: 0, overflow: 'auto', position: 'relative' }}>
                  <ChartFloatingIcon containerRef={cardViewportRef} tray={cardTray} canvasZoom={toolbarCanvasZoom} />
                  <AnalysisInfoCard
                    result={ciResult}
                    kind={ci.kind}
                    fontSize={ci.display?.font_size as number | undefined}
                  />
                </div>
              );
            })()}
            {ci.view_type === 'chart' && (ciResult || !hasAnalysisType) && !(awaitingScenariosHydration) && (
              <AnalysisChartContainer
                result={ciResult}
                chartKindOverride={ci.kind}
                visibleScenarioIds={visibleScenarioIds}
                scenarioVisibilityModes={scenarioVisibilityModes}
                scenarioMetaById={scenarioMetaById}
                display={ci.display}
                onChartKindChange={handleChartKindChange}
                onDisplayChange={handleDisplayChangeBatch}
                source={chartSource}
                fillHeight
                chartContext="canvas"
                canvasZoom={toolbarCanvasZoom}
                hideScenarioLegend={contentItem?.mode === 'live' && ci.display?.show_legend === false}
                analysisTypeId={ci.analysis_type}
                availableAnalyses={availableAnalyses}
                onAnalysisTypeChange={handleAnalysisTypeChange}
                analysisMode={contentItem?.mode}
                onModeCycle={handleModeCycle}
                scenarioLayerItems={allScenarioLayerItems}
                onScenarioToggleVisibility={handleScenarioToggleVisibility}
                onScenarioCycleMode={handleScenarioCycleMode}
                onScenarioColourChange={handleScenarioColourChange}
                onScenarioDelete={handleScenarioDelete}
                onScenarioReorder={handleScenarioReorder}
                onScenarioEdit={handleScenarioEdit}
                getScenarioSwatchOverlayStyle={getScenarioSwatchOverlay}
                onAddScenario={handleAddScenario}
                overlayActive={!!ci.display?.show_subject_overlay}
                overlayColour={ci.display?.subject_overlay_colour as string | undefined}
                onOverlayToggle={handleOverlayToggle}
                onOverlayColourChange={handleOverlayColourChange}
                graph={graphForDsl}
                onDslChange={handleDslChange}
                analysisId={analysis.id}
                onDelete={handleDeleteSelf}
                viewMode={ci.view_type as ViewMode | undefined}
                onViewModeChange={handleViewModeChange}
                infoCardKind={ci.kind}
              />
            )}
            {previewOverlay}
          </>
        );
        }}
        renderExtra={() => (
          <>
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
                <div style={{ padding: 8, height: '100%', boxSizing: 'border-box' }}>
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
          </>
        )}
      />

      {/* Analysis type picker popover — portalled to body to escape ReactFlow transforms */}
      {typePickerAnchor && ReactDOM.createPortal(
        <>
          {/* Click-outside backdrop */}
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 10001 }}
            onClick={() => setTypePickerAnchor(null)}
          />
          <div
            className="nodrag nowheel"
            style={{
              position: 'fixed',
              left: typePickerAnchor.x,
              top: typePickerAnchor.y,
              zIndex: 10002,
              background: 'var(--bg-primary, #fff)',
              border: '1px solid var(--border-primary, #e5e7eb)',
              borderRadius: 8,
              boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
              padding: 8,
              maxHeight: 320,
              overflowY: 'auto',
              width: 280,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <AnalysisTypeCardList
              availableAnalyses={availableAnalyses}
              selectedAnalysisId={contentItem.analysis_type}
              onSelect={handleTypePickerSelect}
              onAddAsTab={(typeId) => {
                const clone = structuredClone(analysis);
                addContentItem(clone, {
                  analysis_type: typeId,
                  analytics_dsl: contentItem?.analytics_dsl,
                  chart_current_layer_dsl: contentItem?.chart_current_layer_dsl,
                  title: humaniseAnalysisType(typeId),
                  analysis_type_overridden: true,
                });
                onUpdate(analysis.id, { content_items: clone.content_items } as any);
                setActiveContentIndex(clone.content_items.length - 1);
                setTypePickerAnchor(null);
              }}
              showAll={false}
              viewMode="icons"
            />
          </div>
        </>,
        document.body,
      )}
    </div>
    </>
  );
}

// React.memo: prevents re-render when ReactFlow calls setNodes() for unrelated changes
// (e.g. dragging another node). GraphCanvas stabilises data.analysis reference so shallow
// comparison on `data` is sufficient to skip re-renders for unchanged analyses.
const CanvasAnalysisNode = React.memo(CanvasAnalysisNodeInner);
export default CanvasAnalysisNode;
