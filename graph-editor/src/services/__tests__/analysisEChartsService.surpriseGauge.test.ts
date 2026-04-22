import { describe, it, expect } from 'vitest';
import { buildChartOption } from '../analysisEChartsService';

function makeVariable(overrides: Record<string, any>) {
  return {
    available: true,
    posterior_sd: 0.05,
    zone: 'expected',
    evidence_n: 100,
    evidence_k: 20,
    ...overrides,
  };
}

function makeResult() {
  return {
    analysis_type: 'surprise_gauge',
    dimension_values: {
      scenario_id: {
        'scenario-1': { name: 'Scenario 1', colour: '#ec4899' },
        current: { name: 'Current', colour: '#3b82f6' },
      },
    },
    scenario_results: [
      {
        scenario_id: 'scenario-1',
        hint: 'Run Bayes model for better forecasts',
        variables: [
          makeVariable({
            name: 'p',
            label: 'Conversion rate',
            observed: 0.2,
            expected: 0.25,
            sigma: -0.8,
            quantile: 0.21,
          }),
          makeVariable({
            name: 'completeness',
            label: 'Completeness',
            observed: 0.58,
            expected: 0.62,
            sigma: -0.4,
            quantile: 0.34,
          }),
        ],
      },
      {
        scenario_id: 'current',
        variables: [
          makeVariable({
            name: 'p',
            label: 'Conversion rate',
            observed: 0.4,
            expected: 0.3,
            sigma: 1.5,
            quantile: 0.93,
          }),
          makeVariable({
            name: 'completeness',
            label: 'Completeness',
            observed: 0.72,
            expected: 0.61,
            sigma: 1.2,
            quantile: 0.88,
          }),
        ],
      },
    ],
  };
}

describe('analysisEChartsService surprise gauge projection', () => {
  it('defaults to the last visible scenario for single-metric gauge view', () => {
    const result = makeResult();

    const opt = buildChartOption(
      'surprise_gauge',
      result,
      { surprise_scenario_scope: 'focused', surprise_var: 'p' },
      { visibleScenarioIds: ['scenario-1', 'current'] },
    );

    expect(opt).not.toBeNull();
    expect(opt.series[0].type).toBe('gauge');
    expect(opt.series[0].data[0].value).toBe(1.5);
  });

  it('renders one metric across all visible scenarios', () => {
    const result = makeResult();

    const opt = buildChartOption(
      'surprise_gauge',
      result,
      { surprise_scenario_scope: 'all_visible', surprise_var: 'p' },
      { visibleScenarioIds: ['scenario-1', 'current'] },
    );

    expect(opt).not.toBeNull();
    expect(opt.yAxis.data).toEqual(['Scenario 1', 'Current']);
    expect(opt.series[0].type).toBe('scatter');
  });

  it('renders both metrics for the focused scenario', () => {
    const result = makeResult();

    const opt = buildChartOption(
      'surprise_gauge',
      result,
      { surprise_scenario_scope: 'focused', surprise_var: 'all' },
      { visibleScenarioIds: ['scenario-1', 'current'] },
    );

    expect(opt).not.toBeNull();
    expect(opt.yAxis.data).toEqual(['Conversion rate', 'Completeness']);
  });
});
