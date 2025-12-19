import React, { useMemo } from 'react';
import ReactECharts from 'echarts-for-react';

import type { AnalysisResult } from '../../lib/graphComputeClient';
import { buildBridgeEChartsOption, type BridgeChartOptionArgs } from '../../services/analysisEChartsService';
import { useElementSize } from '../../hooks/useElementSize';

export function AnalysisBridgeEChart(props: {
  result: AnalysisResult;
  height?: number;
  showToolbox?: boolean;
  ui?: BridgeChartOptionArgs['ui'];
}): JSX.Element | null {
  const { result, height = 320, showToolbox = false, ui } = props;

  const { ref: containerRef, width: widthPx } = useElementSize<HTMLDivElement>();

  const option = useMemo(() => {
    return buildBridgeEChartsOption(result, { layout: { widthPx, heightPx: height }, ui: { showToolbox, ...(ui || {}) } });
  }, [result, showToolbox, widthPx, height, ui]);

  if (!option) return null;

  return (
    <div ref={containerRef} style={{ width: '100%', height }}>
      <ReactECharts
        option={option}
        style={{ width: '100%', height: '100%' }}
        notMerge={true}
        lazyUpdate={true}
      />
    </div>
  );
}


