/**
 * @vitest-environment happy-dom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const hoisted = vi.hoisted(() => ({
  run: vi.fn(),
  getFile: vi.fn(),
  updateTabData: vi.fn(),
}));

vi.mock('../../contexts/NavigatorContext', () => ({
  useNavigatorContext: () => ({
    state: { selectedRepo: 'repo-1', selectedBranch: 'main' },
    operations: {},
  }),
}));

vi.mock('../../contexts/TabContext', () => ({
  useTabContext: () => ({
    operations: { updateTabData: hoisted.updateTabData },
  }),
  useFileRegistry: () => ({ getFile: hoisted.getFile }),
}));

vi.mock('../../services/dailyRetrieveAllAutomationService', () => ({
  dailyRetrieveAllAutomationService: {
    run: hoisted.run,
  },
}));

import { resetURLDailyRetrieveAllProcessed, useURLDailyRetrieveAll } from '../useURLDailyRetrieveAll';

describe('useURLDailyRetrieveAll', () => {
  beforeEach(() => {
    hoisted.run.mockReset();
    hoisted.getFile.mockReset();
    hoisted.updateTabData.mockReset();
    resetURLDailyRetrieveAllProcessed();

    // Start each test with a clean URL.
    window.history.replaceState({}, document.title, '/');

    hoisted.getFile.mockReturnValue({
      type: 'graph',
      data: { edges: [], nodes: [], dataInterestsDSL: 'context(channel:google)' },
    });
  });

  it('runs daily automation once when ?retrieveall=<graph> matches the loaded graph tab, then cleans URL params', async () => {
    window.history.replaceState({}, document.title, '/?retrieveall=my-graph');

    renderHook(() => useURLDailyRetrieveAll(true, 'graph-my-graph'));

    await waitFor(() => {
      expect(hoisted.run).toHaveBeenCalledTimes(1);
    });

    expect(hoisted.run).toHaveBeenCalledWith(
      expect.objectContaining({
        repository: 'repo-1',
        branch: 'main',
        graphFileId: 'graph-my-graph',
      })
    );

    // The hook cleans params in finally.
    await waitFor(() => {
      expect(window.location.search).toBe('');
    });
  });

  it('does not run on non-matching graph tabs', async () => {
    window.history.replaceState({}, document.title, '/?retrieveall=my-graph');

    renderHook(() => useURLDailyRetrieveAll(true, 'graph-other-graph'));

    // Allow effects to flush.
    await new Promise((r) => setTimeout(r, 0));
    expect(hoisted.run).toHaveBeenCalledTimes(0);
  });
});


