import React, { useMemo } from 'react';

import type { AnalysisResult } from '../../lib/graphComputeClient';
import { chartOperationsService } from '../../services/chartOperationsService';
import { analysisResultToCsv } from '../../services/analysisExportService';
import { downloadTextFile } from '../../services/downloadService';
import { Download, ExternalLink } from 'lucide-react';
import { AnalysisBridgeEChart } from './AnalysisBridgeEChart';
import { useElementSize } from '../../hooks/useElementSize';

export function BridgeChartPreview(props: {
  result: AnalysisResult;
  height?: number;
  fillHeight?: boolean;
  compactControls?: boolean;
  showToolbox?: boolean;
  orientation?: 'vertical' | 'horizontal';
  source?: {
    parent_file_id?: string;
    parent_tab_id?: string;
    query_dsl?: string;
    analysis_type?: string;
  };
  hideOpenAsTab?: boolean;
}): JSX.Element | null {
  const { result, height = 360, fillHeight = false, compactControls = false, showToolbox = true, orientation = 'vertical', source, hideOpenAsTab = false } = props;

  const { ref: containerRef, height: containerHeight } = useElementSize<HTMLDivElement>();
  const { ref: controlsRef, height: controlsHeight } = useElementSize<HTMLDivElement>();
  const computedChartHeight = useMemo(() => {
    if (!fillHeight) return height;
    const available = Math.max(0, containerHeight - controlsHeight - 8);
    return Math.max(260, available);
  }, [fillHeight, height, containerHeight, controlsHeight]);

  return (
    <div ref={containerRef} style={{ display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0, height: fillHeight ? '100%' : undefined }}>
      <div ref={controlsRef} style={{ display: 'flex', gap: 8, alignItems: 'center', minWidth: 0, flexWrap: compactControls ? 'nowrap' : 'wrap' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flex: 1, minWidth: 0, overflowX: compactControls ? 'auto' : undefined }}>
          {!compactControls ? <span style={{ fontSize: 11, color: '#6b7280' }}>Chart</span> : null}
          <span style={{ fontSize: 11, color: '#374151', fontWeight: 600, whiteSpace: 'nowrap' }}>Bridge</span>
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
          {!hideOpenAsTab ? (
            <button
              type="button"
              onClick={() => {
                void chartOperationsService.openAnalysisChartTabFromAnalysis({
                  chartKind: 'analysis_bridge',
                  analysisResult: result,
                  scenarioIds: [], // bridge steps already embed scenario context in the result
                  title: result.analysis_name ? `Chart — ${result.analysis_name}` : 'Chart',
                  source,
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
          ) : null}

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

      <AnalysisBridgeEChart
        result={result}
        height={computedChartHeight}
        showToolbox={showToolbox}
        ui={
          compactControls
            ? {
                axisLabelFontSizePx: 9,
                axisLabelMaxLines: 2,
                axisLabelMaxCharsPerLine: 10,
                orientation,
                // Vertical waterfall in a narrow panel needs rotation to remain legible.
                ...(orientation === 'vertical' ? { axisLabelRotateDeg: 60 } : null),
                // Panel: keep bars slimmer (both vertical & horizontal modes).
                  barWidthMinPx: 8,
                  barWidthMaxPx: 18,
                showRunningTotalLine: true,
              }
            : {
                axisLabelFontSizePx: 11,
                axisLabelMaxLines: 2,
                axisLabelMaxCharsPerLine: 16,
                orientation,
                // In tabs we have more width; keep rotation modest if needed.
                ...(orientation === 'vertical' ? { axisLabelRotateDeg: 45 } : null),
                // Tab: allow chunkier bars (previous max=36 was too restrictive for wide layouts).
                barWidthMinPx: 14,
                barWidthMaxPx: 128,
                showRunningTotalLine: true,
              }
        }
      />
    </div>
  );
}


