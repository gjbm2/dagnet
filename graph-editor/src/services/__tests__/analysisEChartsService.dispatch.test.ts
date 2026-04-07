/**
 * Tests for the unified buildChartOption dispatch function.
 */

import { describe, it, expect } from 'vitest';
import { buildChartOption, buildHistogramEChartsOption, buildDailyConversionsEChartsOption, buildCohortMaturityEChartsOption } from '../analysisEChartsService';

const HISTOGRAM_DATA = {
  data: [
    { lag_days: 0, conversions: 100, pct: 0.4 },
    { lag_days: 1, conversions: 80, pct: 0.32 },
    { lag_days: 2, conversions: 50, pct: 0.2 },
    { lag_days: 3, conversions: 20, pct: 0.08 },
  ],
  total_conversions: 250,
  cohorts_analysed: 10,
};

const BRIDGE_RESULT = {
  analysis_type: 'bridge_view',
  data: [
    { bridge_step: 'start', total: 0.8, delta: 0 },
    { bridge_step: 'step_a', total: 0, delta: -0.1 },
    { bridge_step: 'step_b', total: 0, delta: 0.05 },
    { bridge_step: 'end', total: 0.75, delta: 0 },
  ],
  semantics: {
    dimensions: [{ id: 'bridge_step', role: 'primary', type: 'bridge_step' }],
    metrics: [
      { id: 'total', role: 'primary', name: 'Total' },
      { id: 'delta', role: 'secondary', name: 'Delta' },
    ],
  },
  dimension_values: {
    bridge_step: {
      start: { name: 'Start', order: 0 },
      step_a: { name: 'Step A', order: 1 },
      step_b: { name: 'Step B', order: 2 },
      end: { name: 'End', order: 3 },
    },
  },
};

const DENSE_BRIDGE_RESULT = {
  analysis_type: 'bridge_view',
  data: [
    { bridge_step: 'start', total: 0.8, delta: 0 },
    { bridge_step: 'step_a', total: 0, delta: -0.1 },
    { bridge_step: 'step_b', total: 0, delta: 0.05 },
    { bridge_step: 'step_c', total: 0, delta: -0.04 },
    { bridge_step: 'step_d', total: 0, delta: 0.24 },
    { bridge_step: 'end', total: 0.95, delta: 0 },
  ],
  semantics: {
    dimensions: [{ id: 'bridge_step', role: 'primary', type: 'bridge_step' }],
    metrics: [
      { id: 'total', role: 'primary', name: 'Total' },
      { id: 'delta', role: 'secondary', name: 'Delta' },
    ],
  },
  dimension_values: {
    bridge_step: {
      start: { name: 'Start', order: 0 },
      step_a: { name: 'Landing page', order: 1 },
      step_b: { name: 'phase one', order: 2 },
      step_c: { name: 'household created', order: 3 },
      step_d: { name: 'household delegated', order: 4 },
      end: { name: 'End', order: 5 },
    },
  },
};

