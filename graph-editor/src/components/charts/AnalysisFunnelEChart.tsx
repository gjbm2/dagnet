import React, { useMemo } from 'react';
import ReactECharts from 'echarts-for-react';

import type { AnalysisResult } from '../../lib/graphComputeClient';
import { buildFunnelEChartsOption } from '../../services/analysisEChartsService';

export function AnalysisFunnelEChart(props: {
  result: AnalysisResult;
  scenarioId: string;
  height?: number;
  showToolbox?: boolean;
}): JSX.Element | null {
  const { result, scenarioId, height = 260, showToolbox = true } = props;

  const option = useMemo(() => {
    return buildFunnelEChartsOption(result, { scenarioId, ui: { showToolbox } });
  }, [result, scenarioId, showToolbox]);

  if (!option) return null;

  return (
    <div style={{ width: '100%', height }}>
      <ReactECharts
        option={option}
        style={{ width: '100%', height: '100%' }}
        notMerge={true}
        lazyUpdate={true}
      />
    </div>
  );
}


