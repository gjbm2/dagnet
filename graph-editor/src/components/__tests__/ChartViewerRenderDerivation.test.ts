/**
 * Chart tab render derivation test.
 *
 * Tests that the ChartViewer derivation logic correctly reads
 * definition.display from chart file data and produces the right
 * props for AnalysisChartContainer.
 *
 * This tests the EXACT derivation code from ChartViewer lines 86-100,
 * not via React rendering, but by extracting the pure derivation logic.
 */

import { describe, it, expect } from 'vitest';
import { getDisplaySettings, resolveDisplaySetting } from '../../lib/analysisDisplaySettingsRegistry';

function makeChartData(overrides?: { definitionDisplay?: Record<string, any> }) {
  return {
    version: '1.0.0',
    chart_kind: 'analysis_bridge',
    title: 'Test Bridge',
    definition: {
      title: 'Test Bridge',
      view_mode: 'chart' as const,
      chart_kind: 'bridge',
      display: overrides?.definitionDisplay || {},
      recipe: {
        analysis: { analysis_type: 'bridge_view', analytics_dsl: 'to(purchase)' },
        scenarios: [
          { scenario_id: 'current', name: 'Current', colour: '#3b82f6', visibility_mode: 'f+e' },
          { scenario_id: 'sc-1', name: 'Test', colour: '#ec4899', visibility_mode: 'f+e' },
        ],
      },
    },
    recipe: {
      parent: { parent_file_id: 'graph-test' },
      analysis: { analysis_type: 'bridge_view' },
      scenarios: [],
      display: {},
      pinned_recompute_eligible: true,
    },
    payload: {
      analysis_result: { analysis_type: 'bridge_view', semantics: { chart: { recommended: 'bridge' } } },
      scenario_ids: ['current', 'sc-1'],
    },
  };
}

/** Exact derivation from ChartViewer lines 86-100 */
function deriveChartViewerState(data: any) {
  const chart = data;
  const def = chart?.definition || (chart ? {
    title: chart.title,
    view_mode: 'chart',
    chart_kind: chart.chart_kind,
    display: chart.recipe?.display || {},
    recipe: chart.recipe ? { analysis: chart.recipe.analysis, scenarios: chart.recipe.scenarios } : { analysis: {} },
  } : undefined);

  const chartDef = {
    title: def?.title || '',
    view_mode: (def?.view_mode || 'chart') as 'chart' | 'cards',
    chart_kind: def?.chart_kind,
    display: (def?.display || {}) as Record<string, unknown>,
  };

  const defRecipe = def?.recipe;
  const effectiveChartKind = chartDef.chart_kind || chart?.payload?.analysis_result?.semantics?.chart?.recommended;

  // Derive resolvedSettings (same as AnalysisChartContainer)
  const kind = effectiveChartKind;
  const settings = kind ? getDisplaySettings(kind, 'chart') : [];
  const resolvedSettings: Record<string, any> = {};
  for (const s of settings) {
    resolvedSettings[s.key] = resolveDisplaySetting(chartDef.display, s);
  }

  return { chartDef, defRecipe, effectiveChartKind, resolvedSettings };
}

describe('ChartViewer render derivation from definition', () => {
  it('default orientation is vertical', () => {
    const data = makeChartData();
    const { resolvedSettings } = deriveChartViewerState(data);
    expect(resolvedSettings.orientation).toBe('vertical');
  });

  it('definition.display.orientation = horizontal is respected', () => {
    const data = makeChartData({ definitionDisplay: { orientation: 'horizontal' } });
    const { resolvedSettings } = deriveChartViewerState(data);
    expect(resolvedSettings.orientation).toBe('horizontal');
  });

  it('definition.display.show_legend = false is respected', () => {
    const data = makeChartData({ definitionDisplay: { show_legend: false } });
    const { resolvedSettings } = deriveChartViewerState(data);
    expect(resolvedSettings.show_legend).toBe(false);
  });

  it('definition.display.show_running_total = false is respected', () => {
    const data = makeChartData({ definitionDisplay: { show_running_total: false } });
    const { resolvedSettings } = deriveChartViewerState(data);
    expect(resolvedSettings.show_running_total).toBe(false);
  });

  it('chartDef.display reflects definition.display directly', () => {
    const data = makeChartData({ definitionDisplay: { orientation: 'horizontal', show_legend: false } });
    const { chartDef } = deriveChartViewerState(data);
    expect(chartDef.display.orientation).toBe('horizontal');
    expect(chartDef.display.show_legend).toBe(false);
  });

  it('scenarios come from definition.recipe.scenarios, not top-level recipe', () => {
    const data = makeChartData();
    const { defRecipe } = deriveChartViewerState(data);
    expect(defRecipe.scenarios).toHaveLength(2);
    expect(defRecipe.scenarios[0].scenario_id).toBe('current');
    expect(defRecipe.scenarios[1].scenario_id).toBe('sc-1');
  });

  it('legacy chart file without definition falls back correctly', () => {
    const data = {
      version: '1.0.0',
      chart_kind: 'analysis_bridge',
      title: 'Legacy Chart',
      recipe: {
        analysis: { analysis_type: 'bridge_view' },
        scenarios: [{ scenario_id: 'current', name: 'Current' }],
        display: { orientation: 'horizontal' },
      },
      payload: {
        analysis_result: { analysis_type: 'bridge_view', semantics: { chart: { recommended: 'bridge' } } },
        scenario_ids: ['current'],
      },
    };
    const { chartDef, defRecipe } = deriveChartViewerState(data);
    expect(chartDef.title).toBe('Legacy Chart');
    expect(chartDef.display.orientation).toBe('horizontal');
    expect(defRecipe.scenarios).toHaveLength(1);
    // Note: effectiveChartKind resolves to 'analysis_bridge' (top-level chart_kind)
    // which the registry doesn't recognise as 'bridge'. Display settings only resolve
    // when effectiveChartKind matches a registry key. This is a pre-existing
    // normalisation gap for legacy files; new files use definition.chart_kind = 'bridge'.
    expect(chartDef.chart_kind).toBe('analysis_bridge');
  });
});
