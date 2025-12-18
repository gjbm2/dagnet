import { describe, it, expect } from 'vitest';

import { buildFunnelEChartsOption } from '../analysisEChartsService';
import type { AnalysisResult } from '../../lib/graphComputeClient';

describe('analysisEChartsService (funnel)', () => {
  it('builds a funnel option from a stage×scenario Conversion Funnel-like result', () => {
    const result: AnalysisResult = {
      analysis_type: 'conversion_funnel',
      analysis_name: 'Conversion Funnel',
      analysis_description: 'Probability at each stage',
      semantics: {
        dimensions: [
          { id: 'stage', name: 'Stage', type: 'stage', role: 'primary' },
          { id: 'scenario_id', name: 'Scenario', type: 'scenario', role: 'secondary' },
        ],
        metrics: [
          { id: 'probability', name: 'Cum. probability', type: 'probability', format: 'percent', role: 'primary' },
          { id: 'n', name: 'n', type: 'count', format: 'number' },
          { id: 'dropoff', name: 'Dropoff', type: 'probability', format: 'percent' },
        ],
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
        { stage: 'start', scenario_id: 'current', probability: 1.0, n: 1000 },
        { stage: 'mid', scenario_id: 'current', probability: 0.5, n: 500, dropoff: 0.5 },
        { stage: 'end', scenario_id: 'current', probability: 0.2, n: 200, dropoff: 0.3 },
      ],
    };

    const option = buildFunnelEChartsOption(result, { scenarioId: 'current' });
    expect(option).toBeTruthy();
    expect(option.series).toHaveLength(1);
    expect(option.series[0].type).toBe('funnel');
    expect(option.series[0].data).toHaveLength(3);
    expect(option.series[0].data[0].name).toBe('Start');
    expect(option.series[0].data[0].value).toBe(1.0);
  });
});


