import React, { useMemo } from 'react';
import ReactECharts from 'echarts-for-react';

import type { AnalysisResult } from '../../lib/graphComputeClient';
import { buildFunnelEChartsOption } from '../../services/analysisEChartsService';

export function AnalysisFunnelEChart(props: {
  result: AnalysisResult;
  scenarioId: string;
  height?: number;
}): JSX.Element | null {
  const { result, scenarioId, height = 260 } = props;

  const option = useMemo(() => {
    return buildFunnelEChartsOption(result, { scenarioId });
  }, [result, scenarioId]);

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


