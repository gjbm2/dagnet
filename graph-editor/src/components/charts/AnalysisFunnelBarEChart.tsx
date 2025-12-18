import React, { useMemo } from 'react';
import ReactECharts from 'echarts-for-react';

import type { AnalysisResult } from '../../lib/graphComputeClient';
import { buildFunnelBarEChartsOption, type FunnelBarMetric } from '../../services/analysisEChartsService';

export function AnalysisFunnelBarEChart(props: {
  result: AnalysisResult;
  scenarioIds: string[];
  metric: FunnelBarMetric;
  height?: number;
  widthPx?: number;
  scenarioDslSubtitleById?: Record<string, string>;
}): JSX.Element | null {
  const { result, scenarioIds, metric, height = 260, widthPx, scenarioDslSubtitleById } = props;

  const option = useMemo(() => {
    return buildFunnelBarEChartsOption(result, { scenarioIds, metric, layout: { widthPx }, legend: { scenarioDslSubtitleById } });
  }, [result, scenarioIds, metric, widthPx, scenarioDslSubtitleById]);

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


