import React, { useMemo, useState } from 'react';

import type { AnalysisResult } from '../../lib/graphComputeClient';
import { chartOperationsService } from '../../services/chartOperationsService';
import { analysisResultToCsv } from '../../services/analysisExportService';
import { downloadTextFile } from '../../services/downloadService';
import { Download, ExternalLink, LayoutGrid } from 'lucide-react';
import { AnalysisFunnelBridgeEChart } from './AnalysisFunnelBridgeEChart';

type LayoutMode = 'separate';

export function FunnelBridgeChartPreview(props: {
  result: AnalysisResult;
  visibleScenarioIds: string[];
  height?: number;
  compactControls?: boolean;
  source?: {
    parent_file_id?: string;
    parent_tab_id?: string;
    query_dsl?: string;
    analysis_type?: string;
  };
  scenarioDslSubtitleById?: Record<string, string>;
}): JSX.Element | null {
  const { result, visibleScenarioIds, height = 360, compactControls = false, source, scenarioDslSubtitleById } = props;

  const [layoutMode] = useState<LayoutMode>('separate');

  const scenarioIds = useMemo(() => {
    const known = new Set(Object.keys(result.dimension_values?.scenario_id || {}));
    return visibleScenarioIds.filter(id => known.has(id));
  }, [result.dimension_values, visibleScenarioIds]);

  if (scenarioIds.length === 0) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', minWidth: 0, flexWrap: compactControls ? 'nowrap' : 'wrap' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flex: 1, minWidth: 0, overflowX: compactControls ? 'auto' : undefined }}>
          {!compactControls ? <span style={{ fontSize: 11, color: '#6b7280' }}>Chart</span> : null}
          <span style={{ fontSize: 11, color: '#374151', fontWeight: 600, whiteSpace: 'nowrap' }}>Bridge</span>
          {!compactControls ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#6b7280', marginLeft: 6 }}>
              <LayoutGrid size={14} />
              {layoutMode === 'separate' ? 'Separate' : 'Separate'}
            </span>
          ) : null}
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
          <button
            type="button"
            onClick={() => {
              void chartOperationsService.openAnalysisChartTabFromAnalysis({
                chartKind: 'analysis_funnel',
                analysisResult: result,
                scenarioIds,
                title: result.analysis_name ? `Chart — ${result.analysis_name}` : 'Chart',
                source,
                scenarioDslSubtitleById,
              });
            }}
            style={{
              border: '1px solid #e5e7eb',
              background: '#ffffff',
              color: '#374151',
              borderRadius: 6,
              padding: '4px 8px',
              fontSize: 11,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
            title="Open as tab"
            aria-label="Open as tab"
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <ExternalLink size={14} />
              {compactControls ? null : 'Open as tab'}
            </span>
          </button>

          <button
            type="button"
            onClick={() => {
              const { filename, csv } = analysisResultToCsv(result);
              downloadTextFile({ filename, content: csv, mimeType: 'text/csv' });
            }}
            style={{
              border: '1px solid #e5e7eb',
              background: '#ffffff',
              color: '#374151',
              borderRadius: 6,
              padding: '4px 8px',
              fontSize: 11,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
            title="Download CSV"
            aria-label="Download CSV"
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Download size={14} />
              {compactControls ? null : 'Download CSV'}
            </span>
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0 }}>
        {scenarioIds.map(id => {
          const name = result.dimension_values?.scenario_id?.[id]?.name ?? id;
          const colour = (result.dimension_values?.scenario_id?.[id] as any)?.colour;
          const dsl = scenarioDslSubtitleById?.[id];
          return (
            <div key={id} style={{ border: '1px solid #e5e7eb', borderRadius: 8, background: '#ffffff' }}>
              <div style={{ padding: '8px 10px', borderBottom: '1px solid #f3f4f6', display: 'flex', gap: 8, alignItems: 'baseline', minWidth: 0 }}>
                {colour ? <span style={{ width: 10, height: 10, borderRadius: 999, background: colour }} /> : null}
                <span style={{ fontSize: 12, fontWeight: 600, color: '#374151', flexShrink: 0 }}>{name}</span>
                {typeof dsl === 'string' && dsl.trim() ? (
                  <span
                    style={{
                      fontSize: 11,
                      fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
                      color: '#6b7280',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      minWidth: 0,
                    }}
                    title={dsl}
                  >
                    {dsl}
                  </span>
                ) : null}
              </div>
              <div style={{ padding: 8 }}>
                <AnalysisFunnelBridgeEChart result={result} scenarioId={id} height={height} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}


