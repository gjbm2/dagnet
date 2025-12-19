import React, { useMemo, useState } from 'react';

import type { AnalysisResult } from '../../lib/graphComputeClient';
import { FunnelChartPreview } from './FunnelChartPreview';
import { BridgeChartPreview } from './BridgeChartPreview';
import { FunnelBridgeChartPreview } from './FunnelBridgeChartPreview';

type ChartKind = 'funnel' | 'bridge' | 'bridge_horizontal';

function normaliseChartKind(kind: string | undefined | null): ChartKind | null {
  if (!kind) return null;
  if (kind === 'funnel') return 'funnel';
  if (kind === 'bridge') return 'bridge';
  if (kind === 'bridge_horizontal') return 'bridge_horizontal';
  return null;
}

function labelForChartKind(kind: ChartKind): string {
  if (kind === 'funnel') return 'Funnel';
  if (kind === 'bridge') return 'Bridge';
  return 'Bridge (Horizontal)';
}

export function AnalysisChartContainer(props: {
  result: AnalysisResult;
  visibleScenarioIds: string[];
  scenarioDslSubtitleById?: Record<string, string>;
  height?: number;
  fillHeight?: boolean;
  compactControls?: boolean;
  source?: {
    parent_file_id?: string;
    parent_tab_id?: string;
    query_dsl?: string;
    analysis_type?: string;
  };
}): JSX.Element | null {
  const { result, visibleScenarioIds, scenarioDslSubtitleById, height = 420, fillHeight = false, compactControls = false, source } = props;

  const availableChartKinds = useMemo((): ChartKind[] => {
    const spec: any = result?.semantics?.chart;
    const rec = normaliseChartKind(spec?.recommended);
    const alts = Array.isArray(spec?.alternatives) ? spec.alternatives : [];
    const altKinds = alts.map(normaliseChartKind).filter(Boolean) as ChartKind[];
    const all = [rec, ...altKinds].filter(Boolean) as ChartKind[];
    // Unique, preserve order
    return Array.from(new Set(all));
  }, [result]);

  const [selectedKind, setSelectedKind] = useState<ChartKind | null>(null);

  const kind = selectedKind ?? availableChartKinds[0] ?? null;
  if (!kind) return null;

  const showChooser = availableChartKinds.length > 1;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        minHeight: 0,
        height: fillHeight ? '100%' : undefined,
      }}
    >
      {showChooser ? (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: compactControls ? 'nowrap' : 'wrap' }}>
          {!compactControls ? <span style={{ fontSize: 11, color: '#6b7280' }}>Chart</span> : null}
          {availableChartKinds.length <= 2 ? (
            availableChartKinds.map(k => (
              <button
                key={k}
                type="button"
                onClick={() => setSelectedKind(k)}
                style={{
                  border: '1px solid #e5e7eb',
                  background: k === kind ? '#f3f4f6' : '#ffffff',
                  color: '#374151',
                  borderRadius: 6,
                  padding: '4px 8px',
                  fontSize: 11,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}
                title={labelForChartKind(k)}
              >
                {labelForChartKind(k)}
              </button>
            ))
          ) : (
            <select
              value={kind}
              onChange={e => setSelectedKind(e.target.value as ChartKind)}
              style={{
                border: '1px solid #e5e7eb',
                background: '#ffffff',
                color: '#374151',
                borderRadius: 6,
                padding: '4px 8px',
                fontSize: 11,
                cursor: 'pointer',
              }}
              aria-label="Chart type"
            >
              {availableChartKinds.map(k => (
                <option key={k} value={k}>
                  {labelForChartKind(k)}
                </option>
              ))}
            </select>
          )}
        </div>
      ) : null}

      {kind === 'funnel' ? (
        <FunnelChartPreview
          result={result}
          visibleScenarioIds={visibleScenarioIds}
          height={height}
          fillHeight={fillHeight}
          showToolbox={false}
          compactControls={compactControls}
          source={source}
          scenarioDslSubtitleById={scenarioDslSubtitleById}
        />
      ) : result.analysis_type === 'conversion_funnel' ? (
        <FunnelBridgeChartPreview
          result={result}
          visibleScenarioIds={visibleScenarioIds}
          height={height}
          compactControls={compactControls}
          source={source}
          scenarioDslSubtitleById={scenarioDslSubtitleById}
        />
      ) : (
        <BridgeChartPreview
          result={result}
          height={height}
          fillHeight={fillHeight}
          showToolbox={false}
          compactControls={compactControls}
          source={source}
          orientation={kind === 'bridge_horizontal' ? 'horizontal' : 'vertical'}
        />
      )}
    </div>
  );
}


