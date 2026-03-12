import React, { useEffect, useRef, useMemo, useState, useCallback } from 'react';
import { NodeProps, NodeResizer, useViewport } from 'reactflow';
import type { CanvasAnalysis } from '@/types';
import { useCanvasAnalysisCompute } from '@/hooks/useCanvasAnalysisCompute';
import { useGraphStore } from '@/contexts/GraphStoreContext';
import { useScenariosContextOptional } from '@/contexts/ScenariosContext';
import { useTabContext } from '@/contexts/TabContext';
import { AnalysisChartContainer } from '../charts/AnalysisChartContainer';
import { AnalysisResultCards } from '../analytics/AnalysisResultCards';
import { resolveAnalysisType } from '@/services/analysisTypeResolutionService';
import { captureTabScenariosToRecipe } from '@/services/captureTabScenariosService';
import { isSnapshotBootChart, logSnapshotBoot, recordSnapshotBootLedgerStage } from '@/lib/snapshotBootTrace';
import { Loader2, AlertCircle, ServerOff } from 'lucide-react';
import { InlineEditableLabel } from '../InlineEditableLabel';
import type { AvailableAnalysis } from '@/lib/graphComputeClient';
import type { ScenarioLayerItem } from '@/types/scenarioLayerList';
import { getScenarioVisibilityOverlayStyle } from '@/lib/scenarioVisibilityModeStyles';
import { SCENARIO_PALETTE } from '@/contexts/ScenariosContext';

interface CanvasAnalysisNodeData {
  analysis: CanvasAnalysis;
  tabId?: string;
  onUpdate: (id: string, updates: Partial<CanvasAnalysis>) => void;
  onDelete: (id: string) => void;
}