const BRANCH_COMPARISON_RESULT = {
  analysis_type: 'branch_comparison',
  data: [
    {
      branch: 'child_a',
      scenario_id: 'base',
      visibility_mode: 'f+e',
      edge_probability: 0.7,
      evidence_mean: 0.6,
      forecast_mean: 0.7,
      evidence_k: 60,
      forecast_k: 70,
    },
    {
      branch: 'child_b',
      scenario_id: 'base',
      visibility_mode: 'f+e',
      edge_probability: 0.3,
      evidence_mean: 0.2,
      forecast_mean: 0.3,
      evidence_k: 20,
      forecast_k: 30,
    },
    {
      branch: 'child_a',
      scenario_id: 'current',
      visibility_mode: 'f+e',
      edge_probability: 0.8,
      evidence_mean: 0.7,
      forecast_mean: 0.8,
      evidence_k: 140,
      forecast_k: 160,
    },
    {
      branch: 'child_b',
      scenario_id: 'current',
      visibility_mode: 'f+e',
      edge_probability: 0.2,
      evidence_mean: 0.1,
      forecast_mean: 0.2,
      evidence_k: 20,
      forecast_k: 40,
    },
  ],
  semantics: {
    dimensions: [
      { id: 'branch', role: 'primary', type: 'node', name: 'Branch' },
      { id: 'scenario_id', role: 'secondary', type: 'scenario', name: 'Scenario' },
    ],
    metrics: [
      { id: 'edge_probability', role: 'primary', type: 'probability', name: 'Edge Probability' },
      { id: 'evidence_mean', type: 'probability', name: 'Evidence' },
      { id: 'forecast_mean', type: 'probability', name: 'Forecast' },
      { id: 'evidence_k', type: 'count', name: 'Observed k' },
      { id: 'forecast_k', type: 'count', name: 'Forecast k' },
    ],
    chart: {
      recommended: 'bar_grouped',
      alternatives: ['pie', 'table'],
    },
  },
  dimension_values: {
    branch: {
      child_a: { name: 'Child A', order: 0, colour: '#3b82f6' },
      child_b: { name: 'Child B', order: 1, colour: '#10b981' },
    },
    scenario_id: {
      base: { name: 'Base', colour: '#6b7280', visibility_mode: 'f+e', probability_label: 'Probability' },
      current: { name: 'Current', colour: '#3b82f6', visibility_mode: 'f+e', probability_label: 'Probability' },
    },
  },
};

const BRANCH_COMPARISON_TIME_SERIES_RESULT = {
  analysis_type: 'branch_comparison',
  data: [
    { date: '2025-10-01', scenario_id: 'current', branch: 'child_a', x: 100, y: 70, rate: 0.7, evidence_y: 60, forecast_y: 10, projected_y: 70, completeness: 0.9 },
    { date: '2025-10-01', scenario_id: 'current', branch: 'child_b', x: 100, y: 30, rate: 0.3, evidence_y: 20, forecast_y: 10, projected_y: 30, completeness: 0.9 },
    { date: '2025-10-02', scenario_id: 'current', branch: 'child_a', x: 120, y: 84, rate: 0.7, evidence_y: 70, forecast_y: 14, projected_y: 84, completeness: 0.9 },
    { date: '2025-10-02', scenario_id: 'current', branch: 'child_b', x: 120, y: 36, rate: 0.3, evidence_y: 24, forecast_y: 12, projected_y: 36, completeness: 0.9 },
  ],
  semantics: {
    dimensions: [
      { id: 'date', role: 'primary', type: 'time', name: 'Cohort date' },
      { id: 'scenario_id', role: 'secondary', type: 'scenario', name: 'Scenario' },
      { id: 'branch', role: 'filter', type: 'node', name: 'Branch' },
    ],
    metrics: [
      { id: 'rate', role: 'primary', type: 'ratio', name: 'Conversion rate' },
      { id: 'x', type: 'count', name: 'Cohort size' },
      { id: 'y', type: 'count', name: 'Conversions' },
      { id: 'evidence_y', type: 'count', name: 'Evidence conversions' },
      { id: 'forecast_y', type: 'count', name: 'Forecast conversions' },
      { id: 'projected_y', type: 'count', name: 'Projected conversions' },
      { id: 'completeness', type: 'ratio', name: 'Completeness' },
    ],
    chart: {
      recommended: 'time_series',
      alternatives: ['bar_grouped', 'pie', 'table'],
    },
  },
  dimension_values: {
    branch: {
      child_a: { name: 'Child A', order: 0, colour: '#3b82f6' },
      child_b: { name: 'Child B', order: 1, colour: '#10b981' },
    },
    scenario_id: {
      current: { name: 'Current', colour: '#3b82f6', visibility_mode: 'f+e', probability_label: 'Probability' },
    },
  },
};

const BRANCH_COMPARISON_TIME_SERIES_SINGLE_CHILD_RESULT = {
  analysis_type: 'branch_comparison',
  data: [
    { date: '2025-10-01', scenario_id: 'current', branch: 'child_b', x: 100, y: 30, rate: 0.3, evidence_y: 20, forecast_y: 10, projected_y: 30, completeness: 0.9 },
    { date: '2025-10-02', scenario_id: 'current', branch: 'child_b', x: 120, y: 36, rate: 0.3, evidence_y: 24, forecast_y: 12, projected_y: 36, completeness: 0.9 },
  ],
  semantics: BRANCH_COMPARISON_TIME_SERIES_RESULT.semantics,
  dimension_values: BRANCH_COMPARISON_TIME_SERIES_RESULT.dimension_values,
};

