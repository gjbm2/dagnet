/**
 * @vitest-environment happy-dom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const hoisted = vi.hoisted(() => ({
  pullAll: vi.fn(),
  requestRetrieveAllSlices: vi.fn(),
  retrieveAllSlicesExecute: vi.fn(),
  getFile: vi.fn(),
  updateTabData: vi.fn(),

  // stalenessNudgeService fakes
  recordPageLoad: vi.fn(),
  shouldPromptReload: vi.fn(),
  isSnoozed: vi.fn(),
  canPrompt: vi.fn(),
  markPrompted: vi.fn(),
  snooze: vi.fn(),
  shouldCheckGitPull: vi.fn(),
  getRemoteAheadStatus: vi.fn(),
  getRetrieveAllSlicesStalenessStatus: vi.fn(),
  getPendingPlan: vi.fn(),
  setPendingPlan: vi.fn(),
  clearPendingPlan: vi.fn(),
  clearVolatileFlags: vi.fn(),
  getAutomaticMode: vi.fn(),
  setAutomaticMode: vi.fn(),
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

vi.mock('../../services/stalenessNudgeService', () => ({
  stalenessNudgeService: {
    recordPageLoad: hoisted.recordPageLoad,
    shouldPromptReload: hoisted.shouldPromptReload,
    isSnoozed: hoisted.isSnoozed,
    canPrompt: hoisted.canPrompt,
    markPrompted: hoisted.markPrompted,
    snooze: hoisted.snooze,
    shouldCheckGitPull: hoisted.shouldCheckGitPull,
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

describe('useStalenessNudges', () => {
  beforeEach(() => {
    for (const fn of Object.values(hoisted)) {
      if (typeof fn === 'function' && 'mockReset' in fn) (fn as any).mockReset();
    }

    hoisted.isSnoozed.mockReturnValue(false);
    hoisted.canPrompt.mockReturnValue(true);
    hoisted.shouldCheckGitPull.mockResolvedValue(false);
    hoisted.getRemoteAheadStatus.mockResolvedValue({ isRemoteAhead: false });
    hoisted.getRetrieveAllSlicesStalenessStatus.mockReturnValue({
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

    screen.getByText('Run selected').click();
    expect(reloadSpy).toHaveBeenCalledTimes(1);
    reloadSpy.mockRestore();
  });

  it('should request retrieve-all-slices when Retrieve is due + selected', async () => {
    hoisted.shouldPromptReload.mockReturnValue(false);
    hoisted.getRetrieveAllSlicesStalenessStatus.mockReturnValue({
      isStale: true,
      parameterCount: 2,
      staleParameterCount: 1,
      mostRecentRetrievedAtMs: 123,
    });

    render(<Harness />);

    expect(await screen.findByText('Updates recommended')).toBeTruthy();
    expect(screen.getByText('Retrieve all slices (active graph)')).toBeTruthy();

    screen.getByText('Run selected').click();
    expect(hoisted.requestRetrieveAllSlices).toHaveBeenCalledTimes(1);
  });

  it('should persist pending plan when Reload + Pull are selected', async () => {
    hoisted.shouldPromptReload.mockReturnValue(true);
    hoisted.shouldCheckGitPull.mockResolvedValue(true);
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
    expect(reloadSpy).toHaveBeenCalledTimes(1);
    reloadSpy.mockRestore();
  });

  it('should NOT auto-run due actions without user confirmation (no silent retrieve)', async () => {
    hoisted.shouldPromptReload.mockReturnValue(false);
    hoisted.shouldCheckGitPull.mockResolvedValue(false);
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

  it('should skip retrieve-all after pull when post-pull staleness is no longer due', async () => {
    hoisted.shouldPromptReload.mockReturnValue(false);
    hoisted.shouldCheckGitPull.mockResolvedValue(true);
    hoisted.getRemoteAheadStatus.mockResolvedValue({ isRemoteAhead: true, localSha: 'a', remoteHeadSha: 'b' });

    // First call (modal due computation): stale → shows Retrieve action as due/checked.
    // Second call (post-pull re-check): not stale → should skip retrieve.
    hoisted.getRetrieveAllSlicesStalenessStatus
      .mockReturnValueOnce({ isStale: true, parameterCount: 1, staleParameterCount: 1 })
      .mockReturnValueOnce({ isStale: false, parameterCount: 1, staleParameterCount: 0 });

    render(<Harness />);

    expect(await screen.findByText('Updates recommended')).toBeTruthy();
    expect(screen.getByText('Pull latest from git')).toBeTruthy();
    expect(screen.getByText('Retrieve all slices (active graph)')).toBeTruthy();

    screen.getByText('Run selected').click();

    await waitFor(() => {
      expect(hoisted.pullAll).toHaveBeenCalledTimes(1);
    });

    // Retrieve should be skipped (no request event, no direct execute)
    expect(hoisted.requestRetrieveAllSlices).toHaveBeenCalledTimes(0);
    expect(hoisted.retrieveAllSlicesExecute).toHaveBeenCalledTimes(0);
  });
});


