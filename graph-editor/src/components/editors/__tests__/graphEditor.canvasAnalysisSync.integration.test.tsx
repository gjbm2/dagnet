import React, { useEffect, useRef } from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, waitFor, cleanup } from '@testing-library/react';
import { GraphStoreContext, createGraphStore, useGraphStore } from '../../../contexts/GraphStoreContext';
import { useFileState, fileRegistry } from '../../../contexts/TabContext';
import type { FileState, GraphData } from '../../../types';
import { db } from '../../../db/appDatabase';

function makeGraph(title: string): GraphData {
  return {
    nodes: [{ uuid: 'n1', id: 'start', label: 'Start', entry: { is_start: true } }],
    edges: [],
    metadata: { name: 'sync-test' },
    canvasAnalyses: [{
      id: 'a-1',
      x: 0, y: 0, width: 400, height: 300,
      mode: 'fixed' as const,
      view_mode: 'chart',
      recipe: {
        analysis: { analysis_type: 'graph_overview', analytics_dsl: '' },
        scenarios: [{ scenario_id: 'current', name: title, colour: '#3b82f6' }],
      },
    }],
  } as any;
}

function SyncHarness({ fileId }: { fileId: string }) {
  const graph = useGraphStore((s) => s.graph) as GraphData | null;
  const graphRevision = useGraphStore((s) => s.graphRevision);
  const setGraph = useGraphStore((s) => s.setGraph);
  const { data, syncRevision: fileSyncRevision, syncOrigin: fileSyncOrigin, updateData } = useFileState<GraphData>(fileId);

  const lastSyncedContentRef = useRef<string>('');
  const suppressFileToStoreUntilRef = useRef<number>(0);
  const currentStoreRevisionRef = useRef<number>(0);
  const writtenStoreContentsRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    currentStoreRevisionRef.current = graphRevision;
  }, [graphRevision]);

  useEffect(() => {
    if (Date.now() < suppressFileToStoreUntilRef.current) return;
    const dataStr = data ? JSON.stringify(data) : '';
    if (!data || !data.nodes) return;
    if (dataStr === lastSyncedContentRef.current) return;
    const recordedRevision = writtenStoreContentsRef.current.get(dataStr);
    if (fileSyncOrigin === 'store' && recordedRevision !== undefined && recordedRevision < currentStoreRevisionRef.current) {
      return;
    }
    lastSyncedContentRef.current = dataStr;
    setGraph(data);
  }, [data, fileSyncOrigin, fileSyncRevision]);

  useEffect(() => {
    if (!graph || !graph.nodes) return;
    const graphStr = JSON.stringify(graph);
    if (graphStr === lastSyncedContentRef.current) return;
    lastSyncedContentRef.current = graphStr;
    writtenStoreContentsRef.current.set(graphStr, graphRevision);
    if (writtenStoreContentsRef.current.size > 25) {
      const oldestKey = writtenStoreContentsRef.current.keys().next().value;
      if (oldestKey) writtenStoreContentsRef.current.delete(oldestKey);
    }
    suppressFileToStoreUntilRef.current = Date.now() + 500;
    updateData(graph, { syncRevision: graphRevision, syncOrigin: 'store' });
  }, [graph, graphRevision, updateData]);

  return null;
}

describe('GraphEditor canvas analysis sync bridge', () => {
  const fileId = 'graph-sync-test';

  beforeEach(async () => {
    cleanup();
    await db.files.clear();
    (fileRegistry as any).files.clear();
    (fileRegistry as any).listeners.clear();
    (fileRegistry as any).updatingFiles.clear();
    (fileRegistry as any).pendingUpdates.clear();
  });

  it('should reject a stale file echo from an older store revision', async () => {
    const initial = makeGraph('current');
    const file: FileState<GraphData> = {
      fileId,
      type: 'graph',
      data: initial,
      originalData: structuredClone(initial),
      isDirty: false,
      viewTabs: [],
      lastModified: Date.now(),
    };
    await fileRegistry.registerFile(fileId, file as any);

    const store = createGraphStore();
    render(
      <GraphStoreContext.Provider value={store}>
        <SyncHarness fileId={fileId} />
      </GraphStoreContext.Provider>,
    );

    await waitFor(() => {
      expect(store.getState().graph).toBeTruthy();
    });

    // First edit: rename to Currentsdfd
    const v1 = structuredClone(store.getState().graph!) as any;
    v1.canvasAnalyses[0].recipe.scenarios[0].name = 'Currentsdfd';
    store.getState().setGraph(v1);

    await waitFor(() => {
      expect(store.getState().graphRevision).toBeGreaterThan(1);
    });
    const rev1 = store.getState().graphRevision;

    // Second edit: rename to currenta
    const v2 = structuredClone(store.getState().graph!) as any;
    v2.canvasAnalyses[0].recipe.scenarios[0].name = 'currenta';
    store.getState().setGraph(v2);

    await waitFor(() => {
      expect((store.getState().graph as any).canvasAnalyses[0].recipe.scenarios[0].name).toBe('currenta');
    });
    const rev2 = store.getState().graphRevision;
    expect(rev2).toBeGreaterThan(rev1);

    // Simulate stale callback carrying older store-written content
    await fileRegistry.updateFile(fileId, v1, { syncRevision: rev1, syncOrigin: 'store' });

    await new Promise((r) => setTimeout(r, 50));

    expect((store.getState().graph as any).canvasAnalyses[0].recipe.scenarios[0].name).toBe('currenta');
  });
});
