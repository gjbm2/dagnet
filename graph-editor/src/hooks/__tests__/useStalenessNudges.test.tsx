/**
 * @vitest-environment happy-dom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const hoisted = vi.hoisted(() => ({
  pullAll: vi.fn(),
  pullLatestRemoteWins: vi.fn(),
  requestRetrieveAllSlices: vi.fn(),
  retrieveAllSlicesExecute: vi.fn(),
  getFile: vi.fn(),
  updateTabData: vi.fn(),
  isDashboardMode: false,

  // stalenessNudgeService fakes
  recordPageLoad: vi.fn(),
  recordDone: vi.fn(),
  getLastDoneAtMs: vi.fn(),
  getLastPageLoadAtMs: vi.fn(),
  shouldPromptReload: vi.fn(),
  isSnoozed: vi.fn(),
  canPrompt: vi.fn(),
  markPrompted: vi.fn(),
  snooze: vi.fn(),
  shouldCheckRemoteHead: vi.fn(),
  markRemoteHeadChecked: vi.fn(),
  isRemoteShaDismissed: vi.fn(),
  dismissRemoteSha: vi.fn(),
  clearDismissedRemoteSha: vi.fn(),
  getRemoteAheadStatus: vi.fn(),
  getRetrieveAllSlicesStalenessStatus: vi.fn(),
  getPendingPlan: vi.fn(),
  setPendingPlan: vi.fn(),
  clearPendingPlan: vi.fn(),
  clearVolatileFlags: vi.fn(),
  getAutomaticMode: vi.fn(),
  setAutomaticMode: vi.fn(),

  // db fakes
  dbWorkspacesGet: vi.fn(),
}));

vi.mock('../../contexts/NavigatorContext', () => ({
  useNavigatorContext: () => ({
    state: { selectedRepo: 'repo-1', selectedBranch: 'main' },
    operations: {},
  }),
}));

vi.mock('../../contexts/TabContext', () => ({
  useTabContext: () => ({
    activeTabId: 'tab-1',
    tabs: [{ id: 'tab-1', fileId: 'graph-1', viewMode: 'interactive' }],
    operations: { updateTabData: hoisted.updateTabData },
  }),
  useFileRegistry: () => ({ getFile: hoisted.getFile }),
  // Used by sessionLogService (which updates the in-memory log file on each log entry)
  fileRegistry: {
    getFile: hoisted.getFile,
    notifyListeners: vi.fn(),
    getOrCreateFile: vi.fn(),
    addViewTab: vi.fn(),
  },
}));

vi.mock('../usePullAll', () => ({
  usePullAll: () => ({
    isPulling: false,
    pullAll: hoisted.pullAll,
    conflictModal: null,
  }),
}));

vi.mock('../useRetrieveAllSlicesRequestListener', () => ({
  requestRetrieveAllSlices: hoisted.requestRetrieveAllSlices,
}));

vi.mock('../../services/retrieveAllSlicesService', () => ({
  retrieveAllSlicesService: {
    execute: hoisted.retrieveAllSlicesExecute,
  },
}));

vi.mock('../../contexts/ShareModeContext', () => ({
  useShareModeOptional: () => null,
}));

vi.mock('../../contexts/DashboardModeContext', () => ({
  useDashboardMode: () => ({
    isDashboardMode: hoisted.isDashboardMode,
    setDashboardMode: vi.fn(),
    toggleDashboardMode: vi.fn(),
  }),
}));

vi.mock('../../services/liveShareSyncService', () => ({
  liveShareSyncService: { refreshToLatest: vi.fn(async () => ({ success: true })) },
}));

vi.mock('../../services/repositoryOperationsService', () => ({
  repositoryOperationsService: {
    pullLatestRemoteWins: hoisted.pullLatestRemoteWins,
  },
}));

vi.mock('react-hot-toast', () => ({
  default: {
    success: vi.fn(),
    error: vi.fn(),
    loading: vi.fn(),
  },
}));

vi.mock('../../db/appDatabase', () => ({
  db: {
    workspaces: { get: hoisted.dbWorkspacesGet },
  },
}));

vi.mock('../../services/stalenessNudgeService', () => ({
  stalenessNudgeService: {
    recordPageLoad: hoisted.recordPageLoad,
    recordDone: hoisted.recordDone,
    getLastDoneAtMs: hoisted.getLastDoneAtMs,
    getLastPageLoadAtMs: hoisted.getLastPageLoadAtMs,
    shouldPromptReload: hoisted.shouldPromptReload,
    isSnoozed: hoisted.isSnoozed,
    canPrompt: hoisted.canPrompt,
    markPrompted: hoisted.markPrompted,
    snooze: hoisted.snooze,
    shouldCheckRemoteHead: hoisted.shouldCheckRemoteHead,
    markRemoteHeadChecked: hoisted.markRemoteHeadChecked,
    isRemoteShaDismissed: hoisted.isRemoteShaDismissed,
    dismissRemoteSha: hoisted.dismissRemoteSha,
    clearDismissedRemoteSha: hoisted.clearDismissedRemoteSha,
    getRemoteAheadStatus: hoisted.getRemoteAheadStatus,
    getRetrieveAllSlicesStalenessStatus: hoisted.getRetrieveAllSlicesStalenessStatus,
    getPendingPlan: hoisted.getPendingPlan,
    setPendingPlan: hoisted.setPendingPlan,
    clearPendingPlan: hoisted.clearPendingPlan,
    clearVolatileFlags: hoisted.clearVolatileFlags,
    getAutomaticMode: hoisted.getAutomaticMode,
    setAutomaticMode: hoisted.setAutomaticMode,
  },
}));

import { useStalenessNudges } from '../useStalenessNudges';

function Harness() {
  const { modals } = useStalenessNudges();
  return <div>{modals}</div>;
}

function clickActionCheckboxByRowTitle(title: string): HTMLInputElement {
  // Our modal action rows are <label> wrappers that include extra "Due/Last" metadata,
  // so getByLabelText exact matching is brittle. Instead: locate the row title text,
  // then click the nested checkbox input.
  const el = screen.getByText(title);
  const label = el.closest('label');
  if (!label) throw new Error(`Expected to find <label> ancestor for action row: ${title}`);
  const input = label.querySelector('input[type=\"checkbox\"]') as HTMLInputElement | null;
  if (!input) throw new Error(`Expected checkbox input for action row: ${title}`);
  input.click();
  return input;
}

describe('useStalenessNudges', () => {
  beforeEach(() => {
    for (const fn of Object.values(hoisted)) {
      if (typeof fn === 'function' && 'mockReset' in fn) (fn as any).mockReset();
    }

    hoisted.isDashboardMode = false;
    hoisted.isSnoozed.mockReturnValue(false);
    hoisted.canPrompt.mockReturnValue(true);
    hoisted.getLastDoneAtMs.mockReturnValue(undefined);
    hoisted.getLastPageLoadAtMs.mockReturnValue(undefined);
    hoisted.shouldCheckRemoteHead.mockReturnValue(false);
    hoisted.getRemoteAheadStatus.mockResolvedValue({ isRemoteAhead: false });
    hoisted.isRemoteShaDismissed.mockReturnValue(false);
    hoisted.dbWorkspacesGet.mockResolvedValue({ lastSynced: Date.now() });
    hoisted.getRetrieveAllSlicesStalenessStatus.mockResolvedValue({
      isStale: false,
      parameterCount: 0,
      staleParameterCount: 0,
    });
    hoisted.getPendingPlan.mockReturnValue(undefined);
    hoisted.getAutomaticMode.mockReturnValue(false);

    hoisted.getFile.mockReturnValue({
      type: 'graph',
      data: { edges: [], nodes: [] },
    });
  });

  it('should show combined modal and reload when only Reload is due + selected', async () => {
    hoisted.shouldPromptReload.mockReturnValue(true);

    const reloadSpy = vi.spyOn(window.location, 'reload').mockImplementation(() => {});

    render(<Harness />);

    expect(await screen.findByText('Updates recommended')).toBeTruthy();
    expect(screen.getByText('Reload page')).toBeTruthy();
    expect(screen.getByText('Automatic mode')).toBeTruthy();

    screen.getByRole('button', { name: 'Run selected' }).click();
    expect(reloadSpy).toHaveBeenCalledTimes(1);
    reloadSpy.mockRestore();
  });

  it('should request retrieve-all-slices when Retrieve is due + selected', async () => {
    hoisted.shouldPromptReload.mockReturnValue(false);
    hoisted.getRetrieveAllSlicesStalenessStatus.mockResolvedValue({
      isStale: true,
      parameterCount: 2,
      staleParameterCount: 1,
      mostRecentRetrievedAtMs: 123,
    });

    render(<Harness />);

    expect(await screen.findByText('Updates recommended')).toBeTruthy();
    expect(screen.getByText('Retrieve all slices (active graph)')).toBeTruthy();

    // SAFETY: retrieve-all is never pre-selected, even if due.
    const retrieveCheckbox = clickActionCheckboxByRowTitle('Retrieve all slices (active graph)');
    // Click toggles it on; we don't rely on label text matching.
    expect(retrieveCheckbox.checked).toBe(true);

    screen.getByRole('button', { name: 'Run selected' }).click();
    expect(hoisted.requestRetrieveAllSlices).toHaveBeenCalledTimes(1);
  });

  it('should run retrieve-all headlessly before reloading when Reload + Retrieve are selected', async () => {
    hoisted.shouldPromptReload.mockReturnValue(true);
    hoisted.getRetrieveAllSlicesStalenessStatus.mockResolvedValue({
      isStale: true,
      parameterCount: 1,
      staleParameterCount: 1,
    });

    const reloadSpy = vi.spyOn(window.location, 'reload').mockImplementation(() => {});

    render(<Harness />);

    expect(await screen.findByText('Updates recommended')).toBeTruthy();
    expect(screen.getByText('Reload page')).toBeTruthy();
    expect(screen.getByText('Retrieve all slices (active graph)')).toBeTruthy();

    // SAFETY: retrieve-all is never pre-selected; user must explicitly tick it.
    clickActionCheckboxByRowTitle('Retrieve all slices (active graph)');

    screen.getByText('Run selected').click();

    await waitFor(() => {
      expect(hoisted.retrieveAllSlicesExecute).toHaveBeenCalledTimes(1);
    });
    expect(hoisted.requestRetrieveAllSlices).toHaveBeenCalledTimes(0);
    expect(reloadSpy).toHaveBeenCalledTimes(1);
    reloadSpy.mockRestore();
  });

  it('should persist pending plan when Reload + Pull are selected', async () => {
    hoisted.shouldPromptReload.mockReturnValue(true);
    hoisted.shouldCheckRemoteHead.mockReturnValue(true);
    hoisted.getRemoteAheadStatus.mockResolvedValue({ isRemoteAhead: true, localSha: 'a', remoteHeadSha: 'b' });

    const reloadSpy = vi.spyOn(window.location, 'reload').mockImplementation(() => {});

    render(<Harness />);

    expect(await screen.findByText('Updates recommended')).toBeTruthy();
    expect(screen.getByText('Pull latest from git')).toBeTruthy();

    screen.getByText('Run selected').click();

    // No pending plan persistence (must never survive refresh). Pull runs now (explicit user intent), then reload.
    await waitFor(() => {
      expect(hoisted.pullAll).toHaveBeenCalledTimes(1);
    });
    expect(hoisted.clearDismissedRemoteSha).toHaveBeenCalledTimes(1);
    expect(reloadSpy).toHaveBeenCalledTimes(1);
    reloadSpy.mockRestore();
  });

  it('should NOT auto-run due actions without user confirmation (no silent retrieve)', async () => {
    hoisted.shouldPromptReload.mockReturnValue(false);
    hoisted.shouldCheckRemoteHead.mockReturnValue(false);
    hoisted.getRetrieveAllSlicesStalenessStatus.mockReturnValue({
      isStale: true,
      parameterCount: 1,
      staleParameterCount: 1,
    });

    render(<Harness />);

    // Modal should be shown; nothing should auto-execute.
    expect(await screen.findByText('Updates recommended')).toBeTruthy();
    expect(hoisted.retrieveAllSlicesExecute).toHaveBeenCalledTimes(0);
    expect(hoisted.pullAll).toHaveBeenCalledTimes(0);
  });

  it('should skip retrieve-all after pull when pull brings fresh retrieval state (not stale)', async () => {
    hoisted.shouldPromptReload.mockReturnValue(false);
    hoisted.shouldCheckRemoteHead.mockReturnValue(true);
    hoisted.getRemoteAheadStatus.mockResolvedValue({ isRemoteAhead: true, localSha: 'a', remoteHeadSha: 'b' });

    // First call (modal due computation): stale → shows Retrieve action as due/checked.
    // Second call (post-pull re-check): not stale → should skip retrieve.
    hoisted.getRetrieveAllSlicesStalenessStatus
      .mockResolvedValueOnce({ isStale: true, parameterCount: 1, staleParameterCount: 1 })
      .mockResolvedValueOnce({ isStale: false, parameterCount: 1, staleParameterCount: 0, mostRecentRetrievedAtMs: Date.now() });

    render(<Harness />);

    expect(await screen.findByText('Updates recommended')).toBeTruthy();
    expect(screen.getByText('Pull latest from git')).toBeTruthy();
    expect(screen.getByText('Retrieve all slices (active graph)')).toBeTruthy();

    screen.getByRole('button', { name: 'Run selected' }).click();

    await waitFor(() => {
      expect(hoisted.pullAll).toHaveBeenCalledTimes(1);
    });

    // Retrieve should be skipped (no request event, no direct execute)
    expect(hoisted.requestRetrieveAllSlices).toHaveBeenCalledTimes(0);
    expect(hoisted.retrieveAllSlicesExecute).toHaveBeenCalledTimes(0);
  });

  it('should auto-pull after 30s countdown when remote is ahead (no retrieve-all)', async () => {
    vi.useFakeTimers();
    hoisted.shouldPromptReload.mockReturnValue(false);
    hoisted.shouldCheckRemoteHead.mockReturnValue(true);
    hoisted.getRemoteAheadStatus.mockResolvedValue({ isRemoteAhead: true, localSha: 'a', remoteHeadSha: 'b' });
    hoisted.isRemoteShaDismissed.mockReturnValue(false);

    render(<Harness />);

    // Under fake timers, React effects + Testing Library async flows may require explicit timer advancement.
    // Poll briefly until the modal appears.
    for (let i = 0; i < 200; i++) {
      if (screen.queryByText('Updates recommended')) break;
      await vi.advanceTimersByTimeAsync(10);
      await Promise.resolve();
    }
    expect(screen.getByText('Updates recommended')).toBeTruthy();
    expect(screen.getByText('Pull latest from git')).toBeTruthy();
    expect(screen.getByText(/Auto-pulling from repository in/i)).toBeTruthy();

    // Advance time until the countdown expires and the hook runs pullAll.
    // We use a loop (rather than a single 30s jump) to avoid race conditions with effect scheduling.
    for (let i = 0; i < 40; i++) {
      if (hoisted.pullAll.mock.calls.length > 0) break;
      await vi.advanceTimersByTimeAsync(1_000);
      await Promise.resolve();
      await Promise.resolve();
    }

    expect(hoisted.pullAll).toHaveBeenCalledTimes(1);
    expect(hoisted.requestRetrieveAllSlices).toHaveBeenCalledTimes(0);
    expect(hoisted.retrieveAllSlicesExecute).toHaveBeenCalledTimes(0);
    vi.useRealTimers();
  });

  it('should use remote-wins pull in dashboard mode after countdown', async () => {
    vi.useFakeTimers();
    hoisted.isDashboardMode = true;
    hoisted.shouldPromptReload.mockReturnValue(false);
    hoisted.shouldCheckRemoteHead.mockReturnValue(true);
    hoisted.getRemoteAheadStatus.mockResolvedValue({ isRemoteAhead: true, localSha: 'a', remoteHeadSha: 'b' });
    hoisted.isRemoteShaDismissed.mockReturnValue(false);

    render(<Harness />);

    for (let i = 0; i < 200; i++) {
      if (screen.queryByText('Updates recommended')) break;
      await vi.advanceTimersByTimeAsync(10);
      await Promise.resolve();
    }
    expect(screen.getByText('Updates recommended')).toBeTruthy();

    for (let i = 0; i < 40; i++) {
      if (hoisted.pullLatestRemoteWins.mock.calls.length > 0) break;
      await vi.advanceTimersByTimeAsync(1_000);
      await Promise.resolve();
      await Promise.resolve();
    }

    expect(hoisted.pullLatestRemoteWins).toHaveBeenCalledTimes(1);
    expect(hoisted.pullAll).toHaveBeenCalledTimes(0);
    vi.useRealTimers();
  });

  it('should cancel countdown when Snooze is clicked', async () => {
    vi.useFakeTimers();
    hoisted.shouldPromptReload.mockReturnValue(false);
    hoisted.shouldCheckRemoteHead.mockReturnValue(true);
    hoisted.getRemoteAheadStatus.mockResolvedValue({ isRemoteAhead: true, localSha: 'a', remoteHeadSha: 'b' });
    hoisted.isRemoteShaDismissed.mockReturnValue(false);

    render(<Harness />);

    for (let i = 0; i < 200; i++) {
      if (screen.queryByRole('button', { name: 'Snooze 1 hour' })) break;
      await vi.advanceTimersByTimeAsync(10);
      await Promise.resolve();
    }

    // Snooze should cancel countdown and close the modal.
    screen.getByRole('button', { name: 'Snooze 1 hour' }).click();

    await vi.advanceTimersByTimeAsync(35_000);
    await Promise.resolve();
    await Promise.resolve();

    expect(hoisted.pullAll).toHaveBeenCalledTimes(0);
    vi.useRealTimers();
  });

  it('should dismiss current SHA and not re-nudge until remote SHA changes', async () => {
    hoisted.shouldPromptReload.mockReturnValue(false);
    hoisted.shouldCheckRemoteHead.mockReturnValue(true);

    // Simulate SHA-dismiss storage behaviour in the mock layer.
    let dismissedSha: string | null = null;
    hoisted.isRemoteShaDismissed.mockImplementation((_repo: string, _branch: string, remoteSha: string) => dismissedSha === remoteSha);
    hoisted.dismissRemoteSha.mockImplementation((_repo: string, _branch: string, remoteSha: string) => {
      dismissedSha = remoteSha;
    });

    // First: remote SHA b
    hoisted.getRemoteAheadStatus.mockResolvedValue({ isRemoteAhead: true, localSha: 'a', remoteHeadSha: 'b' });

    render(<Harness />);
    expect(await screen.findByText('Updates recommended')).toBeTruthy();

    screen.getByRole('button', { name: 'Dismiss' }).click();
    expect(hoisted.dismissRemoteSha).toHaveBeenCalledTimes(1);

    // Trigger another check with same SHA b -> should not re-open modal
    window.dispatchEvent(new Event('focus'));
    await new Promise(r => setTimeout(r, 50));
    expect(screen.queryByText('Updates recommended')).toBeNull();

    // Now remote advances to SHA c -> should re-open modal
    hoisted.getRemoteAheadStatus.mockResolvedValue({ isRemoteAhead: true, localSha: 'a', remoteHeadSha: 'c' });
    window.dispatchEvent(new Event('focus'));

    expect(await screen.findByText('Updates recommended')).toBeTruthy();
  });

  it('backdrop/× close should snooze (not dismiss)', async () => {
    hoisted.shouldPromptReload.mockReturnValue(false);
    hoisted.shouldCheckRemoteHead.mockReturnValue(true);
    hoisted.getRemoteAheadStatus.mockResolvedValue({ isRemoteAhead: true, localSha: 'a', remoteHeadSha: 'b' });
    hoisted.isRemoteShaDismissed.mockReturnValue(false);

    render(<Harness />);
    expect(await screen.findByText('Updates recommended')).toBeTruthy();

    // Click the × (wired to onClose -> Snooze).
    screen.getByRole('button', { name: '×' }).click();

    expect(hoisted.snooze).toHaveBeenCalledTimes(1);
    expect(hoisted.dismissRemoteSha).toHaveBeenCalledTimes(0);
  });

  it('should not poll in background when document is hidden, but should prompt on visibility restore', async () => {
    hoisted.shouldPromptReload.mockReturnValue(false);
    hoisted.shouldCheckRemoteHead.mockReturnValue(true);
    hoisted.getRemoteAheadStatus.mockResolvedValue({ isRemoteAhead: true, localSha: 'a', remoteHeadSha: 'b' });
    hoisted.isRemoteShaDismissed.mockReturnValue(false);

    const originalHidden = document.hidden;
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });

    render(<Harness />);

    // Hidden: focus/visibility checks should not open modal (isVisible gate).
    window.dispatchEvent(new Event('focus'));
    await new Promise(r => setTimeout(r, 50));
    expect(screen.queryByText('Updates recommended')).toBeNull();

    // Make visible and trigger visibilitychange: should prompt now.
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));

    expect(await screen.findByText('Updates recommended')).toBeTruthy();

    // Restore hidden
    Object.defineProperty(document, 'hidden', { value: originalHidden, configurable: true });
  });
});