describe('buildChartOption dispatch', () => {
  it('should return null for unknown chart kind', () => {
    expect(buildChartOption('unknown', {})).toBeNull();
  });

  it('should dispatch histogram correctly', () => {
    const option = buildChartOption('histogram', HISTOGRAM_DATA);
    expect(option).not.toBeNull();
    expect(option.series[0].type).toBe('bar');
    expect(option.series[0].data).toHaveLength(4);
    expect(option.xAxis.data).toEqual([0, 1, 2, 3]);
  });

  it('should dispatch bridge correctly', () => {
    const option = buildChartOption('bridge', BRIDGE_RESULT);
    expect(option).not.toBeNull();
  });

  it('should pass orientation from resolvedSettings to bridge', () => {
    const option = buildChartOption('bridge', BRIDGE_RESULT, { orientation: 'horizontal' });
    expect(option).not.toBeNull();
  });

  it('should dispatch bar_grouped comparison correctly', () => {
    const option = buildChartOption('bar_grouped', BRANCH_COMPARISON_RESULT, {}, { visibleScenarioIds: ['base', 'current'] });
    expect(option).not.toBeNull();
    expect(option.xAxis.data).toEqual(['Base', 'Current']);
    expect(option.series.length).toBeGreaterThan(0);
    expect(option.series.every((s: any) => s.stack === 'comparison')).toBe(true);
  });

  it('should respect grouped stack_mode override for multi-scenario comparison bars', () => {
    const option = buildChartOption('bar_grouped', BRANCH_COMPARISON_RESULT, { stack_mode: 'grouped' }, { visibleScenarioIds: ['base', 'current'] });
    expect(option).not.toBeNull();
    expect(option.series.some((s: any) => s.stack === 'child_a' || s.stack === 'child_b')).toBe(true);
  });

  it('should dispatch pie comparison correctly for a single scenario', () => {
    const option = buildChartOption('pie', BRANCH_COMPARISON_RESULT, {}, { visibleScenarioIds: ['current'] });
    expect(option).not.toBeNull();
    expect(option.series[0].type).toBe('pie');
    expect(option.series[0].data).toHaveLength(2);
  });

  it('should dispatch time_series comparison correctly', () => {
    const option = buildChartOption('time_series', BRANCH_COMPARISON_TIME_SERIES_RESULT, {}, { visibleScenarioIds: ['current'] });
    expect(option).not.toBeNull();
    expect(option.xAxis.type).toBe('time');
    expect(option.series.length).toBeGreaterThan(0);
    expect(option.series.every((s: any) => s.stack === 'comparison')).toBe(true);
  });

  it('should split f+e time_series into evidence and forecast crown series', () => {
    const option = buildChartOption('time_series', BRANCH_COMPARISON_TIME_SERIES_RESULT, {}, { visibleScenarioIds: ['current'] });
    expect(option).not.toBeNull();
    const names = option.series.map((s: any) => s.name);
    expect(names).toContain('Child A — e');
    expect(names).toContain('Child A — f−e');
    expect(names).toContain('Child B — e');
    expect(names).toContain('Child B — f−e');
  });
});

// ── Common settings (applyCommonSettings) ────────────────────