export default function CanvasAnalysisNode({ data, selected }: NodeProps<CanvasAnalysisNodeData>) {
  const { analysis: analysisProp, tabId, onUpdate, onDelete } = data;
  const { graph, currentDSL } = useGraphStore();
  const analysis = useMemo(() => {
    const fromStore = (graph as any)?.canvasAnalyses?.find((a: any) => a.id === analysisProp.id);
    return (fromStore || analysisProp) as CanvasAnalysis;
  }, [graph, analysisProp]);
  const analysisType = analysis.recipe?.analysis?.analysis_type;
  const propAnalysisType = analysisProp.recipe?.analysis?.analysis_type;
  const propDebugSnapshotChart = isSnapshotBootChart(analysisProp);
  const debugSnapshotChart = propDebugSnapshotChart;
  const resizeTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;
  const scenariosContext = useScenariosContextOptional();
  const { tabs, operations } = useTabContext();
  const { zoom } = useViewport();

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
      live: analysisProp.live,
      tabId,
      source: 'CanvasAnalysisNode',
    });
    logSnapshotBoot('CanvasAnalysisNode:mount', {
      analysisId: analysisProp.id,
      analysisType: propAnalysisType,
      chartKind: analysisProp.chart_kind,
      live: analysisProp.live,
      tabId,
    });
    return () => {
      recordSnapshotBootLedgerStage('node-unmounted', {
        analysisId: analysisProp.id,
        analysisType: propAnalysisType,
        chartKind: analysisProp.chart_kind,
        live: analysisProp.live,
        tabId,
        source: 'CanvasAnalysisNode',
      });
      logSnapshotBoot('CanvasAnalysisNode:unmount', {
        analysisId: analysisProp.id,
        analysisType: propAnalysisType,
        chartKind: analysisProp.chart_kind,
        live: analysisProp.live,
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
    if (!analysis.live && analysis.recipe.scenarios) {
      const hidden = new Set<string>((((analysis.display as any)?.hidden_scenarios) || []) as string[]);
      return analysis.recipe.scenarios
        .map(s => s.scenario_id)
        .filter((id) => !hidden.has(id));
    }
    if (tabId) {
      const state = operations.getScenarioState(tabId);
      return state?.visibleScenarioIds || ['current'];
    }
    return ['current'];
  }, [analysis.live, analysis.recipe.scenarios, analysis.display, tabId, operations, tabs]);

  const scenarioCount = visibleScenarioIds.length || 1;
  useEffect(() => {
    if (!graph) return;
    let cancelled = false;
    resolveAnalysisType(graph, analyticsDsl || undefined, scenarioCount).then(({ availableAnalyses: resolved }) => {
      if (!cancelled) setAvailableAnalyses(resolved);
    });
    return () => { cancelled = true; };
  }, [graph, analyticsDsl, scenarioCount]);

  const scenarioVisibilityModes = useMemo(() => {
    const m: Record<string, 'f+e' | 'f' | 'e'> = {};
    for (const id of visibleScenarioIds) {
      if (!analysis.live && analysis.recipe.scenarios) {
        const s = analysis.recipe.scenarios.find(s => s.scenario_id === id);
        m[id] = (s?.visibility_mode as any) || 'f+e';
      } else {
        m[id] = tabId ? operations.getScenarioVisibilityMode(tabId, id) : 'f+e';
      }
    }
    return m;
  }, [visibleScenarioIds, analysis, tabId, operations]);

  const scenarioMetaById = useMemo(() => {
    const m: Record<string, { name?: string; colour?: string; visibility_mode?: 'f+e' | 'f' | 'e' }> = {};
    for (const id of visibleScenarioIds) {
      if (!analysis.live && analysis.recipe.scenarios) {
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
            colour: (scenariosContext as any)?.currentColour || '#3b82f6',
            visibility_mode: scenarioVisibilityModes[id] || 'f+e',
          };
        } else if (id === 'base') {
          m[id] = {
            name: 'Base',
            colour: (scenariosContext as any)?.baseColour || '#6b7280',
            visibility_mode: scenarioVisibilityModes[id] || 'f+e',
          };
        } else {
          const s = (scenariosContext as any)?.scenarios?.find((x: any) => x.id === id);
          m[id] = {
            name: s?.name || id,
            colour: s?.colour || '#808080',
            visibility_mode: scenarioVisibilityModes[id] || 'f+e',
          };
        }
      }
    }
    return m;
  }, [visibleScenarioIds, analysis.live, analysis.recipe.scenarios, scenariosContext, scenarioVisibilityModes]);

  // Build scenario layer items for the toolbar popover
  const allScenarioLayerItems = useMemo((): ScenarioLayerItem[] => {
    const hiddenSet = new Set<string>(((analysis.display as any)?.hidden_scenarios || []) as string[]);
    if (analysis.live) {
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
  }, [analysis.live, analysis.recipe?.scenarios, analysis.display, visibleScenarioIds, scenarioMetaById]);

  // Mutate recipe scenarios with auto-promotion from live → custom
  const mutateScenarios = useCallback((mutator: (scenarios: any[], display: any) => { scenarios?: any[]; display?: any }) => {
    if (analysis.live) {
      const liveTabId = tabId || tabs[0]?.id;
      if (!liveTabId || !scenariosContext) return;
      const currentTab = tabs.find(t => t.id === liveTabId);
      const whatIfDSL = currentTab?.editorState?.whatIfDSL || null;
      const { scenarios: captured, what_if_dsl } = captureTabScenariosToRecipe({
        tabId: liveTabId,
        currentDSL: currentDSL || '',
        operations,
        scenariosContext: scenariosContext as any,
        whatIfDSL,
      });
      const result = mutator(captured, analysis.display || {});
      onUpdate(analysis.id, {
        live: false,
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
  }, [analysis, onUpdate, tabId, tabs, scenariosContext, operations, currentDSL]);

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

  const handleResize = useCallback((_event: any, params: { width: number; height: number }) => {
    if (resizeTimeoutRef.current) clearTimeout(resizeTimeoutRef.current);
    resizeTimeoutRef.current = setTimeout(() => {
      onUpdateRef.current(analysisIdRef.current, { width: Math.round(params.width), height: Math.round(params.height) });
    }, 200);
  }, []);


  const handleLiveToggle = useCallback((live: boolean) => {
    if (live && !analysis.live) {
      onUpdate(analysis.id, {
        live: true,
        recipe: { ...analysis.recipe, scenarios: undefined, analysis: { ...analysis.recipe.analysis, what_if_dsl: undefined } },
      } as any);
    } else if (!live && analysis.live) {
      const liveTabId = tabId || tabs[0]?.id;
      if (liveTabId && scenariosContext) {
        const currentTab = tabs.find(t => t.id === liveTabId);
        const whatIfDSL = currentTab?.editorState?.whatIfDSL || null;
        const { scenarios: captured, what_if_dsl } = captureTabScenariosToRecipe({
          tabId: liveTabId,
          currentDSL: currentDSL || '',
          operations,
          scenariosContext: scenariosContext as any,
          whatIfDSL,
        });
        onUpdate(analysis.id, {
          live: false,
          recipe: { ...analysis.recipe, scenarios: captured, analysis: { ...analysis.recipe.analysis, what_if_dsl } },
        } as any);
      }
    }
  }, [analysis, onUpdate, tabId, tabs, scenariosContext, operations, currentDSL]);

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
    const currentTab = tabId ? tabs.find(t => t.id === tabId) : undefined;
    return {
      parent_tab_id: tabId,
      parent_file_id: currentTab?.fileId,
      query_dsl: analysis.recipe?.analysis?.analytics_dsl,
      analysis_type: analysis.recipe?.analysis?.analysis_type,
    };
  }, [tabId, tabs, analysis.recipe?.analysis?.analytics_dsl, analysis.recipe?.analysis?.analysis_type]);

  const displayTitle = analysis.title || result?.analysis_name || analysis.recipe.analysis.analysis_type || 'Analysis';

  return (
    <div
      className="canvas-analysis-node"
      style={{
        width: '100%',
        height: '100%',
        background: 'var(--canvas-analysis-bg, #ffffff)',
        border: '1px solid var(--canvas-analysis-border, #d1d5db)',
        borderRadius: 8,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        boxShadow: selected
          ? '0 4px 12px rgba(0,0,0,0.10), 0 12px 32px rgba(0,0,0,0.12)'
          : '0 1px 3px rgba(0,0,0,0.08), 0 4px 12px rgba(0,0,0,0.06)',
        transition: 'box-shadow 0.15s ease-out',
      }}
    >
      <NodeResizer
        isVisible={selected}
        minWidth={300}
        minHeight={200}
        onResize={handleResize}
        lineStyle={{ display: 'none' }}
        handleStyle={{ width: 8, height: 8, borderRadius: 2, backgroundColor: '#3b82f6', border: '1px solid var(--bg-primary)' }}
      />

      {selected && (
        <button
          className="nodrag"
          onClick={(e) => { e.stopPropagation(); onDelete(analysis.id); }}
          title="Delete canvas analysis"
          style={{
            position: 'absolute', top: -10, right: -10, width: '20px', height: '20px',
            borderRadius: '50%', border: '1px solid var(--border-primary)', background: 'var(--bg-primary)',
            color: 'var(--color-danger)', fontSize: '12px', lineHeight: '18px', textAlign: 'center',
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
          displayStyle={{ flex: 1 }}
          editStyle={{ flex: 1 }}
        />
        {analysis.live && !analysis.chart_current_layer_dsl ? (
          <span style={{ fontSize: 7, padding: '1px 4px', borderRadius: 2, background: 'var(--color-success-bg)', color: 'var(--color-success)', fontWeight: 500, flexShrink: 0 }}>
            LIVE
          </span>
        ) : (
          <span style={{ fontSize: 7, padding: '1px 4px', borderRadius: 2, background: 'var(--color-warning-bg)', color: 'var(--color-warning)', fontWeight: 500, flexShrink: 0 }}>
            CUSTOM
          </span>
        )}
        {hasAnalysisType && (loading || waitingForDeps) && <Loader2 size={12} style={{ animation: 'spin 1s linear infinite', flexShrink: 0 }} />}
      </div>

      {/* Content area */}
      <div style={{ flex: 1, overflow: 'hidden', position: 'relative', minHeight: 0 }}>
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

        {analysis.view_mode === 'chart' && (result || !hasAnalysisType) && (
          <AnalysisChartContainer
            result={result}
            chartKindOverride={analysis.chart_kind}
            visibleScenarioIds={visibleScenarioIds}
            scenarioVisibilityModes={scenarioVisibilityModes}
            scenarioMetaById={scenarioMetaById}
            display={analysis.display}
            onChartKindChange={(kind) => {
              onUpdate(analysis.id, { chart_kind: kind || undefined } as any);
            }}
            onDisplayChange={(key, value) => {
              onUpdate(analysis.id, { display: { ...analysis.display, [key]: value } });
            }}
            source={chartSource}
            fillHeight
            chartContext="canvas"
            canvasZoom={zoom}
            hideScenarioLegend={analysis.live && analysis.display?.show_legend !== true}
            analysisTypeId={analysis.recipe?.analysis?.analysis_type}
            availableAnalyses={availableAnalyses}
            onAnalysisTypeChange={(id) => {
              onUpdate(analysis.id, {
                recipe: { ...analysis.recipe, analysis: { ...analysis.recipe.analysis, analysis_type: id } },
                analysis_type_overridden: true,
              } as any);
            }}
            analysisLive={!!analysis.live}
            onLiveToggle={handleLiveToggle}
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
            analysisId={analysis.id}
            onDelete={() => onDelete(analysis.id)}
          />
        )}

        {result && analysis.view_mode === 'cards' && (
          <div style={{ overflow: 'auto', height: '100%', padding: 8 }}>
            <AnalysisResultCards result={result} />
          </div>
        )}
      </div>
    </div>
  );
}
