import React, { useEffect, useRef, useMemo } from 'react';
import { NodeProps, NodeResizer } from 'reactflow';
import type { CanvasAnalysis } from '@/types';
import { useCanvasAnalysisCompute } from '@/hooks/useCanvasAnalysisCompute';
import { useGraphStore } from '@/contexts/GraphStoreContext';
import { useScenariosContextOptional } from '@/contexts/ScenariosContext';
import { useTabContext } from '@/contexts/TabContext';
import { AnalysisChartContainer } from '../charts/AnalysisChartContainer';
import { AnalysisResultCards } from '../analytics/AnalysisResultCards';
import { Loader2, AlertCircle, ServerOff, BarChart3 } from 'lucide-react';
import { InlineEditableLabel } from '../InlineEditableLabel';

interface CanvasAnalysisNodeData {
  analysis: CanvasAnalysis;
  tabId?: string;
  onUpdate: (id: string, updates: Partial<CanvasAnalysis>) => void;
  onDelete: (id: string) => void;
}

export default function CanvasAnalysisNode({ data, selected }: NodeProps<CanvasAnalysisNodeData>) {
  const { analysis: analysisProp, tabId, onUpdate, onDelete } = data;
  const { graph } = useGraphStore();
  const analysis = useMemo(() => {
    const fromStore = (graph as any)?.canvasAnalyses?.find((a: any) => a.id === analysisProp.id);
    return (fromStore || analysisProp) as CanvasAnalysis;
  }, [graph, analysisProp]);
  const resizeTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const scenariosContext = useScenariosContextOptional();
  const { tabs, operations } = useTabContext();

  useEffect(() => {
    return () => { if (resizeTimeoutRef.current) clearTimeout(resizeTimeoutRef.current); };
  }, []);

  const { result, loading, waitingForDeps, error, backendUnavailable } = useCanvasAnalysisCompute({
    analysis,
    tabId,
  });

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

  const handleResize = (_event: any, params: { width: number; height: number }) => {
    if (resizeTimeoutRef.current) clearTimeout(resizeTimeoutRef.current);
    resizeTimeoutRef.current = setTimeout(() => {
      onUpdate(analysis.id, { width: Math.round(params.width), height: Math.round(params.height) });
    }, 200);
  };

  const KNOWN_CHART_KINDS = new Set(['funnel', 'bridge', 'bridge_horizontal', 'histogram', 'lag_histogram', 'daily_conversions', 'cohort_maturity']);
  const hasRealChart = !!(result?.semantics?.chart?.recommended && KNOWN_CHART_KINDS.has(result.semantics.chart.recommended));

  const displayTitle = analysis.title || result?.analysis_name || analysis.recipe.analysis.analysis_type;

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
        handleStyle={{ width: 8, height: 8, borderRadius: 2, backgroundColor: '#3b82f6', border: '1px solid #fff' }}
      />

      {selected && (
        <button
          className="nodrag"
          onClick={(e) => { e.stopPropagation(); onDelete(analysis.id); }}
          title="Delete canvas analysis"
          style={{
            position: 'absolute', top: -10, right: -10, width: '20px', height: '20px',
            borderRadius: '50%', border: '1px solid rgba(0,0,0,0.15)', background: '#fff',
            color: '#dc3545', fontSize: '12px', lineHeight: '18px', textAlign: 'center',
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
          placeholder={result?.analysis_name || analysis.recipe.analysis.analysis_type || 'Untitled'}
          selected={!!selected}
          onCommit={(v) => onUpdate(analysis.id, { title: v })}
          displayStyle={{ flex: 1 }}
          editStyle={{ flex: 1 }}
        />
        {analysis.live && !analysis.chart_current_layer_dsl ? (
          <span style={{ fontSize: 7, padding: '1px 4px', borderRadius: 2, background: '#dcfce7', color: '#166534', fontWeight: 500, flexShrink: 0 }}>
            LIVE
          </span>
        ) : (
          <span style={{ fontSize: 7, padding: '1px 4px', borderRadius: 2, background: '#fef3c7', color: '#92400e', fontWeight: 500, flexShrink: 0 }}>
            CUSTOM
          </span>
        )}
        {(loading || waitingForDeps) && <Loader2 size={12} style={{ animation: 'spin 1s linear infinite', flexShrink: 0 }} />}
      </div>

      {/* Content area */}
      <div style={{ flex: 1, overflow: 'hidden', position: 'relative', minHeight: 0 }}>
        {!analysis.recipe?.analysis?.analytics_dsl && !result && !loading && !error && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 8, color: '#9ca3af', padding: 16 }}>
            <BarChart3 size={28} />
            <span style={{ fontSize: 12, textAlign: 'center' }}>Select this analysis and set the Analytics DSL in the properties panel</span>
          </div>
        )}

        {backendUnavailable && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 8, color: '#9ca3af', padding: 16 }}>
            <ServerOff size={28} />
            <span style={{ fontSize: 12, textAlign: 'center' }}>Analysis backend unavailable</span>
          </div>
        )}

        {!backendUnavailable && error && !result && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 8, color: '#ef4444', padding: 16 }}>
            <AlertCircle size={24} />
            <span style={{ fontSize: 11, textAlign: 'center', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', WebkitLineClamp: 3, display: '-webkit-box', WebkitBoxOrient: 'vertical' }}>{error}</span>
          </div>
        )}

        {!backendUnavailable && !result && !error && (loading || waitingForDeps) && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 8, color: '#9ca3af' }}>
            <Loader2 size={28} style={{ animation: 'spin 1s linear infinite' }} />
            <span style={{ fontSize: 12 }}>{waitingForDeps ? 'Loading chart dependencies...' : 'Computing...'}</span>
          </div>
        )}

        {result && analysis.view_mode === 'chart' && hasRealChart && (
          <AnalysisChartContainer
            result={result}
            chartKindOverride={analysis.chart_kind}
            visibleScenarioIds={visibleScenarioIds}
            scenarioVisibilityModes={scenarioVisibilityModes}
            scenarioMetaById={scenarioMetaById}
            display={analysis.display}
            onDisplayChange={(key, value) => {
              onUpdate(analysis.id, { display: { ...analysis.display, [key]: value } });
            }}
            fillHeight
            compactControls
            hideScenarioLegend={analysis.live}
          />
        )}

        {result && (analysis.view_mode === 'cards' || !hasRealChart) && (
          <div style={{ overflow: 'auto', height: '100%', padding: 8 }}>
            <AnalysisResultCards result={result} />
          </div>
        )}
      </div>
    </div>
  );
}
