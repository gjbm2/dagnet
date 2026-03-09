/**
 * FileRegistry.updateFile listener notification test.
 *
 * Invariant: after updateFile completes, subscribed listeners must have
 * been called with the new data.
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';

// Must import after fake-indexeddb is loaded
let fileRegistry: any;
let db: any;

beforeEach(async () => {
  // Dynamic import to pick up fake-indexeddb
  const tabCtx = await import('../../contexts/TabContext');
  fileRegistry = tabCtx.fileRegistry;
  const dbMod = await import('../../db/appDatabase');
  db = dbMod.db;
  // Clear state
  await db.files.clear();
});

describe('FileRegistry.updateFile listener contract', () => {
  it('listener should be called with new data after updateFile', async () => {
    const fileId = 'test-chart-1';
    const initialData = {
      version: '1.0.0',
      title: 'Before',
      definition: { display: {} },
      payload: { analysis_result: null, scenario_ids: [] },
    };

    // Register file
    await fileRegistry.registerFile(fileId, {
      fileId,
      type: 'chart',
      data: initialData,
      originalData: structuredClone(initialData),
      isDirty: false,
      isInitializing: false,
      lastModified: Date.now(),
      viewTabs: [],
    });

    // Subscribe
    const received: any[] = [];
    const unsub = fileRegistry.subscribe(fileId, (file: any) => {
      received.push(structuredClone(file?.data));
    });

    // Update
    const nextData = structuredClone(initialData);
    (nextData as any).definition.display.orientation = 'horizontal';
    (nextData as any).title = 'After';
    await fileRegistry.updateFile(fileId, nextData);

    // Verify listener was called
    expect(received.length).toBeGreaterThanOrEqual(1);
    const last = received[received.length - 1];
    expect(last.title).toBe('After');
    expect(last.definition.display.orientation).toBe('horizontal');

    unsub();
  });

  it('useFileState pattern: subscribe + updateFile should deliver new data', async () => {
    const fileId = 'test-chart-2';
    const initialData = {
      version: '1.0.0',
      definition: { display: {}, recipe: { scenarios: [{ scenario_id: 'current' }, { scenario_id: 'sc-1' }] } },
      recipe: {},
      payload: { analysis_result: null, scenario_ids: [] },
    };

    await fileRegistry.registerFile(fileId, {
      fileId,
      type: 'chart',
      data: initialData,
      originalData: structuredClone(initialData),
      isDirty: false,
      isInitializing: false,
      lastModified: Date.now(),
      viewTabs: [],
    });

    // Simulate useFileState: subscribe, track latest data
    let latestData: any = initialData;
    const unsub = fileRegistry.subscribe(fileId, (file: any) => {
      if (file) latestData = file.data;
    });

    // Simulate updateChartFile: clone, mutate, updateFile
    const next = structuredClone(latestData);
    next.definition.display.hidden_scenarios = ['sc-1'];
    await fileRegistry.updateFile(fileId, next);

    // Verify the listener received the update
    expect(latestData.definition.display.hidden_scenarios).toEqual(['sc-1']);

    unsub();
  });
});
