import React, { useEffect, useRef, useMemo } from 'react';
import { NodeProps, NodeResizer } from 'reactflow';
import type { CanvasAnalysis } from '@/types';
import { useCanvasAnalysisCompute } from '@/hooks/useCanvasAnalysisCompute';
import { useScenariosContextOptional } from '@/contexts/ScenariosContext';
import { useTabContext } from '@/contexts/TabContext';
import { AnalysisChartContainer } from '../charts/AnalysisChartContainer';
import { AnalysisResultCards } from '../analytics/AnalysisResultCards';
import { Loader2, AlertCircle, ServerOff, BarChart3 } from 'lucide-react';

interface CanvasAnalysisNodeData {
  analysis: CanvasAnalysis;
  tabId?: string;
  onUpdate: (id: string, updates: Partial<CanvasAnalysis>) => void;
  onDelete: (id: string) => void;
}

export default function CanvasAnalysisNode({ data, selected }: NodeProps<CanvasAnalysisNodeData>) {
  const { analysis, tabId, onUpdate, onDelete } = data;
  const resizeTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const scenariosContext = useScenariosContextOptional();
  const { tabs, operations } = useTabContext();

  useEffect(() => {
    return () => { if (resizeTimeoutRef.current) clearTimeout(resizeTimeoutRef.current); };
  }, []);

  const { result, loading, error, backendUnavailable } = useCanvasAnalysisCompute({
    analysis,
    tabId,
  });

  const visibleScenarioIds = useMemo(() => {
    if (!analysis.live && analysis.recipe.scenarios) {
      return analysis.recipe.scenarios.map(s => s.scenario_id);
    }
    if (tabId) {
      const state = operations.getScenarioState(tabId);
      return state?.visibleScenarioIds || ['current'];
    }
    return ['current'];
  }, [analysis.live, analysis.recipe.scenarios, tabId, operations, tabs]);

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

  const handleResize = (_event: any, params: { width: number; height: number }) => {
    if (resizeTimeoutRef.current) clearTimeout(resizeTimeoutRef.current);
    resizeTimeoutRef.current = setTimeout(() => {
      onUpdate(analysis.id, { width: Math.round(params.width), height: Math.round(params.height) });
    }, 200);
  };

  const displayTitle = analysis.title || result?.analysis_name || analysis.recipe.analysis.analysis_type;

  console.log('[CanvasAnalysisNode] render:', {
    id: analysis.id,
    visibleScenarioIds,
    hasResult: !!result,
    resultDimensions: result?.dimension_values ? Object.keys(result.dimension_values) : 'none',
    loading,
    error,
  });

  return (
    <div
      className="canvas-analysis-node"
      style={{
        width: '100%',
        height: '100%',
        background: 'var(--canvas-analysis-bg, #ffffff)',
        border: selected ? '2px solid var(--accent-colour, #3b82f6)' : '1px solid var(--canvas-analysis-border, #d1d5db)',
        borderRadius: 8,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        boxShadow: selected ? '0 0 0 2px rgba(59,130,246,0.3)' : '0 1px 3px rgba(0,0,0,0.1)',
      }}
    >
      <NodeResizer
        isVisible={selected}
        minWidth={300}
        minHeight={200}
        onResize={handleResize}
        lineStyle={{ borderColor: 'var(--accent-colour, #3b82f6)' }}
        handleStyle={{ width: 8, height: 8, borderRadius: 2 }}
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
          padding: '6px 10px',
          fontSize: 12,
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
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
          {displayTitle}
        </span>
        {analysis.live && (
          <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 3, background: '#dcfce7', color: '#166534', fontWeight: 500, flexShrink: 0 }}>
            LIVE
          </span>
        )}
        {!analysis.live && (
          <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 3, background: '#f3f4f6', color: '#6b7280', fontWeight: 500, flexShrink: 0 }}>
            FROZEN
          </span>
        )}
        {loading && <Loader2 size={12} style={{ animation: 'spin 1s linear infinite', flexShrink: 0 }} />}
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

        {!backendUnavailable && !result && !error && loading && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 8, color: '#9ca3af' }}>
            <Loader2 size={28} style={{ animation: 'spin 1s linear infinite' }} />
            <span style={{ fontSize: 12 }}>Computing...</span>
          </div>
        )}

        {result && analysis.view_mode === 'chart' && (
          <AnalysisChartContainer
            result={result}
            visibleScenarioIds={visibleScenarioIds}
            scenarioVisibilityModes={scenarioVisibilityModes}
            fillHeight
            compactControls
          />
        )}

        {result && analysis.view_mode === 'cards' && (
          <AnalysisResultCards result={result} />
        )}
      </div>
    </div>
  );
}
