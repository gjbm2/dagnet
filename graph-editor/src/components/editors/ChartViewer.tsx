import React, { useState } from 'react';

import type { EditorProps } from '../../types';
import { useFileState } from '../../contexts/TabContext';
import { FunnelChartPreview } from '../charts/FunnelChartPreview';
import { AnalysisResultCards } from '../analytics/AnalysisResultCards';
import { useElementSize } from '../../hooks/useElementSize';
import { analysisResultToCsv } from '../../services/analysisExportService';
import { downloadTextFile } from '../../services/downloadService';
import { Download, Eye, EyeOff, Table } from 'lucide-react';

type ChartFileDataV1 = {
  version: '1.0.0';
  chart_kind: 'analysis_funnel';
  title: string;
  created_at_uk: string;
  created_at_ms: number;
  source?: {
    parent_file_id?: string;
    parent_tab_id?: string;
    query_dsl?: string;
    analysis_type?: string;
  };
  payload: {
    analysis_result: any;
    scenario_ids: string[];
    scenario_dsl_subtitle_by_id?: Record<string, string>;
  };
};

export function ChartViewer({ fileId }: EditorProps): JSX.Element {
  const { data } = useFileState(fileId);

  const chart = data as ChartFileDataV1 | undefined;
  const analysisResult = chart?.payload?.analysis_result;
  const scenarioIds = chart?.payload?.scenario_ids || [];
  const scenarioDslSubtitleById = chart?.payload?.scenario_dsl_subtitle_by_id || undefined;

  const [showChart, setShowChart] = useState(true);
  const [showResults, setShowResults] = useState(false);

  // IMPORTANT: measure a container whose height is driven by the tab viewport (fixed),
  // not by the content we render inside it. Measuring a content-sized element can create
  // a ResizeObserver feedback loop (infinite growth / rerender).
  const { ref: viewportRef } = useElementSize<HTMLDivElement>();

  if (!chart || !analysisResult) {
    return (
      <div style={{ padding: 12, color: '#6b7280' }}>
        No chart data.
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
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#111827' }}>{chart.title}</div>
          <div style={{ fontSize: 12, color: '#6b7280' }}>{chart.created_at_uk}</div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
            {chart.source?.query_dsl ? (
              <div style={{ fontSize: 12, color: '#6b7280', maxWidth: 520, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={chart.source.query_dsl}>
                {chart.source.query_dsl}
              </div>
            ) : null}
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

      <div style={{ flex: 1, minHeight: 0, padding: 12, paddingTop: 0 }}>
        <div
          style={{
            background: '#fff',
            border: '1px solid #e5e7eb',
            borderRadius: 10,
            padding: 10,
            height: '100%',
            display: 'grid',
            gridTemplateRows:
              showChart && showResults ? '3fr 2fr'
              : showChart ? '1fr'
              : showResults ? '1fr'
              : '1fr',
            gap: 12,
            overflow: 'hidden',
          }}
        >
          {showChart && (
            <div style={{ minHeight: 0 }}>
              <FunnelChartPreview
                result={analysisResult}
                visibleScenarioIds={scenarioIds}
                fillHeight={true}
                source={chart.source}
                scenarioDslSubtitleById={scenarioDslSubtitleById}
              />
            </div>
          )}

          {showResults && (
            <div style={{ minHeight: 0, overflow: 'auto' }}>
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


