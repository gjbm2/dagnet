import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';

let currentGraph: any | undefined = {
  nodes: [],
  edges: [],
  metadata: {},
};

vi.mock('../../contexts/GraphStoreContext', () => {
  return {
    useGraphStore: () => ({
      graph: currentGraph,
      setGraph: vi.fn(),
      saveHistoryState: vi.fn(),
      currentDSL: '',
    }),
  };
});

vi.mock('../../contexts/TabContext', () => {
  return {
    useTabContext: () => ({
      tabs: [],
      operations: {
        updateTabState: vi.fn(),
        switchTab: vi.fn(),
      },
    }),
    fileRegistry: {
      getFile: vi.fn(),
    },
  };
});

vi.mock('../../hooks/useSnapToSlider', () => {
  return {
    useSnapToSlider: () => ({
      snapValue: (v: number) => v,
      shouldAutoRebalance: false,
      scheduleRebalance: vi.fn(),
      handleMouseDown: vi.fn(),
    }),
  };
});

vi.mock('../../hooks/useFetchData', () => {
  return {
    useFetchData: () => ({ fetchItem: vi.fn() }),
    createFetchItem: vi.fn(),
  };
});

vi.mock('../../contexts/DialogContext', () => {
  return {
    useDialog: () => ({
      showConfirm: vi.fn(async () => true),
    }),
  };
});

import PropertiesPanel from '../PropertiesPanel';

describe('PropertiesPanel hooks safety', () => {
  it('does not crash if graph becomes undefined between renders', () => {
    currentGraph = { nodes: [], edges: [], metadata: {} };
    const rendered = render(
      <PropertiesPanel
        selectedNodeId={null}
        onSelectedNodeChange={() => {}}
        selectedEdgeId={null}
        onSelectedEdgeChange={() => {}}
      />
    );

    currentGraph = undefined;

    expect(() => {
      rendered.rerender(
        <PropertiesPanel
          selectedNodeId={null}
          onSelectedNodeChange={() => {}}
          selectedEdgeId={null}
          onSelectedEdgeChange={() => {}}
        />
      );
    }).not.toThrow();
  });
});


