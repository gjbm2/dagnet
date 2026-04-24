import { describe, it, expect } from 'vitest';
import { buildChartOption } from '../analysisEChartsService';

// Exact shape of what the BE normaliser produces now for a no-evidence request
// (values from server_after.log ts_ms=1776963447621)
describe('gauge no-evidence repro', () => {
  it('renders with obs=0, exp=0.0008, sd=0.0038, available=true', () => {
    const result: any = {
      analysis_type: 'surprise_gauge',
      dimension_values: {
        scenario_id: {
          current: { name: 'Current', colour: '#3b82f6' },
          'scenario-1776475304227-k1y6285': { name: 'Scenario 1', colour: '#ec4899' },
        },
      },
      focused_scenario_id: 'current',
      variables: [
        { name: 'p', label: 'Conversion rate', available: true, observed: 0.0, expected: 0.0008, sigma: -0.211, quantile: 0.417, posterior_sd: 0.0038, combined_sd: 0.0038, zone: 'expected', evidence_n: 4, evidence_k: 0, completeness: 0.0009 },
        { name: 'completeness', label: 'Completeness', available: true, observed: 0.0009, expected: 0.0009, sigma: 0, quantile: 0.5, posterior_sd: 0.0044, combined_sd: 0.0044, zone: 'expected' },
      ],
      scenario_results: [
        { scenario_id: 'scenario-1776475304227-k1y6285', variables: [
          { name: 'p', label: 'Conversion rate', available: true, observed: 0.0, expected: 0.0008, sigma: -0.211, quantile: 0.417, posterior_sd: 0.0038, combined_sd: 0.0038, zone: 'expected', evidence_n: 4, evidence_k: 0, completeness: 0.0009 },
          { name: 'completeness', label: 'Completeness', available: true, observed: 0.0009, expected: 0.0009, sigma: 0, quantile: 0.5, posterior_sd: 0.0044, combined_sd: 0.0044, zone: 'expected' },
        ]},
        { scenario_id: 'current', variables: [
          { name: 'p', label: 'Conversion rate', available: true, observed: 0.0, expected: 0.0005, sigma: -0.192, quantile: 0.424, posterior_sd: 0.0026, combined_sd: 0.0026, zone: 'expected', evidence_n: 4, evidence_k: 0, completeness: 0.0006 },
          { name: 'completeness', label: 'Completeness', available: true, observed: 0.0006, expected: 0.0006, sigma: 0, quantile: 0.5, posterior_sd: 0.0029, combined_sd: 0.0029, zone: 'expected' },
        ]},
      ],
    };

    const opt = buildChartOption(
      'surprise_gauge',
      result,
      { surprise_scenario_scope: 'focused', surprise_var: 'p' },
      { visibleScenarioIds: ['scenario-1776475304227-k1y6285', 'current'] },
    );

    console.log('opt is null?', opt === null);
    if (opt) {
      console.log('opt.series[0].type', opt.series?.[0]?.type);
      console.log('opt.series[0].data[0]', opt.series?.[0]?.data?.[0]);
    }
    expect(opt).not.toBeNull();
  });

  it('returns null when all variables are unavailable', () => {
    const result: any = {
      analysis_type: 'surprise_gauge',
      focused_scenario_id: 'current',
      variables: [
        { name: 'p', label: 'Conversion rate', available: false, reason: 'Forecast engine failed' },
        { name: 'completeness', label: 'Completeness', available: false, reason: 'Forecast engine failed' },
      ],
      scenario_results: [
        { scenario_id: 'current', variables: [
          { name: 'p', label: 'Conversion rate', available: false, reason: 'Forecast engine failed' },
          { name: 'completeness', label: 'Completeness', available: false, reason: 'Forecast engine failed' },
        ]},
      ],
    };

    const opt = buildChartOption(
      'surprise_gauge',
      result,
      { surprise_scenario_scope: 'focused', surprise_var: 'p' },
      { visibleScenarioIds: ['current'] },
    );

    expect(opt).toBeNull();
  });
});
