import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';

// NOTE: `vi.mock` calls are hoisted. Use `vi.hoisted` so mocks can safely reference these values.
const updateGraphMock = vi.hoisted(() => vi.fn(async () => {}));
const initialGraph = vi.hoisted(() => ({
  nodes: [{ uuid: 'n1', id: 'n1', type: 'start' }, { uuid: 'n2', id: 'n2', type: 'conversion' }],
  edges: [
    {
      uuid: 'e1',
      id: 'edge-1',
      from: 'n1',
      to: 'n2',
      p: {
        mean: 0.5,
        latency: {
          latency_parameter: false,
        },
      },
    },
  ],
  metadata: {},
}));

vi.mock('../../contexts/GraphStoreContext', () => {
  const store = {
    graph: initialGraph,
    setGraph: vi.fn(),
    saveHistoryState: vi.fn(),
    currentDSL: '',
  };
  return {
    useGraphStore: () => store,
    useGraphStoreOptional: () => store,
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

vi.mock('../../contexts/NavigatorContext', () => {
  return {
    useNavigatorContext: () => ({
      state: {},
      operations: {},
      items: [],
      isLoading: false,
    }),
  };
});

vi.mock('../../contexts/ValidationContext', () => {
  return {
    useValidationMode: () => ({
      mode: 'off',
      setMode: vi.fn(),
    }),
  };
});

vi.mock('../../services/graphMutationService', () => {
  return {
    graphMutationService: {
      updateGraph: updateGraphMock,
    },
  };
});

// PropertiesPanel renders QueryExpressionEditor which pulls in a lot of app context.
// For this unit test we only care about the latency toggle wiring, so stub it.
vi.mock('../QueryExpressionEditor', () => {
  return {
    QueryExpressionEditor: () => null,
  };
});

import PropertiesPanel from '../PropertiesPanel';

describe('PropertiesPanel edge params', () => {
  it('routes Latency Tracking toggle through graphMutationService.updateGraph', async () => {
    updateGraphMock.mockClear();

    const { getByLabelText } = render(
      <PropertiesPanel
        selectedNodeId={null}
        onSelectedNodeChange={() => {}}
        selectedEdgeId="e1"
        onSelectedEdgeChange={() => {}}
      />
    );

    const checkbox = getByLabelText('Latency Tracking') as HTMLInputElement;
    expect(checkbox.checked).toBe(false);

    fireEvent.click(checkbox);

    await waitFor(() => {
      expect(updateGraphMock).toHaveBeenCalledTimes(1);
    });

    const [, newGraph] = updateGraphMock.mock.calls[0];
    const updatedEdge = newGraph.edges.find((e: any) => e.uuid === 'e1');
    expect(updatedEdge.p.latency.latency_parameter).toBe(true);
  });
});


