/**
 * @vitest-environment happy-dom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const hoisted = vi.hoisted(() => ({
  run: vi.fn(),
  getFile: vi.fn(),
  openTab: vi.fn(),
  updateTabData: vi.fn(),
  openLogTab: vi.fn(async () => 'session-log-tab-1'),
  navState: { selectedRepo: 'repo-1', selectedBranch: 'main' as string },
}));

vi.mock('../../contexts/NavigatorContext', () => ({
  useNavigatorContext: () => ({
    state: hoisted.navState,
    operations: {},
  }),
}));

vi.mock('../../contexts/TabContext', () => ({
  useTabContext: () => ({
    tabs: [],
    activeTabId: null,
    operations: { openTab: hoisted.openTab, updateTabData: hoisted.updateTabData },
  }),
  fileRegistry: { getFile: hoisted.getFile },
}));

vi.mock('../../services/sessionLogService', () => ({
  sessionLogService: {
    openLogTab: hoisted.openLogTab,
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock('../../services/dailyRetrieveAllAutomationService', () => ({
  dailyRetrieveAllAutomationService: {
    run: hoisted.run,
  },
}));

import { resetURLDailyRetrieveAllQueueProcessed, useURLDailyRetrieveAllQueue } from '../useURLDailyRetrieveAllQueue';

describe('useURLDailyRetrieveAllQueue', () => {
  beforeEach(() => {
    hoisted.run.mockReset();
    hoisted.getFile.mockReset();
    hoisted.openTab.mockReset();
    hoisted.updateTabData.mockReset();
    hoisted.openLogTab.mockClear();
    hoisted.navState = { selectedRepo: 'repo-1', selectedBranch: 'main' };
    resetURLDailyRetrieveAllQueueProcessed();

    // Start each test with a clean URL.
    window.history.replaceState({}, document.title, '/');

    hoisted.getFile.mockReturnValue({
      type: 'graph',
      data: { edges: [], nodes: [], dataInterestsDSL: 'context(channel:google)' },
    });
  });

  it('runs daily automation once for ?retrieveall=<graph>, then cleans URL params', async () => {
    window.history.replaceState({}, document.title, '/?retrieveall=my-graph');

    renderHook(() => useURLDailyRetrieveAllQueue());

    await waitFor(() => {
      expect(hoisted.run).toHaveBeenCalledTimes(1);
    });

    expect(hoisted.openLogTab).toHaveBeenCalled();

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

  it('serialises multiple graphs in one run (comma-separated)', async () => {
    window.history.replaceState({}, document.title, '/?retrieveall=a,b,c');

    renderHook(() => useURLDailyRetrieveAllQueue());

    await waitFor(() => {
      expect(hoisted.run).toHaveBeenCalledTimes(3);
    });

    expect(hoisted.run.mock.calls.map((c) => c[0]?.graphFileId)).toEqual(['graph-a', 'graph-b', 'graph-c']);

    await waitFor(() => {
      expect(window.location.search).toBe('');
    });
  });

  it('serialises multiple graphs in one run (repeated params) and de-dupes', async () => {
    window.history.replaceState({}, document.title, '/?retrieveall=a&retrieveall=a&retrieveall=b');

    renderHook(() => useURLDailyRetrieveAllQueue());

    await waitFor(() => {
      expect(hoisted.run).toHaveBeenCalledTimes(2);
    });

    expect(hoisted.run.mock.calls.map((c) => c[0]?.graphFileId)).toEqual(['graph-a', 'graph-b']);

    await waitFor(() => {
      expect(window.location.search).toBe('');
    });
  });

  it('does not get stuck if repo becomes selected after mount (scheduler-style init)', async () => {
    vi.useFakeTimers();
    hoisted.navState = { selectedRepo: '', selectedBranch: '' };
    window.history.replaceState({}, document.title, '/?retrieveall=my-graph');

    const { rerender } = renderHook(() => useURLDailyRetrieveAllQueue());

    // Give the waiting loop a chance to start; should not run without a repo.
    await vi.advanceTimersByTimeAsync(500);
    expect(hoisted.run).toHaveBeenCalledTimes(0);

    // Repo becomes selected later (e.g. NavigatorContext finishes initialising).
    hoisted.navState = { selectedRepo: 'repo-1', selectedBranch: 'main' };
    rerender();

    // Drive the internal polling loop (sleep(250ms)) until automation starts.
    // Avoid waitFor here because we're under fake timers.
    for (let i = 0; i < 20; i++) {
      if (hoisted.run.mock.calls.length > 0) break;
      await vi.advanceTimersByTimeAsync(250);
      await Promise.resolve();
      await Promise.resolve();
    }

    expect(hoisted.run).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});


