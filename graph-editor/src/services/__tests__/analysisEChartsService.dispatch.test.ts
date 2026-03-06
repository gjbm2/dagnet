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
  it('should produce series with segment split (solid + dashed + future)', () => {
    const option = buildCohortMaturityEChartsOption(COHORT_MATURITY_RESULT, {}, { visibleScenarioIds: ['current'] });
    expect(option).not.toBeNull();
    expect(option.series.length).toBeGreaterThanOrEqual(3);

    const ids = option.series.map((s: any) => s.id);
    expect(ids).toContain('current::baseSolid');
    expect(ids).toContain('current::baseDashed');
    expect(ids).toContain('current::futureForecast');
  });

  it('should include crown fill series in f+e mode', () => {
    const option = buildCohortMaturityEChartsOption(COHORT_MATURITY_RESULT, {}, {
      visibleScenarioIds: ['current'],
      scenarioVisibilityModes: { current: 'f+e' },
    });
    const ids = option.series.map((s: any) => s.id);
    expect(ids).toContain('current::crownUpper');
    expect(ids).toContain('current::crownMask');
  });

  it('should render forecast-only in f mode', () => {
    const option = buildCohortMaturityEChartsOption(COHORT_MATURITY_RESULT, {}, {
      visibleScenarioIds: ['current'],
      scenarioVisibilityModes: { current: 'f' },
    });
    expect(option.series).toHaveLength(1);
    expect(option.series[0].id).toBe('current::forecast');
    expect(option.series[0].lineStyle.type).toBe('dashed');
  });

  it('should render evidence-only in e mode (no forecast series)', () => {
    const option = buildCohortMaturityEChartsOption(COHORT_MATURITY_RESULT, {}, {
      visibleScenarioIds: ['current'],
      scenarioVisibilityModes: { current: 'e' },
    });
    const ids = option.series.map((s: any) => s.id);
    expect(ids).toContain('current::baseSolid');
    expect(ids).toContain('current::baseDashed');
    expect(ids).not.toContain('current::crownUpper');
    expect(ids).not.toContain('current::futureForecast');
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
