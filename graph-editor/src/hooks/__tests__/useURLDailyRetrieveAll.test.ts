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
  toArray: vi.fn(),
}));

vi.mock('../../db/appDatabase', () => ({
  db: {
    files: {
      where: vi.fn(() => ({
        equals: vi.fn(() => ({
          toArray: hoisted.toArray,
        })),
      })),
    },
  },
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
    getEntries: vi.fn(() => []),
  },
}));

vi.mock('../../services/automationLogService', () => ({
  automationLogService: {
    persistRunLog: vi.fn(async () => {}),
  },
}));

vi.mock('../../version', () => ({
  APP_VERSION: '0.0.0-test',
}));

vi.mock('../../services/dailyRetrieveAllAutomationService', () => ({
  dailyRetrieveAllAutomationService: {
    run: hoisted.run,
  },
}));

vi.mock('../../services/repositoryOperationsService', () => ({
  repositoryOperationsService: {
    pullLatestRemoteWins: vi.fn(async () => ({ success: true, conflictsResolved: 0 })),
  },
}));

vi.mock('../../services/workspaceService', () => ({
  workspaceService: {
    loadWorkspaceFromIDB: vi.fn(async () => ({})),
  },
}));

import { resetURLDailyRetrieveAllQueueProcessed, useURLDailyRetrieveAllQueue } from '../useURLDailyRetrieveAllQueue';
import { automationRunService } from '../../services/automationRunService';

describe('useURLDailyRetrieveAllQueue', () => {
  beforeEach(() => {
    hoisted.run.mockReset();
    hoisted.getFile.mockReset();
    hoisted.openTab.mockReset();
    hoisted.updateTabData.mockReset();
    hoisted.openLogTab.mockClear();
    hoisted.toArray.mockReset();
    hoisted.navState = { selectedRepo: 'repo-1', selectedBranch: 'main' };
    resetURLDailyRetrieveAllQueueProcessed();

    // Start each test with a clean URL.
    window.history.replaceState({}, document.title, '/');

    hoisted.getFile.mockReturnValue({
      type: 'graph',
      data: { edges: [], nodes: [], dataInterestsDSL: 'context(channel:google)' },
    });
  });

  // Make tests robust if a failure leaves automation state active.
  // (automationRunService ignores finish() when runId mismatches.)
  const forceFinishIfNeeded = () => {
    const st = automationRunService.getState();
    if (st.phase !== 'idle' && st.runId) automationRunService.finish(st.runId);
  };

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
    forceFinishIfNeeded();
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
    forceFinishIfNeeded();
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
    forceFinishIfNeeded();
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
    forceFinishIfNeeded();
  });

  it('enumeration mode (?retrieveall with no value) completes and returns automation state to idle', async () => {
    window.history.replaceState({}, document.title, '/?retrieveall');

    // One dailyFetch-enabled graph in the selected repo/branch.
    hoisted.toArray.mockResolvedValue([
      {
        fileId: 'graph-enabled',
        type: 'graph',
        source: { repository: 'repo-1', branch: 'main' },
        data: { edges: [], nodes: [], dailyFetch: true, metadata: { created: '1-Jan-25', modified: '1-Jan-25' } },
      },
      {
        fileId: 'graph-disabled',
        type: 'graph',
        source: { repository: 'repo-1', branch: 'main' },
        data: { edges: [], nodes: [], dailyFetch: false, metadata: { created: '1-Jan-25', modified: '1-Jan-25' } },
      },
    ]);

    renderHook(() => useURLDailyRetrieveAllQueue());

    await waitFor(() => {
      expect(hoisted.run).toHaveBeenCalledTimes(1);
    });

    await waitFor(() => {
      expect(window.location.search).toBe('');
    });

    await waitFor(() => {
      expect(automationRunService.getState().phase).toBe('idle');
    });
  });
});