describe('applyCommonSettings via buildChartOption', () => {
  it('should hide legend when show_legend is false', () => {
    const option = buildChartOption('histogram', HISTOGRAM_DATA, { show_legend: false });
    expect(option.legend.show).toBe(false);
  });

  it('should position legend at bottom', () => {
    const option = buildChartOption('daily_conversions', DAILY_CONVERSIONS_RESULT, { legend_position: 'bottom' }, { visibleScenarioIds: ['current'] });
    expect(option.legend.bottom).toBe(0);
    expect(option.legend.top).toBeUndefined();
  });

  it('should hide gridlines when show_grid_lines is none', () => {
    const option = buildChartOption('histogram', HISTOGRAM_DATA, { show_grid_lines: 'none' });
    const yAxes = Array.isArray(option.yAxis) ? option.yAxis : [option.yAxis];
    expect(yAxes[0].splitLine.show).toBe(false);
  });

  it('should apply axis_label_rotation to xAxis', () => {
    const option = buildChartOption('histogram', HISTOGRAM_DATA, { axis_label_rotation: '45' });
    expect(option.xAxis.axisLabel.rotate).toBe(45);
  });

  it('should apply axis_label_format to yAxis', () => {
    const option = buildChartOption('histogram', HISTOGRAM_DATA, { axis_label_format: 'compact' });
    const yAxes = Array.isArray(option.yAxis) ? option.yAxis : [option.yAxis];
    const fn = yAxes[0].axisLabel.formatter;
    expect(fn(1500)).toBe('1.5K');
  });

  it('should hide tooltip when show_tooltip is false', () => {
    const option = buildChartOption('histogram', HISTOGRAM_DATA, { show_tooltip: false });
    expect(option.tooltip.show).toBe(false);
  });

  it('should disable animation when animate is false', () => {
    const option = buildChartOption('histogram', HISTOGRAM_DATA, { animate: false });
    expect(option.animation).toBe(false);
  });

  it('should apply show_labels to series', () => {
    const option = buildChartOption('histogram', HISTOGRAM_DATA, { show_labels: true });
    expect(option.series[0].label.show).toBe(true);
  });

  it('should apply label_position to series', () => {
    const option = buildChartOption('histogram', HISTOGRAM_DATA, { label_position: 'inside' });
    expect(option.series[0].label.position).toBe('inside');
  });
});

// ── Bridge-specific post-processing ──────────────────────────

describe('bridge-specific settings via buildChartOption', () => {
  it('should remove connectors when show_connectors is false', () => {
    const option = buildChartOption('bridge', BRIDGE_RESULT, { show_connectors: false });
    const hasMarkLine = option.series.some((s: any) => s.markLine);
    expect(hasMarkLine).toBe(false);
  });

  it('should apply bar_gap to bar series', () => {
    const option = buildChartOption('bridge', BRIDGE_RESULT, { bar_gap: 'large' });
    const barSeries = option.series.filter((s: any) => s.type === 'bar');
    expect(barSeries.every((s: any) => s.barCategoryGap === '50%')).toBe(true);
  });

  it('should suppress bridge value labels in dense small layouts when layout is provided', () => {
    const option = buildChartOption(
      'bridge',
      DENSE_BRIDGE_RESULT,
      {},
      { layout: { widthPx: 260, heightPx: 180 } },
    );
    const valueSeries = option.series.filter((s: any) => s.type === 'bar' && s.name !== 'Assist');
    expect(valueSeries.length).toBeGreaterThan(0);
    expect(valueSeries.every((s: any) => s.label?.show === false)).toBe(true);
  });
});

describe('buildHistogramEChartsOption', () => {
  it('should build histogram option with correct data', () => {
    const option = buildHistogramEChartsOption(HISTOGRAM_DATA);
    expect(option).not.toBeNull();
    expect(option.series[0].data).toEqual([100, 80, 50, 20]);
    expect(option.xAxis.data).toEqual([0, 1, 2, 3]);
  });

  it('should show labels when data has ≤20 points', () => {
    const option = buildHistogramEChartsOption(HISTOGRAM_DATA);
    expect(option.series[0].label.show).toBe(true);
  });

  it('should respect show_labels override', () => {
    const option = buildHistogramEChartsOption(HISTOGRAM_DATA, { show_labels: false });
    expect(option.series[0].label.show).toBe(false);
  });

  it('should respect y_axis_scale setting', () => {
    const logOption = buildHistogramEChartsOption(HISTOGRAM_DATA, { y_axis_scale: 'log' });
    expect(logOption.yAxis[0].type).toBe('log');

    const linearOption = buildHistogramEChartsOption(HISTOGRAM_DATA, { y_axis_scale: 'linear' });
    expect(linearOption.yAxis[0].type).toBe('value');
  });

  it('should respect axis extent overrides', () => {
    const option = buildHistogramEChartsOption(HISTOGRAM_DATA, { y_axis_min: 0, y_axis_max: 200 });
    expect(option.yAxis[0].min).toBe(0);
    expect(option.yAxis[0].max).toBe(200);
  });

  it('should return null for empty data', () => {
    expect(buildHistogramEChartsOption({ data: [] })).toBeNull();
    expect(buildHistogramEChartsOption(null)).toBeNull();
  });
});

