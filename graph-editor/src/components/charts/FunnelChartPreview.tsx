import React, { useMemo, useState } from 'react';

import type { AnalysisResult } from '../../lib/graphComputeClient';
import { AnalysisFunnelBarEChart } from './AnalysisFunnelBarEChart';
import type { FunnelBarMetric } from '../../services/analysisEChartsService';
import { useElementSize } from '../../hooks/useElementSize';
import { chartOperationsService } from '../../services/chartOperationsService';
import { analysisResultToCsv } from '../../services/analysisExportService';
import { downloadTextFile } from '../../services/downloadService';
import { Columns2, Download, ExternalLink, LayoutGrid } from 'lucide-react';

type LayoutMode = 'combined' | 'separate';

function ToggleButton(props: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={props.onClick}
      style={{
        border: '1px solid #e5e7eb',
        background: props.active ? '#f3f4f6' : '#ffffff',
        color: '#374151',
        borderRadius: 6,
        padding: '4px 8px',
        fontSize: 11,
        cursor: 'pointer',
      }}
    >
      {props.children}
    </button>
  );
}

export function FunnelChartPreview(props: {
  result: AnalysisResult;
  visibleScenarioIds: string[];
  height?: number;
  fillHeight?: boolean;
  source?: {
    parent_file_id?: string;
    parent_tab_id?: string;
    query_dsl?: string;
    analysis_type?: string;
  };
  scenarioDslSubtitleById?: Record<string, string>;
}): JSX.Element | null {
  const { result, visibleScenarioIds, height = 420, fillHeight = false, source, scenarioDslSubtitleById } = props;

  const { ref: containerRef, width: containerWidth, height: containerHeight } = useElementSize<HTMLDivElement>();
  const { ref: controlsRef, height: controlsHeight } = useElementSize<HTMLDivElement>();

  const [layoutMode, setLayoutMode] = useState<LayoutMode>('combined');
  const [metric, setMetric] = useState<FunnelBarMetric>('cumulative_probability');

  const scenarioIds = useMemo(() => {
    // Only scenarios that exist in the result's dimension_values (defensive).
    const known = new Set(Object.keys(result.dimension_values?.scenario_id || {}));
    return visibleScenarioIds.filter(id => known.has(id));
  }, [result.dimension_values, visibleScenarioIds]);

  if (scenarioIds.length === 0) return null;

  const computedChartHeight = useMemo(() => {
    if (!fillHeight) return height;
    // Fill mode: chart height adapts to container size minus controls row.
    // Keep a sensible minimum so small tiles still show a usable chart.
    const available = Math.max(0, containerHeight - controlsHeight - 8);
    return Math.max(360, available);
  }, [fillHeight, height, containerHeight, controlsHeight]);

  const separateChartHeight = useMemo(() => {
    if (!fillHeight || layoutMode !== 'separate') return computedChartHeight;
    // Try to fit all scenario cards into the available height, else fall back to scroll.
    const available = Math.max(0, containerHeight - controlsHeight - 8);
    const n = Math.max(1, scenarioIds.length);
    const approxHeaderAndPadding = 64; // header + inner padding per card
    const gaps = (n - 1) * 10;
    const per = Math.floor((available - gaps - n * approxHeaderAndPadding) / n);
    return Math.max(180, Math.min(360, per || 240));
  }, [fillHeight, layoutMode, computedChartHeight, containerHeight, controlsHeight, scenarioIds.length]);

  return (
    <div
      ref={containerRef}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        height: fillHeight ? '100%' : undefined,
        minHeight: 0,
      }}
    >
      <div ref={controlsRef} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontSize: 11, color: '#6b7280' }}>Chart</span>
        <ToggleButton active={metric === 'cumulative_probability'} onClick={() => setMetric('cumulative_probability')}>
          Cum. probability
        </ToggleButton>
        <ToggleButton active={metric === 'step_probability'} onClick={() => setMetric('step_probability')}>
          Step probability
        </ToggleButton>

        <span style={{ fontSize: 11, color: '#6b7280', marginLeft: 6 }}>Layout</span>
        <ToggleButton active={layoutMode === 'combined'} onClick={() => setLayoutMode('combined')}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Columns2 size={14} />
            Combined
          </span>
        </ToggleButton>
        <ToggleButton active={layoutMode === 'separate'} onClick={() => setLayoutMode('separate')}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <LayoutGrid size={14} />
            Separate
          </span>
        </ToggleButton>

        <button
          type="button"
          onClick={() => {
            void chartOperationsService.openFunnelChartTabFromAnalysis({
              analysisResult: result,
              scenarioIds,
              title: result.analysis_name ? `Chart — ${result.analysis_name}` : 'Chart',
              source,
              scenarioDslSubtitleById,
            });
          }}
          style={{
            marginLeft: 'auto',
            border: '1px solid #e5e7eb',
            background: '#ffffff',
            color: '#374151',
            borderRadius: 6,
            padding: '4px 8px',
            fontSize: 11,
            cursor: 'pointer',
          }}
          title="Open as tab"
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <ExternalLink size={14} />
            Open as tab
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
          }}
          title="Download CSV"
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Download size={14} />
            Download CSV
          </span>
        </button>
      </div>

      {layoutMode === 'combined' ? (
        <AnalysisFunnelBarEChart
          result={result}
          scenarioIds={scenarioIds}
          metric={metric}
          height={computedChartHeight}
          widthPx={containerWidth}
          scenarioDslSubtitleById={scenarioDslSubtitleById}
        />
      ) : (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            overflowY: fillHeight ? 'auto' : undefined,
            minHeight: 0,
          }}
        >
          {scenarioIds.map(id => {
            const name = result.dimension_values?.scenario_id?.[id]?.name ?? id;
            const colour = result.dimension_values?.scenario_id?.[id]?.colour;
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
                  <AnalysisFunnelBarEChart
                    result={result}
                    scenarioIds={[id]}
                    metric={metric}
                    height={separateChartHeight}
                    widthPx={containerWidth}
                    scenarioDslSubtitleById={scenarioDslSubtitleById}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}


