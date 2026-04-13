import { describe, it, expect } from 'vitest';
import { planChartDisplay } from '../chartDisplayPlanningService';

const RESULT_WITH_FE = {
  analysis_type: 'branch_comparison',
  data: [],
  semantics: {
    dimensions: [],
    metrics: [
      { id: 'edge_probability', name: 'Edge Probability', type: 'probability' },
      { id: 'evidence_mean', name: 'Evidence', type: 'probability' },
      { id: 'forecast_mean', name: 'Forecast', type: 'probability' },
      { id: 'evidence_k', name: 'Observed k', type: 'count' },
      { id: 'forecast_k', name: 'Forecast k', type: 'count' },
    ],
    chart: { recommended: 'bar_grouped', alternatives: ['pie', 'table'] },
  },
} as any;

describe('chartDisplayPlanningService', () => {
  it('should keep all visible scenarios for daily_conversions (multi-scenario overlay)', () => {
    const plan = planChartDisplay({
      result: RESULT_WITH_FE,
      requestedChartKind: 'daily_conversions',
      visibleScenarioIds: ['base', 'current'],
      scenarioVisibilityModes: { base: 'f+e', current: 'f+e' },
    });

    expect(plan.xAxisMode).toBe('time');
    expect(plan.scenarioIdsToRender).toEqual(['base', 'current']);
    expect(plan.scenarioSelectionMode).toBe('all_visible');
    expect(plan.fallbackReasons.length).toBe(0);
  });

  it('should keep all visible scenarios for cohort_maturity (multi-scenario overlay)', () => {
    const plan = planChartDisplay({
      result: RESULT_WITH_FE,
      requestedChartKind: 'cohort_maturity',
      visibleScenarioIds: ['base', 'current'],
      scenarioVisibilityModes: { base: 'f+e', current: 'f+e' },
    });

    expect(plan.xAxisMode).toBe('time');
    expect(plan.scenarioIdsToRender).toEqual(['base', 'current']);
    expect(plan.scenarioSelectionMode).toBe('all_visible');
    expect(plan.fallbackReasons.length).toBe(0);
  });

  it('should keep all visible scenarios for non-time scenario comparison', () => {
    const plan = planChartDisplay({
      result: RESULT_WITH_FE,
      requestedChartKind: 'bar_grouped',
      visibleScenarioIds: ['base', 'current'],
      scenarioVisibilityModes: { base: 'f+e', current: 'f+e' },
    });

    expect(plan.xAxisMode).toBe('scenario');
    expect(plan.scenarioIdsToRender).toEqual(['base', 'current']);
    expect(plan.scenarioSelectionMode).toBe('all_visible');
  });

  it('should split FE rendering when forecast and evidence metrics exist in f+e mode', () => {
    const plan = planChartDisplay({
      result: RESULT_WITH_FE,
      requestedChartKind: 'bar_grouped',
      visibleScenarioIds: ['current'],
      scenarioVisibilityModes: { current: 'f+e' },
    });

    expect(plan.feRenderingMode).toBe('split_fe_stack');
  });

  it('should use absolute_k basis when metric_mode is absolute', () => {
    const plan = planChartDisplay({
      result: RESULT_WITH_FE,
      requestedChartKind: 'bar_grouped',
      visibleScenarioIds: ['current'],
      scenarioVisibilityModes: { current: 'e' },
      display: { metric_mode: 'absolute' },
    });

    expect(plan.metricBasis).toBe('absolute_k');
  });
});
