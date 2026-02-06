import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';

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
    useGraphStoreOptional: () => ({
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
      subscribe: vi.fn(() => () => {}),
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

vi.mock('../../contexts/ValidationContext', () => {
  return {
    useValidationMode: () => ({ mode: 'none' }),
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
      state: {
        selectedRepo: 'r',
        selectedBranch: 'b',
      },
      operations: {
        refreshItems: vi.fn(),
      },
    }),
  };
});

import PropertiesPanel from '../PropertiesPanel';
import PropertiesPanelWrapper from '../panels/PropertiesPanelWrapper';

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

// -----------------------------------------------------------------------------
// PropertiesPanelWrapper snapshots badge
// -----------------------------------------------------------------------------

vi.mock('../editors/GraphEditor', () => ({
  useSelectionContext: () => ({
    selectedNodeId: null,
    selectedEdgeId: 'e-1',
    onSelectedNodeChange: vi.fn(),
    onSelectedEdgeChange: vi.fn(),
  }),
}));

vi.mock('../../hooks/useRemoveOverrides', () => ({
  useRemoveOverrides: () => ({ hasOverrides: false, removeOverrides: vi.fn() }),
}));

vi.mock('../../hooks/useSnapshotsMenu', () => ({
  useSnapshotsMenu: () => ({
    inventories: {
      'param-1': {
        has_data: true,
        param_id: 'r-b-param-1',
        earliest: '2025-12-01T12:00:00Z',
        latest: '2025-12-10T12:00:00Z',
        row_count: 10,
        unique_days: 10,
        unique_slices: 1,
        unique_hashes: 1,
        unique_retrievals: 2,
      },
    },
    snapshotCounts: { 'param-1': 2 },
    isDeleting: false,
    isDownloading: false,
    refresh: vi.fn(async () => {}),
    deleteSnapshots: vi.fn(async () => true),
    deleteSnapshotsMany: vi.fn(async () => true),
    downloadSnapshotData: vi.fn(async () => true),
    downloadSnapshotDataMany: vi.fn(async () => true),
  }),
}));

describe('PropertiesPanelWrapper snapshots badge', () => {
  it('shows a camera badge with tooltip and a menu including download/delete all', () => {
    currentGraph = {
      nodes: [],
      edges: [
        { uuid: 'e-1', from: 'A', to: 'B', p: { id: 'param-1' } },
      ],
      metadata: {},
    };

    const rendered = render(<PropertiesPanelWrapper tabId="t" />);

    // Badge tooltip should include date range (retrieved_at dates).
    const badge = rendered.container.querySelector('.properties-panel-header-badges .properties-panel-badge[title*="Snapshots (retrieved)"]');
    expect(badge).toBeTruthy();
    expect(badge!.getAttribute('title') || '').toContain('1-Dec-25 — 10-Dec-25');

    // Open menu
    act(() => {
      fireEvent.pointerDown(badge!);
    });

    // Radix DropdownMenu renders via a portal; assert menu content appears.
    expect(document.body.textContent || '').toContain('param-1');
    expect(document.body.textContent || '').toContain('Download all');
    expect(document.body.textContent || '').toContain('Delete all');
  });
});