// ── Daily conversions ────────────────────────────────────────

const DAILY_CONVERSIONS_RESULT = {
  data: [
    { scenario_id: 'current', subject_id: 'edge1', date: '2025-10-01', rate: 0.42, x: 1000, y: 420 },
    { scenario_id: 'current', subject_id: 'edge1', date: '2025-10-02', rate: 0.45, x: 1100, y: 495 },
    { scenario_id: 'current', subject_id: 'edge1', date: '2025-10-03', rate: 0.40, x: 950, y: 380 },
  ],
  dimension_values: {
    scenario_id: { current: { name: 'Base', colour: '#3b82f6' } },
    subject_id: { edge1: { name: 'Edge 1' } },
  },
};

describe('buildDailyConversionsEChartsOption', () => {
  it('should produce dual-axis series (bar N + line rate)', () => {
    const option = buildDailyConversionsEChartsOption(DAILY_CONVERSIONS_RESULT, {}, { visibleScenarioIds: ['current'] });
    expect(option).not.toBeNull();
    expect(option.series).toHaveLength(2);
    expect(option.series[0].type).toBe('bar');
    expect(option.series[0].data).toHaveLength(3);
    expect(option.series[1].type).toBe('line');
    expect(option.series[1].data).toHaveLength(3);
  });

  it('should assign bar to yAxisIndex 0 and line to yAxisIndex 1', () => {
    const option = buildDailyConversionsEChartsOption(DAILY_CONVERSIONS_RESULT, {}, { visibleScenarioIds: ['current'] });
    expect(option.series[0].yAxisIndex).toBe(0);
    expect(option.series[1].yAxisIndex).toBe(1);
  });

  it('should filter by visibleScenarioIds', () => {
    const option = buildDailyConversionsEChartsOption(DAILY_CONVERSIONS_RESULT, {}, { visibleScenarioIds: ['nonexistent'] });
    expect(option).toBeNull();
  });

  it('should return null for empty data', () => {
    expect(buildDailyConversionsEChartsOption({ data: [] })).toBeNull();
  });

  it('should compute rateMax from data with headroom capped at 1.0', () => {
    const option = buildDailyConversionsEChartsOption(DAILY_CONVERSIONS_RESULT, {}, { visibleScenarioIds: ['current'] });
    expect(option.yAxis[1].max).toBeGreaterThan(0.45);
    expect(option.yAxis[1].max).toBeLessThanOrEqual(1.0);
  });

  it('should respect show_legend setting', () => {
    const off = buildDailyConversionsEChartsOption(DAILY_CONVERSIONS_RESULT, { show_legend: false }, { visibleScenarioIds: ['current'] });
    expect(off.legend.show).toBe(false);
  });

  it('should dispatch via buildChartOption', () => {
    const option = buildChartOption('daily_conversions', DAILY_CONVERSIONS_RESULT, {}, { visibleScenarioIds: ['current'] });
    expect(option).not.toBeNull();
    expect(option.series).toHaveLength(2);
  });
});

// ── Cohort maturity ──────────────────────────────────────────

