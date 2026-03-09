/**
 * Chart tab state integration test.
 *
 * Tests the ACTUAL state flow:
 *   1. Create a chart file in FileRegistry
 *   2. Subscribe via useFileState pattern
 *   3. Call updateFile with changed definition.display
 *   4. Assert the subscriber receives the new data
 *   5. Assert the derived render state (chartDef, scenarioIds) reflects the change
 *
 * This test uses real FileRegistry + real IDB (fake-indexeddb).
 * No mocks. No shortcuts. Tests the actual contract.
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';

let fileRegistry: any;
let db: any;

beforeEach(async () => {
  const tabCtx = await import('../../contexts/TabContext');
  fileRegistry = tabCtx.fileRegistry;
  const dbMod = await import('../../db/appDatabase');
  db = dbMod.db;
  await db.files.clear();
});

function makeChartFileData() {
  return {
    version: '1.0.0',
    chart_kind: 'analysis_bridge',
    title: 'Test Bridge',
    created_at_uk: '9-Mar-26',
    created_at_ms: Date.now(),
    source: { parent_file_id: 'graph-test', parent_tab_id: 'tab-test', query_dsl: 'to(purchase)', analysis_type: 'bridge_view' },
    definition: {
      title: 'Test Bridge',
      view_mode: 'chart' as const,
      chart_kind: 'bridge',
      display: {},
      recipe: {
        analysis: { analysis_type: 'bridge_view', analytics_dsl: 'to(purchase)' },
        scenarios: [
          { scenario_id: 'current', name: 'Current', colour: '#3b82f6', effective_dsl: 'window(-30d:)', visibility_mode: 'f+e' as const },
          { scenario_id: 'sc-1', name: 'Test Scenario', colour: '#ec4899', effective_dsl: 'window(-30d:).context(device:mobile)', visibility_mode: 'f+e' as const },
        ],
      },
    },
    recipe: {
      parent: { parent_file_id: 'graph-test', parent_tab_id: 'tab-test' },
      analysis: { analysis_type: 'bridge_view', query_dsl: 'to(purchase)' },
      scenarios: [
        { scenario_id: 'current', name: 'Current', colour: '#3b82f6', effective_dsl: 'window(-30d:)', visibility_mode: 'f+e' },
        { scenario_id: 'sc-1', name: 'Test Scenario', colour: '#ec4899', effective_dsl: 'window(-30d:).context(device:mobile)', visibility_mode: 'f+e' },
      ],
      display: {},
      pinned_recompute_eligible: true,
    },
    deps: { v: 1, mode: 'linked', chart_kind: 'analysis_bridge' },
    deps_signature: 'test-sig',
    payload: {
      analysis_result: {
        analysis_type: 'bridge_view',
        analysis_name: 'Bridge View',
        data: [{ scenario_id: 'current', value: 0.5 }],
        semantics: { chart: { recommended: 'bridge', alternatives: [] } },
        dimension_values: { scenario_id: { current: { name: 'Current' }, 'sc-1': { name: 'Test Scenario' } } },
      },
      scenario_ids: ['current', 'sc-1'],
    },
  };
}

/** Derives chartDef the same way ChartViewer does */
function deriveChartDef(chartData: any) {
  const def = chartData?.definition;
  const defRecipe = def?.recipe || chartData?.recipe;
  return {
    title: def?.title || chartData?.title,
    view_mode: (def?.view_mode || 'chart') as 'chart' | 'cards',
    chart_kind: def?.chart_kind || chartData?.chart_kind,
    display: { ...(chartData?.recipe?.display || {}), ...(def?.display || {}) },
    defRecipe,
  };
}

/** Derives visible scenario IDs the same way ChartViewer does */
function deriveVisibleScenarioIds(chartData: any) {
  const { defRecipe, display } = deriveChartDef(chartData);
  const allIds = (defRecipe?.scenarios || []).map((s: any) => s.scenario_id).filter(Boolean);
  const hiddenSet = new Set<string>((display?.hidden_scenarios || []) as string[]);
  return allIds.filter((id: string) => !hiddenSet.has(id));
}

