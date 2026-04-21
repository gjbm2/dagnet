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
    // First scenario series is "Base · Evidence"
    expect(option.series[0].name).toContain('Base');
    expect(option.series[0].name).toContain('· Evidence');
    expect(option.series[0].data[0].value).toBe(1.0);
    // Second series is "Base · Forecast": mid residual = 0.6 - 0.25 = 0.35
    expect(option.series[1].name).toContain('Base');
    expect(option.series[1].name).toContain('· Forecast');
    expect(option.series[1].data[1].value).toBeCloseTo(0.35);
  });

  it('renders stacked member bars for grouped stages (visitedAny)', () => {
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
          a: { name: 'A', order: 0 },
          'visitedAny:b,f': {
            name: 'B / F', order: 1,
            is_group: true,
            members: ['b', 'f'],
            member_labels: { b: 'B', f: 'F' },
          },
          c: { name: 'C', order: 2 },
        },
        scenario_id: {
          current: { name: 'Current', colour: '#3b82f6', visibility_mode: 'f+e', probability_label: 'Probability' },
        },
      },
      data: [
        { stage: 'a', scenario_id: 'current', probability: 1.0 },
        { stage: 'visitedAny:b,f', scenario_id: 'current', probability: 0.6, stage_member: 'b' },
        { stage: 'visitedAny:b,f', scenario_id: 'current', probability: 0.4, stage_member: 'f' },
        { stage: 'c', scenario_id: 'current', probability: 0.8 },
      ],
    };

    const option = buildFunnelBarEChartsOption(result, {
      scenarioIds: ['current'],
      metric: 'cumulative_probability',
    });

    expect(option).toBeTruthy();
    // Should have 3 series: base + member_b + member_f, all stacked on 'current'
    expect(option.series).toHaveLength(3);

    const [baseSeries, memberB, memberF] = option.series;

    // All share the same stack key
    expect(baseSeries.stack).toBe('current');
    expect(memberB.stack).toBe('current');
    expect(memberF.stack).toBe('current');

    // x-axis has 3 categories
    expect(option.xAxis.data).toHaveLength(3);

    // Base series: full value at non-grouped stages, 0 at grouped stage
    expect(baseSeries.data[0].value).toBe(1.0);  // Stage 'a'
    expect(baseSeries.data[1].value).toBe(0);     // Grouped stage (placeholder)
    expect(baseSeries.data[2].value).toBe(0.8);   // Stage 'c'

    // Member B series: 0 at non-grouped stages, 0.6 at grouped stage
    expect(memberB.data[0].value).toBe(0);
    expect(memberB.data[1].value).toBe(0.6);
    expect(memberB.data[2].value).toBe(0);

    // Member F series: 0 at non-grouped stages, 0.4 at grouped stage
    expect(memberF.data[0].value).toBe(0);
    expect(memberF.data[1].value).toBe(0.4);
    expect(memberF.data[2].value).toBe(0);

    // Member series names contain member labels
    expect(memberB.name).toContain('B');
    expect(memberF.name).toContain('F');
  });

  it('multi-scenario grouped stages produce side-by-side stacked bars', () => {
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
          a: { name: 'A', order: 0 },
          'visitedAny:b,f': {
            name: 'B / F', order: 1,
            is_group: true,
            members: ['b', 'f'],
            member_labels: { b: 'B', f: 'F' },
          },
          c: { name: 'C', order: 2 },
        },
        scenario_id: {
          s1: { name: 'Scenario 1', colour: '#3b82f6', visibility_mode: 'f+e', probability_label: 'Probability' },
          s2: { name: 'Scenario 2', colour: '#10b981', visibility_mode: 'f+e', probability_label: 'Probability' },
        },
      },
      data: [
        { stage: 'a', scenario_id: 's1', probability: 1.0 },
        { stage: 'visitedAny:b,f', scenario_id: 's1', probability: 0.6, stage_member: 'b' },
        { stage: 'visitedAny:b,f', scenario_id: 's1', probability: 0.4, stage_member: 'f' },
        { stage: 'c', scenario_id: 's1', probability: 0.8 },

        { stage: 'a', scenario_id: 's2', probability: 1.0 },
        { stage: 'visitedAny:b,f', scenario_id: 's2', probability: 0.5, stage_member: 'b' },
        { stage: 'visitedAny:b,f', scenario_id: 's2', probability: 0.5, stage_member: 'f' },
        { stage: 'c', scenario_id: 's2', probability: 0.7 },
      ],
    };

    const option = buildFunnelBarEChartsOption(result, {
      scenarioIds: ['s1', 's2'],
      metric: 'cumulative_probability',
    });

    expect(option).toBeTruthy();
    // 2 scenarios × (1 base + 2 members) = 6 series
    expect(option.series).toHaveLength(6);

    // S1 series all share stack 's1', S2 series share stack 's2'
    const s1Series = option.series.filter((s: any) => s.stack === 's1');
    const s2Series = option.series.filter((s: any) => s.stack === 's2');
    expect(s1Series).toHaveLength(3);
    expect(s2Series).toHaveLength(3);
  });

  it('emits hi/lo whisker custom series when probability_lo/hi are present (doc 52 Level 2)', () => {
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
        chart: { recommended: 'funnel', hints: { show_hi_lo: true, stacked_striation: true } },
      },
      dimension_values: {
        stage: {
          start: { name: 'Start', order: 0 },
          mid: { name: 'Mid', order: 1 },
          end: { name: 'End', order: 2 },
        },
        scenario_id: {
          current: { name: 'Current', colour: '#3b82f6', visibility_mode: 'f', probability_label: 'Forecast probability' },
        },
      },
      data: [
        { stage: 'start', scenario_id: 'current', probability: 1.0 },
        { stage: 'mid', scenario_id: 'current', probability: 0.55, probability_lo: 0.40, probability_hi: 0.70 },
        { stage: 'end', scenario_id: 'current', probability: 0.30, probability_lo: 0.18, probability_hi: 0.45 },
      ],
    };

    const option = buildFunnelBarEChartsOption(result, {
      scenarioIds: ['current'],
      metric: 'cumulative_probability',
    });

    expect(option).toBeTruthy();
    // Bar series + whisker custom series
    expect(option.series).toHaveLength(2);
    const whisker = option.series.find((s: any) => s.type === 'custom');
    expect(whisker).toBeTruthy();
    // 2 stages with bands (start skipped because lo/hi are absent)
    expect(whisker.data).toHaveLength(2);
    // [stageIdx, lo, hi]
    expect(whisker.data[0]).toEqual([1, 0.40, 0.70]);
    expect(whisker.data[1]).toEqual([2, 0.18, 0.45]);
  });

  it('emits hi/lo whisker custom series alongside f+e stacked bars', () => {
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
        },
      },
      data: [
        { stage: 'start', scenario_id: 'current', probability: 1.0, evidence_mean: 1.0, p_mean: 1.0 },
        { stage: 'mid', scenario_id: 'current', probability: 0.5, evidence_mean: 0.3, p_mean: 0.5, probability_lo: 0.42, probability_hi: 0.58 },
        { stage: 'end', scenario_id: 'current', probability: 0.2, evidence_mean: 0.1, p_mean: 0.2, probability_lo: 0.14, probability_hi: 0.27 },
      ],
    };

    const option = buildFunnelBarEChartsOption(result, {
      scenarioIds: ['current'],
      metric: 'cumulative_probability',
    });
    expect(option).toBeTruthy();
    // e + f−e stacked + whisker custom = 3 series
    expect(option.series).toHaveLength(3);
    const whisker = option.series.find((s: any) => s.type === 'custom');
    expect(whisker).toBeTruthy();
    expect(whisker.data).toHaveLength(2);
    expect(whisker.data[0]).toEqual([1, 0.42, 0.58]);
    expect(whisker.data[1]).toEqual([2, 0.14, 0.27]);
  });

  it('disables F+E stacking when grouped stages are present', () => {
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
          a: { name: 'A', order: 0 },
          'visitedAny:b,f': {
            name: 'B / F', order: 1,
            is_group: true,
            members: ['b', 'f'],
            member_labels: { b: 'B', f: 'F' },
          },
          c: { name: 'C', order: 2 },
        },
        scenario_id: {
          current: { name: 'Current', colour: '#3b82f6', visibility_mode: 'f+e', probability_label: 'Probability' },
        },
      },
      data: [
        { stage: 'a', scenario_id: 'current', probability: 1.0, evidence_mean: 1.0, p_mean: 1.0 },
        { stage: 'visitedAny:b,f', scenario_id: 'current', probability: 0.6, stage_member: 'b' },
        { stage: 'visitedAny:b,f', scenario_id: 'current', probability: 0.4, stage_member: 'f' },
        { stage: 'c', scenario_id: 'current', probability: 0.8, evidence_mean: 0.5, p_mean: 0.8 },
      ],
    };

    const option = buildFunnelBarEChartsOption(result, {
      scenarioIds: ['current'],
      metric: 'cumulative_probability',
    });

    // Should NOT have F+E stacked series (no "· Evidence" or "· Forecast" series names)
    const seriesNames = option.series.map((s: any) => s.name);
    expect(seriesNames.some((n: string) => n.includes('· Evidence'))).toBe(false);
    expect(seriesNames.some((n: string) => n.includes('· Forecast'))).toBe(false);

    // Should have member series instead
    expect(seriesNames.some((n: string) => n.includes('— B'))).toBe(true);
    expect(seriesNames.some((n: string) => n.includes('— F'))).toBe(true);
  });
});


