/**
 * Verifies Option A: graph-mastered latency horizons are persisted back to parameter files
 * (metadata-only), unless the file has an override flag.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';

import type { Graph } from '../../types';
import { fileRegistry } from '../../contexts/TabContext';
import { db } from '../../db/appDatabase';
import { persistGraphMasteredLatencyToParameterFiles } from '../fetchDataService';

async function hardResetState(): Promise<void> {
  await Promise.all([
    db.workspaces.clear(),
    db.files.clear(),
    db.tabs.clear(),
    db.scenarios.clear(),
    db.appState.clear(),
    db.settings.clear(),
    db.credentials.clear(),
  ]);
  try {
    const map = (fileRegistry as any).files as Map<string, any> | undefined;
    map?.clear();
  } catch {
    // ignore
  }
  try {
    const map = (fileRegistry as any)._files as Map<string, any> | undefined;
    map?.clear();
  } catch {
    // ignore
  }
}

async function registerFileForTest(fileId: string, type: any, data: any): Promise<void> {
  await fileRegistry.registerFile(fileId, {
    fileId,
    type,
    data,
    originalData: structuredClone(data),
    isDirty: false,
    isInitializing: false,
    source: { repository: 'test', branch: 'main', isLocal: true } as any,
    viewTabs: [],
    lastModified: Date.now(),
  } as any);
}

describe('persistGraphMasteredLatencyToParameterFiles', () => {
  beforeEach(async () => {
    await hardResetState();
  });

  it('writes latency.path_t95 from graph → parameter file when not overridden', async () => {
    await registerFileForTest('parameter-p1', 'parameter', {
      id: 'p1',
      type: 'probability',
      latency: { path_t95: 30.16, path_t95_overridden: false },
      values: [],
    });

    const graph: Graph = {
      nodes: [{ id: 'A' } as any, { id: 'B' } as any],
      edges: [{
        uuid: 'e1',
        id: 'A-to-B',
        from: 'A',
        to: 'B',
        query: 'from(A).to(B)',
        p: {
          id: 'p1',
          latency: { path_t95: 37.61, t95: 13.12, path_t95_overridden: false, t95_overridden: false },
        } as any,
      } as any],
    } as any;

    await persistGraphMasteredLatencyToParameterFiles({
      graph,
      setGraph: () => {},
      edgeIds: ['e1'],
    });

    const updated = fileRegistry.getFile('parameter-p1')?.data as any;
    expect(updated?.latency?.path_t95).toBe(37.61);
  });

  it('does NOT overwrite latency.path_t95 when file path_t95_overridden=true', async () => {
    await registerFileForTest('parameter-p1', 'parameter', {
      id: 'p1',
      type: 'probability',
      latency: { path_t95: 30.16, path_t95_overridden: true },
      values: [],
    });

    const graph: Graph = {
      nodes: [{ id: 'A' } as any, { id: 'B' } as any],
      edges: [{
        uuid: 'e1',
        id: 'A-to-B',
        from: 'A',
        to: 'B',
        query: 'from(A).to(B)',
        p: {
          id: 'p1',
          latency: { path_t95: 37.61, t95: 13.12, path_t95_overridden: false, t95_overridden: false },
        } as any,
      } as any],
    } as any;

    await persistGraphMasteredLatencyToParameterFiles({
      graph,
      setGraph: () => {},
      edgeIds: ['e1'],
    });

    const updated = fileRegistry.getFile('parameter-p1')?.data as any;
    expect(updated?.latency?.path_t95).toBe(30.16);
    expect(updated?.latency?.path_t95_overridden).toBe(true);
  });
});


