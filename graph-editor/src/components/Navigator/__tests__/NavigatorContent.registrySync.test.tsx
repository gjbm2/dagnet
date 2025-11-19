/**
 * NavigatorContent registry sync tests
 *
 * Focus:
 * - NavigatorContent triggers registryService loads on mount
 * - It refreshes registry items when dagnet:fileDirtyChanged fires
 * - Rendered output reflects registry items for all object types
 *
 * @vitest-environment happy-dom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

// ---- Mocks -----------------------------------------------------------------

vi.mock('../../../services/registryService', () => {
  const getParameters = vi.fn();
  const getContexts = vi.fn();
  const getCases = vi.fn();
  const getNodes = vi.fn();
  const getEvents = vi.fn();

  return {
    registryService: {
      getParameters,
      getContexts,
      getCases,
      getNodes,
      getEvents,
    },
    // Re-export the fns so tests can access them via import.meta.vitest.mocked
    __mocks: { getParameters, getContexts, getCases, getNodes, getEvents },
  };
});

vi.mock('../../../contexts/NavigatorContext', () => ({
  useNavigatorContext: () => ({
    state: {
      isOpen: true,
      isPinned: true,
      searchQuery: '',
      selectedRepo: 'test-repo',
      selectedBranch: 'main',
      expandedSections: [
        'graphs',
        'parameters',
        'contexts',
        'cases',
        'nodes',
        'events',
      ],
      availableRepos: [],
      availableBranches: [],
      viewMode: 'all',
      showLocalOnly: false,
      showDirtyOnly: false,
      showOpenOnly: false,
      sortBy: 'name',
      groupBySubCategories: false,
      groupByTags: false,
      registryIndexes: {},
    },
    operations: {
      toggleNavigator: vi.fn(),
      togglePin: vi.fn(),
      setSearchQuery: vi.fn(),
      selectRepository: vi.fn(),
      selectBranch: vi.fn(),
      expandSection: vi.fn(),
      collapseSection: vi.fn(),
      setViewMode: vi.fn(),
      setShowLocalOnly: vi.fn(),
      setShowDirtyOnly: vi.fn(),
      setShowOpenOnly: vi.fn(),
      setSortBy: vi.fn(),
      setGroupBySubCategories: vi.fn(),
      setGroupByTags: vi.fn(),
      reloadCredentials: vi.fn(),
      refreshItems: vi.fn(),
      forceFullReload: vi.fn(),
    },
    items: [],
    isLoading: false,
  }),
}));

vi.mock('../../../contexts/TabContext', () => ({
  useTabContext: () => ({
    tabs: [{ id: 'tab-1', fileId: 'event-signup', viewMode: 'interactive' }],
    activeTabId: 'tab-1',
    operations: {
      switchTab: vi.fn(),
      openTab: vi.fn(),
    },
  }),
  useFileRegistry: () => ({
    getFile: vi.fn(),
  }),
}));

// ---- Import component under test AFTER mocks --------------------------------

import { NavigatorContent } from '../NavigatorContent';
import { registryService as mockedRegistryService } from '../../../services/registryService';

// ---- Tests ------------------------------------------------------------------

describe('NavigatorContent registry synchronization', () => {
  beforeEach(() => {
    vi.restoreAllMocks();

    // Default mock results: one item per type
    (mockedRegistryService as any).getParameters.mockResolvedValue([
      {
        id: 'p1',
        type: 'parameter',
        name: 'p1',
        hasFile: true,
        isLocal: true,
        isDirty: false,
        isOpen: false,
        inIndex: true,
        isOrphan: false,
      },
    ]);
    (mockedRegistryService as any).getContexts.mockResolvedValue([]);
    (mockedRegistryService as any).getCases.mockResolvedValue([]);
    (mockedRegistryService as any).getNodes.mockResolvedValue([]);
    (mockedRegistryService as any).getEvents.mockResolvedValue([
      {
        id: 'signup',
        type: 'event',
        name: 'signup',
        hasFile: true,
        isLocal: true,
        isDirty: false,
        isOpen: true,
        inIndex: true,
        isOrphan: false,
      },
    ]);
  });

  it('loads registry items on mount', async () => {
    render(<NavigatorContent />);

    await waitFor(() => {
      expect((mockedRegistryService as any).getParameters).toHaveBeenCalledTimes(1);
      expect((mockedRegistryService as any).getEvents).toHaveBeenCalledTimes(1);
    });

    // Check that event item from registry is rendered in the Events section
    expect(await screen.findByText('signup')).toBeDefined();
  });

  it('refreshes registry items when file dirty state changes', async () => {
    render(<NavigatorContent />);

    // Initial load on mount
    await waitFor(() => {
      expect((mockedRegistryService as any).getEvents).toHaveBeenCalledTimes(1);
    });

    // Simulate a dirty-state change anywhere in the workspace
    window.dispatchEvent(
      new CustomEvent('dagnet:fileDirtyChanged', {
        detail: { fileId: 'event-signup', isDirty: true },
      })
    );

    // NavigatorContent should call registryService getters again
    await waitFor(
      () =>
        expect((mockedRegistryService as any).getEvents).toHaveBeenCalledTimes(
          2
        ),
      { timeout: 1000 }
    );
  });
});


