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

import { GraphStoreProvider, getGraphStore } from '../GraphStoreContext';

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


