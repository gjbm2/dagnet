import React, { useMemo } from 'react';
import ReactECharts from 'echarts-for-react';

import type { AnalysisResult } from '../../lib/graphComputeClient';
import { useElementSize } from '../../hooks/useElementSize';
import { buildFunnelBridgeEChartsOption } from '../../services/analysisEChartsService';

export function AnalysisFunnelBridgeEChart(props: {
  result: AnalysisResult;
  scenarioId: string;
  height?: number;
  showToolbox?: boolean;
}): JSX.Element | null {
  const { result, scenarioId, height = 260, showToolbox = false } = props;
  const { ref: containerRef, width: widthPx } = useElementSize<HTMLDivElement>();

  const option = useMemo(() => {
    return buildFunnelBridgeEChartsOption(result, { scenarioId, layout: { widthPx }, ui: { showToolbox } });
  }, [result, scenarioId, widthPx, showToolbox]);

  if (!option) return null;

  return (
    <div ref={containerRef} style={{ width: '100%', height }}>
      <ReactECharts option={option} style={{ width: '100%', height: '100%' }} notMerge={true} lazyUpdate={true} />
    </div>
  );
}


