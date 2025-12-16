import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

import { TabProvider, useTabContext } from '../TabContext';

// TabProvider initialisation can attempt to fetch local assets/services in dev.
// In unit tests, stub fetch to avoid noisy ECONNREFUSED errors.
globalThis.fetch = vi.fn(async () => ({
  ok: true,
  status: 200,
  headers: { get: () => 'application/json' },
  json: async () => ({}),
  text: async () => '',
})) as any;

vi.mock('../GraphStoreContext', () => ({
  useGraphStore: () => ({
    getState: () => ({ graph: null }),
    subscribe: () => () => undefined,
  }),
}));

vi.mock('../DialogContext', () => ({
  useDialog: () => ({
    showConfirm: vi.fn(async () => true),
    showPrompt: vi.fn(async () => ({ confirmed: false, value: '' })),
    showAlert: vi.fn(async () => undefined),
    showChoice: vi.fn(async () => ({ choice: null })),
  }),
}));

vi.mock('../../db/appDatabase', () => {
  const seededTab = {
    id: 'tab-1',
    fileId: 'graph-test',
    viewMode: 'interactive',
    title: 'test',
    icon: 'graph',
    closable: true,
    group: 'main-content',
    editorState: {
      scenarioState: {
        scenarioOrder: ['scenario-1', 'current'],
        visibleScenarioIds: ['scenario-1', 'current'],
        visibleColourOrderIds: ['scenario-1', 'current'],
        visibilityMode: {
          current: 'f',
          'scenario-1': 'e',
        },
      },
    },
  };

  const noOp = async () => undefined;
  const tabsTable = {
    toArray: async () => [seededTab],
    update: async () => 1,
    add: async () => undefined,
    delete: async () => undefined,
    where: () => ({ equals: () => ({ toArray: async () => [] }) }),
  };

  const filesTable = {
    toArray: async () => [],
    put: async () => undefined,
    get: async () => undefined,
    add: async () => undefined,
  };

  return {
    db: {
      tabs: tabsTable,
      files: filesTable,
      getAppState: async () => ({ activeTabId: 'tab-1' }),
      saveAppState: noOp,
    },
  };
});

describe('TabContext: visibilityMode persists across hide/show', () => {
  it('does not overwrite an existing scenario visibilityMode when toggling visibility', async () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <TabProvider>{children}</TabProvider>
    );

    const { result } = renderHook(() => useTabContext(), { wrapper });

    // Wait for TabProvider to load seeded tabs from mocked IndexedDB
    await waitFor(() => {
      expect(result.current.tabs.length).toBeGreaterThan(0);
      expect(result.current.activeTabId).toBe('tab-1');
    });

    // Hide then show scenario-1
    await act(async () => {
      await result.current.operations.toggleScenarioVisibility('tab-1', 'scenario-1');
      await result.current.operations.toggleScenarioVisibility('tab-1', 'scenario-1');
    });

    // Mode should remain 'e' (not copied from current='f')
    const mode = result.current.operations.getScenarioVisibilityMode('tab-1', 'scenario-1');
    expect(mode).toBe('e');
  });
});


