import { describe, it, expect } from 'vitest';

import { buildFunnelBarEChartsOption } from '../analysisEChartsService';
import type { AnalysisResult } from '../../lib/graphComputeClient';

describe('analysisEChartsService (funnel bar step change)', () => {
  it('for conversion_funnel, uses change since last step when metric is step_probability', () => {
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
          { id: 'step_probability', name: 'Step probability', type: 'probability', format: 'percent' },
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
        { stage: 'start', scenario_id: 'current', probability: 1.0, step_probability: 1.0 },
        { stage: 'mid', scenario_id: 'current', probability: 0.5, step_probability: 0.5 },
        { stage: 'end', scenario_id: 'current', probability: 0.2, step_probability: 0.4 },
      ],
    };

    const option = buildFunnelBarEChartsOption(result, {
      scenarioIds: ['current'],
      metric: 'step_probability',
    });

    expect(option).toBeTruthy();
    expect(option.series).toHaveLength(1);
    // First bar is "no previous step" so its value is 0 (and label suppressed by formatter).
    expect(option.series[0].data[0].value).toBe(0);
    // Mid: dropoff = 1.0 - 0.5 = 0.5
    expect(option.series[0].data[1].value).toBeCloseTo(0.5);
    // End: dropoff = 0.5 - 0.2 = 0.3
    expect(option.series[0].data[2].value).toBeCloseTo(0.3);
    // Axis remains in percent space (0–100%)
    expect(option.yAxis.min).toBe(0);
    expect(option.yAxis.max).toBe(1);
  });
});


