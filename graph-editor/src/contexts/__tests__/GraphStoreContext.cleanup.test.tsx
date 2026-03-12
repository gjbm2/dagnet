import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';

// Mock TabContext + fileRegistry used by GraphStoreProvider side-effects.
vi.mock('../TabContext', () => {
  return {
    useTabContext: () => ({
      tabs: [],
      operations: {
        updateTabState: vi.fn(),
      },
    }),
    fileRegistry: {
      updateFile: vi.fn(async () => {}),
    },
  };
});

import { GraphStoreProvider, getGraphStore, useGraphStore, useGraphStoreApi } from '../GraphStoreContext';

function Harness({ fileId }: { fileId: string }) {
  return (
    <GraphStoreProvider fileId={fileId}>
      <div>child</div>
    </GraphStoreProvider>
  );
}

describe('GraphStoreProvider cleanup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not wipe the store if a new provider instance mounts within the grace period', () => {
    const fileId = 'graph-test-cleanup';

    const first = render(<Harness fileId={fileId} />);
    const store1 = getGraphStore(fileId);
    expect(store1).toBeTruthy();

    // Put some data in the store to detect accidental cleanup.
    store1!.setState({ graph: { nodes: [{ uuid: 'n1' }], edges: [{ uuid: 'e1' }] } as any });
    expect(store1!.getState().graph?.edges?.length).toBe(1);

    // Unmount old provider, then mount a new provider instance quickly.
    first.unmount();

    // Mount within the 1s grace period.
    const second = render(<Harness fileId={fileId} />);
    const store2 = getGraphStore(fileId);
    expect(store2).toBeTruthy();

    // Advance past grace period; old timer must NOT wipe the store used by the new provider.
    vi.advanceTimersByTime(1500);

    expect(getGraphStore(fileId)).toBeTruthy();
    expect(store2!.getState().graph?.edges?.length).toBe(1);

    second.unmount();
  });

  it('cleans up the store after the grace period if no instances remain', () => {
    const fileId = 'graph-test-cleanup-final';

    const mounted = render(<Harness fileId={fileId} />);
    const store = getGraphStore(fileId);
    expect(store).toBeTruthy();

    store!.setState({ graph: { nodes: [{ uuid: 'n1' }], edges: [{ uuid: 'e1' }] } as any });
    mounted.unmount();

    // After grace period, the store should be removed.
    vi.advanceTimersByTime(1500);
    expect(getGraphStore(fileId)).toBeNull();
  });
});

/**
 * Regression: useGraphStoreApi must return a working store handle with
 * .getState() and .subscribe(), even when useGraphStore(selector) does not.
 *
 * Bug: CanvasAnalysisNode used useGraphStore(s => s.currentDSL) and cast the
 * return as a store handle. Since useGraphStore with a selector returns only
 * the selected value (a string), .getState() was undefined and resolveAnalysisType
 * was never called — available analyses stayed empty.
 */
describe('useGraphStoreApi returns imperative store handle', () => {
  let capturedApi: any = null;
  let capturedSelectorResult: any = null;

  function ApiConsumer() {
    capturedApi = useGraphStoreApi();
    capturedSelectorResult = useGraphStore(s => s.currentDSL);
    return <div>consumer</div>;
  }

  it('should provide .getState() and .subscribe() on the API handle', () => {
    const fileId = 'graph-test-api-handle';
    const { unmount } = render(
      <GraphStoreProvider fileId={fileId}>
        <ApiConsumer />
      </GraphStoreProvider>
    );

    // useGraphStoreApi returns a store with imperative methods
    expect(typeof capturedApi.getState).toBe('function');
    expect(typeof capturedApi.subscribe).toBe('function');

    // .getState() returns the full store state including graph
    const state = capturedApi.getState();
    expect(state).toHaveProperty('graph');
    expect(state).toHaveProperty('graphRevision');

    unmount();
  });

  it('should allow imperative graph reads for resolveAnalysisType', () => {
    const fileId = 'graph-test-api-reads';
    const { unmount } = render(
      <GraphStoreProvider fileId={fileId}>
        <ApiConsumer />
      </GraphStoreProvider>
    );

    // Seed graph via the external store handle
    const externalStore = getGraphStore(fileId)!;
    externalStore.setState({
      graph: {
        nodes: [{ uuid: 'n1', id: 'start', entry: { is_start: true } }],
        edges: [],
      } as any,
    });

    // useGraphStoreApi handle reads the same state
    const graph = capturedApi.getState().graph;
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0].id).toBe('start');

    unmount();
  });

  it('should confirm useGraphStore(selector) does NOT carry store methods', () => {
    const fileId = 'graph-test-selector-no-methods';
    const { unmount } = render(
      <GraphStoreProvider fileId={fileId}>
        <ApiConsumer />
      </GraphStoreProvider>
    );

    // useGraphStore with selector returns just the value — no .getState()
    // This documents the behaviour that caused the original bug
    expect((capturedSelectorResult as any)?.getState).toBeUndefined();

    unmount();
  });
});