const COHORT_MATURITY_RESULT = {
  data: [
    { scenario_id: 'current', subject_id: 'edge1', tau_days: 0, rate: 0.10, projected_rate: 0.10, tau_solid_max: 10, tau_future_max: 20, boundary_date: '2025-10-01' },
    { scenario_id: 'current', subject_id: 'edge1', tau_days: 5, rate: 0.25, projected_rate: 0.28, tau_solid_max: 10, tau_future_max: 20, boundary_date: '2025-10-01' },
    { scenario_id: 'current', subject_id: 'edge1', tau_days: 10, rate: 0.35, projected_rate: 0.40, tau_solid_max: 10, tau_future_max: 20, boundary_date: '2025-10-01' },
    { scenario_id: 'current', subject_id: 'edge1', tau_days: 15, rate: 0.38, projected_rate: 0.50, tau_solid_max: 10, tau_future_max: 20, boundary_date: '2025-10-01' },
    { scenario_id: 'current', subject_id: 'edge1', tau_days: 20, rate: null, projected_rate: 0.55, tau_solid_max: 10, tau_future_max: 20, boundary_date: '2025-10-01' },
    { scenario_id: 'current', subject_id: 'edge1', tau_days: 25, rate: null, projected_rate: 0.60, tau_solid_max: 10, tau_future_max: 20, boundary_date: '2025-10-01' },
  ],
  dimension_values: {
    scenario_id: { current: { name: 'Base', colour: '#3b82f6' } },
    subject_id: { edge1: { name: 'Edge 1' } },
  },
  metadata: { anchor_from: '2025-09-01', anchor_to: '2025-10-01', sweep_from: '2025-09-15', sweep_to: '2025-10-15' },
};

describe('buildCohortMaturityEChartsOption', () => {
  it('should produce solid + dashed evidence series (midpoint requires model data)', () => {
    const option = buildCohortMaturityEChartsOption(COHORT_MATURITY_RESULT, {}, { visibleScenarioIds: ['current'] });
    expect(option).not.toBeNull();

    const ids = option.series.map((s: any) => s.id);
    expect(ids).toContain('current::solid');
    expect(ids).toContain('current::dashedEvidence');
    // midpoint series only present when model curve data provides it
  });

  it('should render forecast-only in f mode (shading only when no model data)', () => {
    const option = buildCohortMaturityEChartsOption(COHORT_MATURITY_RESULT, {}, {
      visibleScenarioIds: ['current'],
      scenarioVisibilityModes: { current: 'f' },
    });
    // Test data has no model_midpoint/model_bands, so only forecast_shading is produced
    const ids = option.series.map((s: any) => s.id);
    expect(ids).toContain('current::forecast_shading');
    expect(ids).not.toContain('current::solid');
    expect(ids).not.toContain('current::dashedEvidence');
  });

  it('should render evidence-only in e mode (no forecast series)', () => {
    const option = buildCohortMaturityEChartsOption(COHORT_MATURITY_RESULT, {}, {
      visibleScenarioIds: ['current'],
      scenarioVisibilityModes: { current: 'e' },
    });
    const ids = option.series.map((s: any) => s.id);
    expect(ids).toContain('current::solid');
    expect(ids).not.toContain('current::dashedEvidence');
    expect(ids).not.toContain('current::midpoint');
    expect(ids).not.toContain('current::fan');
  });

  it('should embed dagnet_meta with subject_id and date ranges', () => {
    const option = buildCohortMaturityEChartsOption(COHORT_MATURITY_RESULT, {}, { visibleScenarioIds: ['current'] });
    expect(option.dagnet_meta.subject_id).toBe('edge1');
    expect(option.dagnet_meta.anchor.from).toBe('2025-09-01');
    expect(option.dagnet_meta.sweep.to).toBe('2025-10-15');
  });

  it('should return null for empty data', () => {
    expect(buildCohortMaturityEChartsOption({ data: [] })).toBeNull();
  });

  it('should return null when no signal in filtered rows', () => {
    const noSignal = {
      data: [{ scenario_id: 'current', subject_id: 'edge1', tau_days: 5, rate: null, projected_rate: null, tau_solid_max: 10, tau_future_max: 20 }],
      dimension_values: { scenario_id: { current: { name: 'Base' } }, subject_id: { edge1: { name: 'Edge 1' } } },
    };
    expect(buildCohortMaturityEChartsOption(noSignal, {}, { visibleScenarioIds: ['current'] })).toBeNull();
  });

  it('should dispatch via buildChartOption', () => {
    const option = buildChartOption('cohort_maturity', COHORT_MATURITY_RESULT, {}, { visibleScenarioIds: ['current'] });
    expect(option).not.toBeNull();
    expect(option.dagnet_meta).toBeDefined();
  });
});
