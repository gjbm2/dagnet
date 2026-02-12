import { describe, it, expect } from 'vitest';

import { buildFunnelBarEChartsOption } from '../analysisEChartsService';
import type { AnalysisResult } from '../../lib/graphComputeClient';

describe('analysisEChartsService (funnel bar)', () => {
  it('builds a vertical multi-scenario grouped bar option from a stage×scenario Conversion Funnel-like result', () => {
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
          base: { name: 'Base', colour: '#10b981', visibility_mode: 'f+e', probability_label: 'Probability' },
        },
      },
      data: [
        { stage: 'start', scenario_id: 'current', probability: 1.0, step_probability: 1.0, evidence_mean: 1.0, p_mean: 1.0 },
        { stage: 'mid', scenario_id: 'current', probability: 0.5, step_probability: 0.5, evidence_mean: 0.3, p_mean: 0.5 },
        { stage: 'end', scenario_id: 'current', probability: 0.2, step_probability: 0.4, evidence_mean: 0.1, p_mean: 0.2 },

        { stage: 'start', scenario_id: 'base', probability: 1.0, step_probability: 1.0, evidence_mean: 1.0, p_mean: 1.0 },
        { stage: 'mid', scenario_id: 'base', probability: 0.6, step_probability: 0.6, evidence_mean: 0.25, p_mean: 0.6 },
        { stage: 'end', scenario_id: 'base', probability: 0.3, step_probability: 0.5, evidence_mean: 0.15, p_mean: 0.3 },
      ],
    };

    const option = buildFunnelBarEChartsOption(result, { scenarioIds: ['base', 'current'], metric: 'cumulative_probability' });
    expect(option).toBeTruthy();
    // In f+e visibility mode we show a stacked bar per scenario: e and (f−e).
    expect(option.series).toHaveLength(4);
    expect(option.series[0].type).toBe('bar');
    expect(option.xAxis.data).toEqual(['Start', 'Mid', 'End']);
    expect(option.series[0].data).toHaveLength(3); // stages
    expect(option.series[1].data).toHaveLength(3);
    // First scenario series is "Base — e"
    expect(option.series[0].name).toContain('Base');
    expect(option.series[0].name).toContain('— e');
    expect(option.series[0].data[0].value).toBe(1.0);
    // Second series is "Base — f−e": mid residual = 0.6 - 0.25 = 0.35
    expect(option.series[1].name).toContain('Base');
    expect(option.series[1].name).toContain('f−e');
    expect(option.series[1].data[1].value).toBeCloseTo(0.35);
  });
});


