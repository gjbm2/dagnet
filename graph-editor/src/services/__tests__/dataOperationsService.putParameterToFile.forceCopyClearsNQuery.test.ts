/**
 * Regression: "Copy all (force copy)" on PUT should be able to clear stale file-side fields
 * even when the graph omits them (treat omission as cleared).
 *
 * Specifically:
 * - If file has n_query + n_query_overridden=true but graph has no n_query, force-copy should
 *   write n_query='' and n_query_overridden=false so versioned fetch cannot diverge.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';

import type { Graph } from '../../types';
import { fileRegistry } from '../../contexts/TabContext';
import { db } from '../../db/appDatabase';
import { dataOperationsService } from '../dataOperationsService';

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
  } catch {}
  try {
    const map = (fileRegistry as any)._files as Map<string, any> | undefined;
    map?.clear();
  } catch {}
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

describe('DataOperationsService.putParameterToFile (force copy clears n_query)', () => {
  beforeEach(async () => {
    await hardResetState();
  });

  it('clears file n_query and n_query_overridden when graph omits them and permissionsMode=copy_all', async () => {
    // File starts with stale n_query locked true.
    await registerFileForTest('parameter-delegated-to-coffee', 'parameter', {
      id: 'delegated-to-coffee',
      type: 'probability',
      query: 'from(household-delegated).to(viewed-coffee-screen)',
      n_query: 'from(household-created).to(household-delegated)',
      n_query_overridden: true,
      values: [],
    });

    const graph: Graph = {
      nodes: [{ id: 'household-delegated' } as any, { id: 'viewed-coffee-screen' } as any],
      edges: [{
        uuid: 'e1',
        id: 'household-delegated-to-viewed-coffee-screen',
        from: 'household-delegated',
        to: 'viewed-coffee-screen',
        query: 'from(household-delegated).to(viewed-coffee-screen)',
        // Graph omits n_query + n_query_overridden intentionally
        p: { id: 'delegated-to-coffee' } as any,
      } as any],
    } as any;

    await dataOperationsService.putParameterToFile({
      paramId: 'delegated-to-coffee',
      edgeId: 'e1',
      graph,
      setGraph: () => {},
      copyOptions: {
        includeMetadata: true,
        includeValues: false,
        permissionsMode: 'copy_all', // force copy
      },
    });

    const updated = fileRegistry.getFile('parameter-delegated-to-coffee')?.data as any;
    expect(updated?.n_query).toBe('');
    expect(updated?.n_query_overridden).toBe(false);
  });
});