describe('Chart tab state: FileRegistry -> useFileState -> ChartViewer render pipeline', () => {
  
  it('subscriber receives updated data after updateFile', async () => {
    const fileId = 'chart-test-1';
    const initial = makeChartFileData();

    await fileRegistry.registerFile(fileId, {
      fileId, type: 'chart', data: initial, originalData: structuredClone(initial),
      isDirty: false, isInitializing: false, lastModified: Date.now(), viewTabs: [],
    });

    // Subscribe (simulates useFileState)
    let latestData: any = null;
    let callCount = 0;
    const unsub = fileRegistry.subscribe(fileId, (file: any) => {
      latestData = file?.data;
      callCount++;
    });

    // Simulate updateChartFile: clone, mutate definition.display, updateFile
    const next = structuredClone(initial);
    next.definition.display.orientation = 'horizontal';
    await fileRegistry.updateFile(fileId, next);

    expect(callCount).toBeGreaterThanOrEqual(1);
    expect(latestData).not.toBeNull();
    expect(latestData.definition.display.orientation).toBe('horizontal');

    unsub();
  });

  it('chartDef.display reflects definition.display after update', async () => {
    const fileId = 'chart-test-2';
    const initial = makeChartFileData();

    await fileRegistry.registerFile(fileId, {
      fileId, type: 'chart', data: initial, originalData: structuredClone(initial),
      isDirty: false, isInitializing: false, lastModified: Date.now(), viewTabs: [],
    });

    // Before update
    const beforeDef = deriveChartDef(initial);
    expect(beforeDef.display.orientation).toBeUndefined();

    // Update
    const next = structuredClone(initial);
    next.definition.display.orientation = 'horizontal';
    await fileRegistry.updateFile(fileId, next);

    // Read back from registry (simulates useFileState after setFile)
    const file = fileRegistry.getFile(fileId);
    const afterDef = deriveChartDef(file.data);
    expect(afterDef.display.orientation).toBe('horizontal');
  });

  it('hidden_scenarios filters visibleScenarioIds after update', async () => {
    const fileId = 'chart-test-3';
    const initial = makeChartFileData();

    await fileRegistry.registerFile(fileId, {
      fileId, type: 'chart', data: initial, originalData: structuredClone(initial),
      isDirty: false, isInitializing: false, lastModified: Date.now(), viewTabs: [],
    });

    // Before: both scenarios visible
    expect(deriveVisibleScenarioIds(initial)).toEqual(['current', 'sc-1']);

    // Hide sc-1
    const next = structuredClone(initial);
    next.definition.display.hidden_scenarios = ['sc-1'];
    await fileRegistry.updateFile(fileId, next);

    // Read back
    const file = fileRegistry.getFile(fileId);
    expect(deriveVisibleScenarioIds(file.data)).toEqual(['current']);
  });

  it('data survives IDB round-trip (simulates F5)', async () => {
    const fileId = 'chart-test-4';
    const initial = makeChartFileData();

    await fileRegistry.registerFile(fileId, {
      fileId, type: 'chart', data: initial, originalData: structuredClone(initial),
      isDirty: false, isInitializing: false, lastModified: Date.now(), viewTabs: [],
    });

    // Update display
    const next = structuredClone(initial);
    next.definition.display.orientation = 'horizontal';
    next.definition.display.show_legend = false;
    next.definition.display.hidden_scenarios = ['sc-1'];
    await fileRegistry.updateFile(fileId, next);

    // Verify in-memory
    const inMemory = fileRegistry.getFile(fileId);
    expect(inMemory.data.definition.display.orientation).toBe('horizontal');

    // Simulate F5: read directly from IDB (bypassing in-memory cache)
    const fromIdb = await db.files.get(fileId);
    expect(fromIdb).not.toBeNull();
    expect(fromIdb.data.definition.display.orientation).toBe('horizontal');
    expect(fromIdb.data.definition.display.show_legend).toBe(false);
    expect(fromIdb.data.definition.display.hidden_scenarios).toEqual(['sc-1']);

    // Verify derived state from IDB data matches expectations
    const idbChartDef = deriveChartDef(fromIdb.data);
    expect(idbChartDef.display.orientation).toBe('horizontal');
    expect(idbChartDef.display.show_legend).toBe(false);

    const idbVisibleIds = deriveVisibleScenarioIds(fromIdb.data);
    expect(idbVisibleIds).toEqual(['current']);
  });

  it('multiple sequential updates accumulate correctly', async () => {
    const fileId = 'chart-test-5';
    const initial = makeChartFileData();

    await fileRegistry.registerFile(fileId, {
      fileId, type: 'chart', data: initial, originalData: structuredClone(initial),
      isDirty: false, isInitializing: false, lastModified: Date.now(), viewTabs: [],
    });

    // First update: change orientation
    let current = structuredClone(initial);
    current.definition.display.orientation = 'horizontal';
    await fileRegistry.updateFile(fileId, current);

    // Second update: READ BACK FROM REGISTRY then change legend
    // This simulates what updateChartFile does: it clones `data` which comes from useFileState
    const afterFirst = fileRegistry.getFile(fileId);
    current = structuredClone(afterFirst.data);
    current.definition.display.show_legend = false;
    await fileRegistry.updateFile(fileId, current);

    // Verify both changes persisted
    const final = fileRegistry.getFile(fileId);
    expect(final.data.definition.display.orientation).toBe('horizontal');
    expect(final.data.definition.display.show_legend).toBe(false);
  });

  it('updateChartFile pattern: clone data, mutate, updateFile - subscriber sees change', async () => {
    const fileId = 'chart-test-6';
    const initial = makeChartFileData();

    await fileRegistry.registerFile(fileId, {
      fileId, type: 'chart', data: initial, originalData: structuredClone(initial),
      isDirty: false, isInitializing: false, lastModified: Date.now(), viewTabs: [],
    });

    // Track what subscriber receives (simulates useFileState setFile)
    const receivedData: any[] = [];
    const unsub = fileRegistry.subscribe(fileId, (file: any) => {
      receivedData.push(structuredClone(file?.data));
    });

    // Simulate EXACT updateChartFile flow from ChartViewer
    // Step 1: "data" comes from useFileState = file?.data
    const useFileStateData = fileRegistry.getFile(fileId)?.data;
    // Step 2: structuredClone(data)
    const next = structuredClone(useFileStateData);
    // Step 3: mutator modifies definition.display
    if (!next.definition) next.definition = {};
    if (!next.definition.display) next.definition.display = {};
    next.definition.display.orientation = 'horizontal';
    // Step 4: updateData(next) -> fileRegistry.updateFile
    await fileRegistry.updateFile(fileId, next);

    // Verify subscriber received the update
    expect(receivedData.length).toBe(1);
    expect(receivedData[0].definition.display.orientation).toBe('horizontal');

    // Verify derived render state from received data
    const chartDef = deriveChartDef(receivedData[0]);
    expect(chartDef.display.orientation).toBe('horizontal');

    unsub();
  });
});
