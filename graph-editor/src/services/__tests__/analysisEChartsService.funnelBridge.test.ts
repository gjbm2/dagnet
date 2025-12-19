import { describe, it, expect } from 'vitest';

import { buildFunnelBridgeEChartsOption } from '../analysisEChartsService';
import type { AnalysisResult } from '../../lib/graphComputeClient';

describe('analysisEChartsService (funnel bridge)', () => {
  it('builds a waterfall option from a stage×scenario Conversion Funnel-like result (single scenario)', () => {
    const result: AnalysisResult = {
      analysis_type: 'conversion_funnel',
      analysis_name: 'Conversion Funnel',
      analysis_description: 'Probability at each stage',
      semantics: {
        dimensions: [
          { id: 'stage', name: 'Stage', type: 'stage', role: 'primary' },
          { id: 'scenario_id', name: 'Scenario', type: 'scenario', role: 'secondary' },
        ],
        metrics: [{ id: 'probability', name: 'Cum. probability', type: 'probability', format: 'percent', role: 'primary' }],
        chart: { recommended: 'funnel' },
      },
      dimension_values: {
        stage: {
          start: { name: 'Start', order: 0 },
          mid: { name: 'Mid', order: 1 },
          end: { name: 'End', order: 2 },
        },
        scenario_id: {
          current: { name: 'Current', colour: '#3b82f6', visibility_mode: 'f+e', probability_label: 'Probability' },
        },
      },
      data: [
        { stage: 'start', scenario_id: 'current', probability: 1.0 },
        { stage: 'mid', scenario_id: 'current', probability: 0.5 },
        { stage: 'end', scenario_id: 'current', probability: 0.2 },
      ],
    };

    const option = buildFunnelBridgeEChartsOption(result, { scenarioId: 'current' });
    expect(option).toBeTruthy();
    expect(option.series).toHaveLength(4);
    expect(option.xAxis.data).toEqual(['Start', 'Mid', 'End']);
  });
});


