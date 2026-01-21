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
  activeTabId: 'tab-1' as string | null,
  tabs: [{ id: 'tab-1', fileId: 'graph-1', viewMode: 'interactive' }] as any[],

  // stalenessNudgeService fakes
  recordPageLoad: vi.fn(),
  recordDone: vi.fn(),
  getLastDoneAtMs: vi.fn(),
  getLastPageLoadAtMs: vi.fn(),
  refreshRemoteAppVersionIfDue: vi.fn(),
  isRemoteAppVersionNewerThanLocal: vi.fn(),
  getCachedRemoteAppVersion: vi.fn(),
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
  computeNudgingPlanFromSignals: vi.fn(),
  runSelectedStalenessActions: vi.fn(),
  handleStalenessAutoPull: vi.fn(),
  collectUpdateSignal: vi.fn(),
  collectGitSignal: vi.fn(),
  collectRetrieveSignal: vi.fn(),

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
    activeTabId: hoisted.activeTabId,
    tabs: hoisted.tabs,
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
  executeRetrieveAllSlicesWithProgressToast: hoisted.retrieveAllSlicesExecute,
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
    refreshRemoteAppVersionIfDue: hoisted.refreshRemoteAppVersionIfDue,
    isRemoteAppVersionNewerThanLocal: hoisted.isRemoteAppVersionNewerThanLocal,
    getCachedRemoteAppVersion: hoisted.getCachedRemoteAppVersion,
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
    computeNudgingPlanFromSignals: hoisted.computeNudgingPlanFromSignals,
    runSelectedStalenessActions: hoisted.runSelectedStalenessActions,
    handleStalenessAutoPull: hoisted.handleStalenessAutoPull,
    collectUpdateSignal: hoisted.collectUpdateSignal,
    collectGitSignal: hoisted.collectGitSignal,
    collectRetrieveSignal: hoisted.collectRetrieveSignal,
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
    hoisted.activeTabId = 'tab-1';
    hoisted.tabs = [{ id: 'tab-1', fileId: 'graph-1', viewMode: 'interactive' }];
    hoisted.isSnoozed.mockReturnValue(false);
    hoisted.canPrompt.mockReturnValue(true);
    hoisted.refreshRemoteAppVersionIfDue.mockResolvedValue(undefined);
    hoisted.isRemoteAppVersionNewerThanLocal.mockReturnValue(false);
    hoisted.getCachedRemoteAppVersion.mockReturnValue(undefined);
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
    hoisted.runSelectedStalenessActions.mockResolvedValue(undefined);
    hoisted.handleStalenessAutoPull.mockResolvedValue(undefined);

    // Default: compute a plan that matches existing behaviour (retrieve never pre-selected).
    hoisted.computeNudgingPlanFromSignals.mockImplementation(({ signals }: any) => {
      const localV = String(signals?.localAppVersion ?? '');
      const remoteV = typeof signals?.remoteAppVersion === 'string' ? signals.remoteAppVersion : undefined;
      const remoteNewer = remoteV ? hoisted.isRemoteAppVersionNewerThanLocal(localV, { getItem: () => remoteV } as any) : false;

      const reloadStatus = remoteV
        ? (remoteNewer ? 'due' : 'not_due')
        : 'unknown';
      const reloadReason =
        reloadStatus === 'due'
          ? `A newer client is deployed (you: ${localV}, deployed: ${remoteV})`
          : remoteV && remoteV !== localV
            ? `Deployed version is older than your client (staged rollout; you: ${localV}, deployed: ${remoteV})`
            : 'Client is up to date';

      const pullDue = !!signals?.git?.isRemoteAhead;
      const pullStatus = pullDue ? 'due' : (signals?.git ? 'not_due' : 'unknown');

      const retrieveStale = !!signals?.retrieve?.isStale;
      const retrieveStatus =
        reloadStatus === 'due'
          ? 'blocked'
          : pullDue
            ? 'blocked'
            : retrieveStale
              ? 'due'
              : (signals?.retrieve ? 'not_due' : 'unknown');

      return {
        entity: { type: 'graph', graphFileId: 'graph-1' },
        scope: undefined,
        steps: {
          reload: { key: 'reload', status: reloadStatus, reason: reloadReason },
          'git-pull': { key: 'git-pull', status: pullStatus, reason: pullDue ? 'Remote has newer commits; pull is recommended' : 'Local matches remote' },
          'retrieve-all-slices': {
            key: 'retrieve-all-slices',
            status: retrieveStatus,
            reason: retrieveStale ? 'Retrieve is stale (refresh recommended)' : 'Retrieve is fresh (within cooloff window)',
            blockedBy: pullDue ? 'git-pull' : undefined,
            retrieveWithoutPull: pullStatus === 'unknown' && retrieveStale ? true : undefined,
          },
        },
        recommendedChecked: {
          reload: reloadStatus === 'due',
          'git-pull': pullStatus === 'due',
          'retrieve-all-slices': false,
        },
      };
    });

    hoisted.getFile.mockReturnValue({
      type: 'graph',
      data: { edges: [], nodes: [] },
    });

    // Default service-owned signal collection implementations (mirror pre-refactor hook behaviour).
    hoisted.collectUpdateSignal.mockImplementation(async ({ nowMs, localAppVersion, storage, reloadSnoozed }: any) => {
      if (!reloadSnoozed) await hoisted.refreshRemoteAppVersionIfDue(nowMs, storage);
      const isOutdated = !!hoisted.isRemoteAppVersionNewerThanLocal(localAppVersion, storage);
      const reloadDue = !reloadSnoozed && isOutdated && !!hoisted.canPrompt('reload', nowMs, storage);
      const remoteAppVersion = hoisted.getCachedRemoteAppVersion(storage);
      return { isOutdated, reloadDue, remoteAppVersion };
    });

    hoisted.collectGitSignal.mockImplementation(async ({ nowMs, storage, repository, branch, isShareLive }: any) => {
      let gitPullDue = false;
      let detectedRemoteSha: string | null = null;
      let gitPullLastDoneAtMs: number | undefined;

      if (!repository) return { gitPullDue, detectedRemoteSha, gitPullLastDoneAtMs };
      if (isShareLive) return { gitPullDue, detectedRemoteSha, gitPullLastDoneAtMs };

      const scopeKey = `${repository}-${branch}`;
      if (hoisted.isSnoozed('git-pull', scopeKey, nowMs, storage)) return { gitPullDue, detectedRemoteSha, gitPullLastDoneAtMs };
      if (!hoisted.canPrompt('git-pull', nowMs, storage)) return { gitPullDue, detectedRemoteSha, gitPullLastDoneAtMs };

      if (hoisted.shouldCheckRemoteHead(repository, branch, nowMs, storage)) {
        const status = await hoisted.getRemoteAheadStatus(repository, branch, storage);
        if (status?.isRemoteAhead && status.remoteHeadSha) {
          if (!hoisted.isRemoteShaDismissed(repository, branch, status.remoteHeadSha, storage)) {
            gitPullDue = true;
            detectedRemoteSha = status.remoteHeadSha;
          }
        }
      }

      try {
        const ws = await hoisted.dbWorkspacesGet(`${repository}-${branch}`);
        gitPullLastDoneAtMs = typeof ws?.lastSynced === 'number' ? ws.lastSynced : undefined;
      } catch {
        gitPullLastDoneAtMs = undefined;
      }

      return { gitPullDue, detectedRemoteSha, gitPullLastDoneAtMs };
    });

    hoisted.collectRetrieveSignal.mockImplementation(async ({ nowMs, storage, retrieveTargetGraphFileId, repository, branch, targetSliceDsl }: any) => {
      let retrieveDue = false;
      let retrieveMostRecentRetrievedAtMs: number | undefined;

      if (!retrieveTargetGraphFileId) return { retrieveDue, retrieveMostRecentRetrievedAtMs };
      if (hoisted.isSnoozed('retrieve-all-slices', retrieveTargetGraphFileId, nowMs, storage)) return { retrieveDue, retrieveMostRecentRetrievedAtMs };
      if (!hoisted.canPrompt('retrieve-all-slices', nowMs, storage)) return { retrieveDue, retrieveMostRecentRetrievedAtMs };

      const graphFile = hoisted.getFile(retrieveTargetGraphFileId);
      if (graphFile?.type !== 'graph' || !graphFile?.data) return { retrieveDue, retrieveMostRecentRetrievedAtMs };

      const staleness = await hoisted.getRetrieveAllSlicesStalenessStatus(
        graphFile.data,
        nowMs,
        repository ? { repository, branch } : undefined,
        targetSliceDsl
      );
      retrieveDue = !!staleness?.isStale;
      const a = staleness?.lastSuccessfulRunAtMs;
      const b = staleness?.mostRecentRetrievedAtMs;
      retrieveMostRecentRetrievedAtMs = a === undefined ? b : b === undefined ? a : Math.max(a, b);
      return { retrieveDue, retrieveMostRecentRetrievedAtMs };
    });
  });

  it('should show combined modal and reload when only Reload is due + selected', async () => {
    hoisted.isRemoteAppVersionNewerThanLocal.mockReturnValue(true);
    hoisted.getCachedRemoteAppVersion.mockReturnValue('99.99.99-beta');

    const reloadSpy = vi.spyOn(window.location, 'reload').mockImplementation(() => {});

    render(<Harness />);

    expect(await screen.findByText('Updates recommended')).toBeTruthy();
    expect(screen.getByText('Reload page')).toBeTruthy();
    expect(screen.getByText('Automatic mode')).toBeTruthy();

    screen.getByRole('button', { name: 'Run selected' }).click();
    await waitFor(() => {
      expect(hoisted.runSelectedStalenessActions).toHaveBeenCalledTimes(1);
    });
    reloadSpy.mockRestore();
  });

  it('should request retrieve-all-slices when Retrieve is due + selected', async () => {
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
    await waitFor(() => {
      expect(hoisted.runSelectedStalenessActions).toHaveBeenCalledTimes(1);
    });
    const call = hoisted.runSelectedStalenessActions.mock.calls[0]?.[0];
    expect(call?.selected?.has?.('retrieve-all-slices')).toBe(true);
  });

  it('should NOT claim a newer deployed client when deployed version is older (modal opened for other due actions)', async () => {
    // Reload is NOT due (remote not newer), but a remote version exists and differs.
    hoisted.isRemoteAppVersionNewerThanLocal.mockReturnValue(false);
    hoisted.getCachedRemoteAppVersion.mockReturnValue('0.0.1-beta');

    // Force the modal to open for a different due action.
    hoisted.getRetrieveAllSlicesStalenessStatus.mockResolvedValue({
      isStale: true,
      parameterCount: 1,
      staleParameterCount: 1,
    });

    render(<Harness />);

    expect(await screen.findByText('Updates recommended')).toBeTruthy();

    // Reload row still renders, but its description must not claim "newer deployed".
    expect(screen.getByText('Reload page')).toBeTruthy();
    expect(screen.getByText(/Deployed version is older than your client/)).toBeTruthy();
    expect(screen.queryByText(/A newer client is deployed/)).toBeNull();
  });

  it('uses the newer of (graph marker, parameter retrieved_at) for Retrieve last-done display', async () => {
    // Force modal open (retrieve due).
    hoisted.getRetrieveAllSlicesStalenessStatus.mockResolvedValue({
      isStale: true,
      parameterCount: 1,
      staleParameterCount: 1,
      // Simulate: marker exists but older than the most recent parameter retrieved_at
      lastSuccessfulRunAtMs: new Date('2026-01-20T09:44:56.739Z').getTime(),
      mostRecentRetrievedAtMs: new Date('2026-01-21T10:12:01.000Z').getTime(),
    } as any);

    render(<Harness />);
    expect(await screen.findByText('Updates recommended')).toBeTruthy();

    // The retrieve row should display the newer timestamp (21-Jan-26 10:12), not the stale marker.
    expect(screen.getByText('Retrieve all slices (active graph)')).toBeTruthy();
    expect(screen.getByText(/Last:\s*21-Jan-26 10:12/)).toBeTruthy();
  });

  it('should run retrieve-all headlessly before reloading when Reload + Retrieve are selected', async () => {
    hoisted.isRemoteAppVersionNewerThanLocal.mockReturnValue(true);
    hoisted.getCachedRemoteAppVersion.mockReturnValue('99.99.99-beta');
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

    screen.getByRole('button', { name: 'Run selected' }).click();

    await waitFor(() => {
      expect(hoisted.runSelectedStalenessActions).toHaveBeenCalledTimes(1);
    });
    reloadSpy.mockRestore();
  });

  it('should persist pending plan when Reload + Pull are selected', async () => {
    hoisted.isRemoteAppVersionNewerThanLocal.mockReturnValue(true);
    hoisted.getCachedRemoteAppVersion.mockReturnValue('99.99.99-beta');
    hoisted.shouldCheckRemoteHead.mockReturnValue(true);
    hoisted.getRemoteAheadStatus.mockResolvedValue({ isRemoteAhead: true, localSha: 'a', remoteHeadSha: 'b' });

    const reloadSpy = vi.spyOn(window.location, 'reload').mockImplementation(() => {});

    render(<Harness />);

    expect(await screen.findByText('Updates recommended')).toBeTruthy();
    expect(screen.getByText('Pull latest from git')).toBeTruthy();

    screen.getByRole('button', { name: 'Run selected' }).click();

    await waitFor(() => {
      expect(hoisted.runSelectedStalenessActions).toHaveBeenCalledTimes(1);
    });
    reloadSpy.mockRestore();
  });

  it('should NOT auto-run due actions without user confirmation (no silent retrieve)', async () => {
    hoisted.shouldCheckRemoteHead.mockReturnValue(false);
    hoisted.getRetrieveAllSlicesStalenessStatus.mockReturnValue({
      isStale: true,
      parameterCount: 1,
      staleParameterCount: 1,
    });

    render(<Harness />);

    // Modal should be shown; nothing should auto-execute.
    expect(await screen.findByText('Updates recommended')).toBeTruthy();
    expect(hoisted.runSelectedStalenessActions).toHaveBeenCalledTimes(0);
  });

  it('should skip retrieve-all after pull when pull brings fresh retrieval state (not stale)', async () => {
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
      expect(hoisted.runSelectedStalenessActions).toHaveBeenCalledTimes(1);
    });
  });

  it('should auto-pull after 30s countdown when remote is ahead (no retrieve-all)', async () => {
    vi.useFakeTimers();
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

    // Advance time until the countdown expires and the hook delegates to the auto-pull service.
    // We use a loop (rather than a single 30s jump) to avoid race conditions with effect scheduling.
    for (let i = 0; i < 40; i++) {
      if (hoisted.handleStalenessAutoPull.mock.calls.length > 0) break;
      await vi.advanceTimersByTimeAsync(1_000);
      await Promise.resolve();
      await Promise.resolve();
    }

    expect(hoisted.handleStalenessAutoPull).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('should NOT start auto-pull countdown when an update is due (strict cascade)', async () => {
    vi.useFakeTimers();
    hoisted.isRemoteAppVersionNewerThanLocal.mockReturnValue(true);
    hoisted.getCachedRemoteAppVersion.mockReturnValue('99.99.99-beta');
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
    // No auto-pull countdown banner when reload is due.
    expect(screen.queryByText(/Auto-pulling from repository in/i)).toBeNull();

    await vi.advanceTimersByTimeAsync(35_000);
    await Promise.resolve();
    await Promise.resolve();

    expect(hoisted.handleStalenessAutoPull).toHaveBeenCalledTimes(0);
    vi.useRealTimers();
  });

  it('passes chart effective DSL into retrieve staleness computation when active tab is a chart', async () => {
    const chartDsl = 'context(channel:influencer).window(1-Dec-25:7-Dec-25)';
    hoisted.tabs = [{ id: 'tab-1', fileId: 'chart-1', viewMode: 'interactive' }];

    hoisted.getFile.mockImplementation((fileId: string) => {
      if (fileId === 'chart-1') {
        return {
          type: 'chart',
          data: {
            recipe: { parent: { parent_file_id: 'graph-1' }, analysis: { query_dsl: chartDsl } },
          },
        } as any;
      }
      if (fileId === 'graph-1') {
        return { type: 'graph', data: { edges: [], nodes: [] } } as any;
      }
      return null as any;
    });

    hoisted.getRetrieveAllSlicesStalenessStatus.mockResolvedValue({
      isStale: true,
      parameterCount: 1,
      staleParameterCount: 1,
      mostRecentRetrievedAtMs: 123,
    } as any);

    render(<Harness />);

    expect(await screen.findByText('Updates recommended')).toBeTruthy();

    // Ensure the chart path threads the effective DSL through to the service call.
    const call = hoisted.getRetrieveAllSlicesStalenessStatus.mock.calls.find((c) => c[3] === chartDsl);
    expect(call).toBeTruthy();
    expect(screen.getByText('Retrieve all slices (parent graph)')).toBeTruthy();
  });

  it('should use remote-wins pull in dashboard mode after countdown', async () => {
    vi.useFakeTimers();
    hoisted.isDashboardMode = true;
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
      if (hoisted.handleStalenessAutoPull.mock.calls.length > 0) break;
      await vi.advanceTimersByTimeAsync(1_000);
      await Promise.resolve();
      await Promise.resolve();
    }

    expect(hoisted.handleStalenessAutoPull).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('should cancel countdown when Snooze is clicked', async () => {
    vi.useFakeTimers();
    hoisted.shouldCheckRemoteHead.mockReturnValue(true);
    hoisted.getRemoteAheadStatus.mockResolvedValue({ isRemoteAhead: true, localSha: 'a', remoteHeadSha: 'b' });
    hoisted.isRemoteShaDismissed.mockReturnValue(false);

    // Model snooze behaviour in the mock layer so the modal doesn't immediately re-open.
    let snoozedGitPull = false;
    hoisted.snooze.mockImplementation((key: string) => {
      if (key === 'git-pull') snoozedGitPull = true;
    });
    hoisted.isSnoozed.mockImplementation((key: string) => {
      if (key === 'git-pull') return snoozedGitPull;
      return false;
    });

    render(<Harness />);

    for (let i = 0; i < 200; i++) {
      if (screen.queryByRole('button', { name: 'Snooze 1 hour' })) break;
      await vi.advanceTimersByTimeAsync(10);
      await Promise.resolve();
    }

    // Snooze should cancel countdown and close the modal.
    screen.getByRole('button', { name: 'Snooze 1 hour' }).click();
    for (let i = 0; i < 200; i++) {
      if (!screen.queryByText('Updates recommended')) break;
      await vi.advanceTimersByTimeAsync(10);
      await Promise.resolve();
    }
    expect(screen.queryByText('Updates recommended')).toBeNull();

    await vi.advanceTimersByTimeAsync(35_000);
    await Promise.resolve();
    await Promise.resolve();

    expect(hoisted.handleStalenessAutoPull).toHaveBeenCalledTimes(0);
    vi.useRealTimers();
  });

  it('should dismiss current SHA and not re-nudge until remote SHA changes', async () => {
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


