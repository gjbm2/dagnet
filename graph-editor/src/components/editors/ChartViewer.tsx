import React, { useState } from 'react';

import type { EditorProps } from '../../types';
import { useFileState } from '../../contexts/TabContext';
import { AnalysisChartContainer } from '../charts/AnalysisChartContainer';
import { AnalysisResultCards } from '../analytics/AnalysisResultCards';
import { useElementSize } from '../../hooks/useElementSize';
import { analysisResultToCsv } from '../../services/analysisExportService';
import { downloadTextFile } from '../../services/downloadService';
import { Download, Eye, EyeOff, Table, RefreshCw, Link2, Pin, Unlink2 } from 'lucide-react';
import { refreshChartByFileId } from '../../services/chartRefreshService';
import { chartOperationsService } from '../../services/chartOperationsService';
import { useAutoUpdateCharts } from '../../hooks/useAutoUpdateCharts';
import { chartDepsSignatureV1 } from '../../lib/chartDeps';
import { dslDependsOnReferenceDay } from '../../lib/dslDynamics';
import { ukReferenceDayService } from '../../services/ukReferenceDayService';

type ChartFileDataV1 = {
  version: '1.0.0';
  chart_kind: 'analysis_funnel' | 'analysis_bridge' | 'analysis_daily_conversions' | 'analysis_cohort_maturity';
  title: string;
  created_at_uk: string;
  created_at_ms: number;
  source?: {
    parent_file_id?: string;
    parent_tab_id?: string;
    query_dsl?: string;
    analysis_type?: string;
  };
  recipe?: {
    parent?: {
      parent_file_id?: string;
      parent_tab_id?: string;
    };
    analysis?: {
      analysis_type?: string | null;
      query_dsl?: string | null;
      what_if_dsl?: string | null;
    };
    scenarios?: Array<{
      scenario_id: string;
      effective_dsl?: string;
      name?: string;
      colour?: string;
      visibility_mode?: 'f+e' | 'f' | 'e';
      is_live?: boolean;
    }>;
    display?: {
      hide_current?: boolean;
    };
    pinned_recompute_eligible?: boolean;
  };
  payload: {
    analysis_result: any;
    scenario_ids: string[];
  };
};

