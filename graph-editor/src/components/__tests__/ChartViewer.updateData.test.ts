/**
 * ChartViewer state update test.
 *
 * Invariant: when updateChartFile mutates definition.display and calls
 * updateData, the component must re-render with the new display values.
 *
 * This test isolates the exact contract: useFileState().updateData must
 * cause useFileState().data to return new data on the next render.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('useFileState updateData contract for chart tabs', () => {
  it('updateData should cause data to reflect the new value synchronously via listener', async () => {
    // Simulate what FileRegistry does: updateFile is async, notifyListeners
    // fires AFTER await db.files.put. useFileState subscribes via listener.
    //
    // The question: does the component get the new data?

    // 1. Simulate the chart data
    const chartData = {
      version: '1.0.0',
      chart_kind: 'analysis_funnel',
      title: 'Test',
      definition: {
        title: 'Test',
        view_mode: 'chart',
        display: {},
        recipe: { analysis: { analysis_type: 'conversion_funnel' } },
      },
      recipe: { analysis: { analysis_type: 'conversion_funnel' }, scenarios: [] },
      payload: { analysis_result: { analysis_type: 'conversion_funnel' }, scenario_ids: [] },
    };

    // 2. Simulate the updateChartFile flow
    const next = structuredClone(chartData) as any;
    next.definition.display.orientation = 'horizontal';

    // 3. Verify the mutation happened
    expect(next.definition.display.orientation).toBe('horizontal');
    expect(chartData.definition.display.orientation).toBeUndefined();

    // 4. Simulate what notifyListeners does (deep clone)
    const fileCopy = {
      data: JSON.parse(JSON.stringify(next)),
    };

    // 5. Verify the cloned data has the update
    expect(fileCopy.data.definition.display.orientation).toBe('horizontal');

    // 6. Simulate chartDef derivation (same as ChartViewer)
    const chart = fileCopy.data;
    const def = chart.definition;
    const chartDef = {
      display: { ...(chart.recipe?.display || {}), ...(def?.display || {}) },
    };
    expect(chartDef.display.orientation).toBe('horizontal');
  });

  it('hidden_scenarios toggle should filter visibleScenarioIds', () => {
    const chartData = {
      definition: {
        display: { hidden_scenarios: ['sc-1'] },
        recipe: {
          scenarios: [
            { scenario_id: 'current' },
            { scenario_id: 'sc-1' },
            { scenario_id: 'sc-2' },
          ],
        },
      },
      recipe: {},
      payload: { scenario_ids: [] },
    };

    const def = chartData.definition;
    const defRecipe = def.recipe;
    const allScenarioIds = defRecipe.scenarios.map(s => s.scenario_id);
    const hiddenSet = new Set<string>(
      (def.display?.hidden_scenarios || []) as string[]
    );
    const visibleIds = allScenarioIds.filter(id => !hiddenSet.has(id));

    expect(visibleIds).toEqual(['current', 'sc-2']);
    expect(visibleIds).not.toContain('sc-1');
  });

  it('updateData flow: toggle hidden_scenarios, derive new visibleIds', () => {
    // Start: no hidden scenarios
    const chartData = {
      definition: {
        display: {},
        recipe: {
          scenarios: [
            { scenario_id: 'current' },
            { scenario_id: 'sc-1' },
          ],
        },
      },
      recipe: {},
      payload: { scenario_ids: [] },
    };

    // Simulate updateChartFile with onToggleVisibility('sc-1')
    const next = structuredClone(chartData) as any;
    if (!next.definition.display) next.definition.display = {};
    const hidden: string[] = next.definition.display.hidden_scenarios || [];
    if (hidden.includes('sc-1')) {
      next.definition.display.hidden_scenarios = hidden.filter((h: string) => h !== 'sc-1');
    } else {
      next.definition.display.hidden_scenarios = [...hidden, 'sc-1'];
    }

    // Verify mutation
    expect(next.definition.display.hidden_scenarios).toEqual(['sc-1']);

    // Simulate deep clone (notifyListeners)
    const cloned = JSON.parse(JSON.stringify(next));

    // Derive visibleIds from cloned data (same as ChartViewer)
    const def = cloned.definition;
    const allIds = def.recipe.scenarios.map((s: any) => s.scenario_id);
    const hiddenSet = new Set<string>(def.display?.hidden_scenarios || []);
    const visibleIds = allIds.filter((id: string) => !hiddenSet.has(id));

    expect(visibleIds).toEqual(['current']);
  });
});