export function ChartViewer({ fileId }: EditorProps): JSX.Element {
  const { data } = useFileState(fileId);
  const { policy: autoUpdatePolicy } = useAutoUpdateCharts();

  const chart = data as ChartFileDataV1 | undefined;
  const analysisResult = chart?.payload?.analysis_result;
  const errorMessage = (chart as any)?.payload?.error_message as string | undefined;
  const scenarioIds =
    (chart?.recipe?.scenarios || []).map(s => s.scenario_id).filter(Boolean).length > 0
      ? (chart?.recipe?.scenarios || []).map(s => s.scenario_id).filter(Boolean)
      : chart?.payload?.scenario_ids || [];
  const scenarioDslSubtitleById = (() => {
    const items = chart?.recipe?.scenarios || [];
    const m: Record<string, string> = {};
    for (const s of items) {
      const dsl = typeof s?.effective_dsl === 'string' ? s.effective_dsl.trim() : '';
      if (dsl) m[s.scenario_id] = dsl;
    }
    return Object.keys(m).length ? m : undefined;
  })();

  const scenarioVisibilityModes = (() => {
    const items = chart?.recipe?.scenarios || [];
    const m: Record<string, 'f+e' | 'f' | 'e'> = {};
    for (const s of items) {
      const id = String(s?.scenario_id || '');
      if (!id) continue;
      const vm = s?.visibility_mode;
      if (vm === 'f' || vm === 'e' || vm === 'f+e') m[id] = vm;
    }
    return Object.keys(m).length ? m : undefined;
  })();

  const [showChart, setShowChart] = useState(true);
  const [showResults, setShowResults] = useState(false);
  const isLinked = Boolean(chart?.recipe?.parent?.parent_tab_id || chart?.source?.parent_tab_id);
  const isStale = (() => {
    if (!chart) return false;
    const stored = (chart as any)?.deps_signature as string | undefined;
    const deps = (chart as any)?.deps as any;
    if (!deps || typeof stored !== 'string' || !stored.trim()) return false;
    const recipeScenarios: any[] = Array.isArray(chart?.recipe?.scenarios) ? chart.recipe.scenarios : [];
    const hasDynamic = recipeScenarios.some(s => dslDependsOnReferenceDay(s?.effective_dsl));
    const currentStamp = { ...deps, reference_day_uk: hasDynamic ? ukReferenceDayService.getReferenceDayUK() : undefined };
    const currentSig = chartDepsSignatureV1(currentStamp);
    return currentSig !== stored;
  })();

  // IMPORTANT: measure a container whose height is driven by the tab viewport (fixed),
  // not by the content we render inside it. Measuring a content-sized element can create
  // a ResizeObserver feedback loop (infinite growth / rerender).
  const { ref: viewportRef } = useElementSize<HTMLDivElement>();

  if (!chart || !analysisResult) {
    return (
      <div style={{ padding: 12, color: '#6b7280' }}>
        {typeof errorMessage === 'string' && errorMessage.trim() ? (
          <>
            <div style={{ fontWeight: 700, color: '#111827', marginBottom: 6 }}>Chart failed to load</div>
            <div style={{ whiteSpace: 'pre-wrap' }}>{errorMessage}</div>
          </>
        ) : (
          'No chart data.'
        )}
      </div>
    );
  }

  return (
    <div
      ref={viewportRef}
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        background: '#f8f9fa',
      }}
    >
      <div style={{ padding: 12, paddingBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#111827' }}>{chart.title}</div>
          <div style={{ fontSize: 12, color: '#6b7280' }}>{chart.created_at_uk}</div>
          <div style={{ fontSize: 11, padding: '2px 6px', borderRadius: 999, border: '1px solid #e5e7eb', background: '#fff', color: '#374151', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {isLinked ? <><Link2 size={12} /> Linked</> : <><Pin size={12} /> Pinned</>}
          </div>
          {!autoUpdatePolicy.enabled && isStale ? (
            <div style={{ fontSize: 11, padding: '2px 6px', borderRadius: 999, border: '1px solid #fbbf24', background: '#fffbeb', color: '#92400e' }}>
              Stale
            </div>
          ) : null}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            {chart.source?.query_dsl ? (
              <div style={{ fontSize: 12, color: '#6b7280', maxWidth: 520, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 120, flex: '1 1 320px' }} title={chart.source.query_dsl}>
                {chart.source.query_dsl}
              </div>
            ) : null}
            <button
              type="button"
              onClick={() => {
                void refreshChartByFileId({ chartFileId: fileId });
              }}
              style={{ border: '1px solid #e5e7eb', background: '#fff', borderRadius: 6, padding: '4px 8px', fontSize: 11, cursor: 'pointer' }}
              title="Refresh chart"
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <RefreshCw size={14} />
                Refresh
              </span>
            </button>
            <button
              type="button"
              onClick={() => {
                void chartOperationsService.disconnectChart({ chartFileId: fileId });
              }}
              disabled={!isLinked}
              style={{ border: '1px solid #e5e7eb', background: isLinked ? '#fff' : '#f3f4f6', borderRadius: 6, padding: '4px 8px', fontSize: 11, cursor: isLinked ? 'pointer' : 'not-allowed' }}
              title={isLinked ? 'Disconnect (pin) this chart' : 'Already pinned'}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <Unlink2 size={14} />
                Disconnect
              </span>
            </button>
            <button
              type="button"
              onClick={() => setShowChart(v => !v)}
              style={{ border: '1px solid #e5e7eb', background: showChart ? '#f3f4f6' : '#fff', borderRadius: 6, padding: '4px 8px', fontSize: 11, cursor: 'pointer' }}
              title={showChart ? 'Hide chart' : 'Show chart'}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {showChart ? <EyeOff size={14} /> : <Eye size={14} />}
                {showChart ? 'Hide chart' : 'Show chart'}
              </span>
            </button>
            <button
              type="button"
              onClick={() => setShowResults(v => !v)}
              style={{ border: '1px solid #e5e7eb', background: showResults ? '#f3f4f6' : '#fff', borderRadius: 6, padding: '4px 8px', fontSize: 11, cursor: 'pointer' }}
              title={showResults ? 'Hide results' : 'Show results'}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <Table size={14} />
                {showResults ? 'Hide results' : 'Show results'}
              </span>
            </button>
            <button
              type="button"
              onClick={() => {
                const { filename, csv } = analysisResultToCsv(analysisResult);
                downloadTextFile({ filename, content: csv, mimeType: 'text/csv' });
              }}
              style={{ border: '1px solid #e5e7eb', background: '#fff', borderRadius: 6, padding: '4px 8px', fontSize: 11, cursor: 'pointer' }}
              title="Download CSV"
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <Download size={14} />
                Download CSV
              </span>
            </button>
          </div>
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, padding: '0 12px 12px 12px', position: 'relative' }}>
        <div
          style={{
            background: '#fff',
            border: '1px solid #e5e7eb',
            borderRadius: 10,
            position: 'absolute',
            inset: '0 12px 12px 12px',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}
        >
          {showChart && (
            <div style={{ flex: showResults ? 3 : 1, minHeight: 0, position: 'relative' }}>
              <div style={{ position: 'absolute', inset: 0, padding: 10 }}>
                <AnalysisChartContainer
                  result={analysisResult}
                  visibleScenarioIds={scenarioIds}
                  scenarioVisibilityModes={scenarioVisibilityModes}
                  height={420}
                  fillHeight={true}
                  compactControls={false}
                  source={chart.source}
                  scenarioDslSubtitleById={scenarioDslSubtitleById}
                />
              </div>
            </div>
          )}

          {showResults && (
            <div style={{ flex: 2, minHeight: 0, overflow: 'auto', padding: 10, borderTop: '1px solid #e5e7eb' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#111827' }}>Results</div>
                <div style={{ fontSize: 12, color: '#6b7280' }}>({analysisResult.analysis_name || 'Analysis'})</div>
              </div>
              <AnalysisResultCards result={analysisResult} scenarioDslSubtitleById={scenarioDslSubtitleById} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}


