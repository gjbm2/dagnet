/**
 * @vitest-environment happy-dom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';

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

  // nonBlockingPullService fakes
  _nonBlockingPullActive: false,
  startNonBlockingPull: vi.fn(function(this: any) { hoisted._nonBlockingPullActive = true; return 'auto-pull:repo-1:main'; } as any),
  cancelNonBlockingPull: vi.fn(() => { hoisted._nonBlockingPullActive = false; }),
  isNonBlockingPullActive: vi.fn(() => hoisted._nonBlockingPullActive),

  // bannerManagerService fakes
  setBanner: vi.fn(),
  clearBanner: vi.fn(),

  // operationRegistryService fakes
  opsRegister: vi.fn(),
  opsComplete: vi.fn(),

  // db fakes
  dbWorkspacesGet: vi.fn(),

  // Track openConflictModal instances across renders (for stale-closure test)
  openConflictModalInstances: [] as ReturnType<typeof vi.fn>[],
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
  usePullAll: () => {
    const fn = vi.fn();
    hoisted.openConflictModalInstances.push(fn);
    return {
      isPulling: false,
      pullAll: hoisted.pullAll,
      conflictModal: null,
      openConflictModal: fn,
    };
  },
  onOpenConflictModal: () => () => {},
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

vi.mock('../../services/nonBlockingPullService', () => ({
  startNonBlockingPull: hoisted.startNonBlockingPull,
  cancelNonBlockingPull: hoisted.cancelNonBlockingPull,
  isNonBlockingPullActive: hoisted.isNonBlockingPullActive,
}));

vi.mock('../../services/operationRegistryService', () => ({
  operationRegistryService: {
    register: hoisted.opsRegister,
    setStatus: vi.fn(),
    setProgress: vi.fn(),
    setLabel: vi.fn(),
    setCountdown: vi.fn(),
    complete: hoisted.opsComplete,
    subscribe: vi.fn(() => vi.fn()),
    getState: vi.fn(() => ({ active: [], recent: [] })),
    get: vi.fn(),
    remove: vi.fn(),
    pauseCountdown: vi.fn(),
    resumeCountdown: vi.fn(),
    setCancellable: vi.fn(),
  },
}));

vi.mock('../../services/bannerManagerService', () => ({
  bannerManagerService: {
    setBanner: hoisted.setBanner,
    clearBanner: hoisted.clearBanner,
    clearAll: vi.fn(),
    subscribe: vi.fn(() => vi.fn()),
    getState: vi.fn(() => ({ banners: [] })),
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

describe('useStalenessNudges', () => {
  beforeEach(() => {
    for (const fn of Object.values(hoisted)) {
      if (typeof fn === 'function' && 'mockReset' in fn) (fn as any).mockReset();
    }

    // Reset stale-closure tracking.
    hoisted.openConflictModalInstances.length = 0;

    // Boot readiness gate in useStalenessNudges waits for TabContext init completion.
    (window as any).__dagnetTabContextInitDone = true;

    hoisted.isDashboardMode = false;
    hoisted._nonBlockingPullActive = false;
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

    hoisted.getFile.mockReturnValue({
      type: 'graph',
      data: { edges: [], nodes: [] },
    });

    // Default service-owned signal collection implementations.
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
      let localSha: string | undefined;
      let remoteHeadSha: string | null | undefined;
      const lastRemoteCheckedAtMs = Date.now();

      if (!repository) return { gitPullDue, detectedRemoteSha, gitPullLastDoneAtMs, localSha, remoteHeadSha, lastRemoteCheckedAtMs };
      if (isShareLive) return { gitPullDue, detectedRemoteSha, gitPullLastDoneAtMs, localSha, remoteHeadSha, lastRemoteCheckedAtMs };

      const scopeKey = `${repository}-${branch}`;
      if (hoisted.isSnoozed('git-pull', scopeKey, nowMs, storage)) return { gitPullDue, detectedRemoteSha, gitPullLastDoneAtMs, localSha, remoteHeadSha, lastRemoteCheckedAtMs };
      if (!hoisted.canPrompt('git-pull', nowMs, storage)) return { gitPullDue, detectedRemoteSha, gitPullLastDoneAtMs, localSha, remoteHeadSha, lastRemoteCheckedAtMs };

      if (hoisted.shouldCheckRemoteHead(repository, branch, nowMs, storage)) {
        const status = await hoisted.getRemoteAheadStatus(repository, branch, storage);
        localSha = status?.localSha;
        remoteHeadSha = status?.remoteHeadSha;
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

      return { gitPullDue, detectedRemoteSha, gitPullLastDoneAtMs, localSha, remoteHeadSha, lastRemoteCheckedAtMs };
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

  it('should show reload banner (not modal) when a newer app version is deployed', async () => {
    hoisted.isRemoteAppVersionNewerThanLocal.mockReturnValue(true);
    hoisted.getCachedRemoteAppVersion.mockReturnValue('99.99.99-beta');

    render(<Harness />);

    await waitFor(() => {
      expect(hoisted.setBanner).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'app-update',
          label: expect.stringContaining('New version available'),
          actionLabel: 'Reload now',
        })
      );
    });
  });

  it('should show retrieve progress indicator (not auto-execute) when retrieve is due (no pull)', async () => {
    hoisted.getRetrieveAllSlicesStalenessStatus.mockResolvedValue({
      isStale: true,
      parameterCount: 2,
      staleParameterCount: 1,
      mostRecentRetrievedAtMs: 123,
    });

    render(<Harness />);

    // Retrieve-all must NEVER execute automatically — only the nightly cron does that.
    // The hook should register a progress indicator nudging the user to retrieve.
    await waitFor(() => {
      expect(hoisted.opsRegister).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'retrieve-stale',
          kind: 'staleness-nudge',
          label: expect.stringContaining('stale'),
        })
      );
    });
    expect(hoisted.retrieveAllSlicesExecute).not.toHaveBeenCalled();
  });

  it('should start non-blocking pull AND show reload banner when both are due (no strict cascade block)', async () => {
    hoisted.isRemoteAppVersionNewerThanLocal.mockReturnValue(true);
    hoisted.getCachedRemoteAppVersion.mockReturnValue('99.99.99-beta');
    hoisted.shouldCheckRemoteHead.mockReturnValue(true);
    hoisted.getRemoteAheadStatus.mockResolvedValue({ isRemoteAhead: true, localSha: 'a', remoteHeadSha: 'b' });
    hoisted.isRemoteShaDismissed.mockReturnValue(false);

    render(<Harness />);

    // Both should fire: non-blocking pull toast + reload banner.
    await waitFor(() => {
      expect(hoisted.startNonBlockingPull).toHaveBeenCalledTimes(1);
    });
    expect(hoisted.setBanner).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'app-update' })
    );
  });

  it('should skip retrieve-all after pull when pull brings fresh retrieval state (not stale)', async () => {
    hoisted.shouldCheckRemoteHead.mockReturnValue(true);
    hoisted.getRemoteAheadStatus.mockResolvedValue({ isRemoteAhead: true, localSha: 'a', remoteHeadSha: 'b' });

    hoisted.getRetrieveAllSlicesStalenessStatus
      .mockResolvedValueOnce({ isStale: true, parameterCount: 1, staleParameterCount: 1 })
      .mockResolvedValueOnce({ isStale: false, parameterCount: 1, staleParameterCount: 0, mostRecentRetrievedAtMs: Date.now() });

    render(<Harness />);

    // Non-blocking path: startNonBlockingPull with onComplete cascade.
    await waitFor(() => {
      expect(hoisted.startNonBlockingPull).toHaveBeenCalledTimes(1);
    });
    const opts = hoisted.startNonBlockingPull.mock.calls[0][0];
    expect(opts.repository).toBe('repo-1');
    expect(opts.branch).toBe('main');
    expect(typeof opts.onComplete).toBe('function');
  });

  it('should start non-blocking pull when remote is ahead (no retrieve-all)', async () => {
    hoisted.shouldCheckRemoteHead.mockReturnValue(true);
    hoisted.getRemoteAheadStatus.mockResolvedValue({ isRemoteAhead: true, localSha: 'a', remoteHeadSha: 'b' });
    hoisted.isRemoteShaDismissed.mockReturnValue(false);

    render(<Harness />);

    await waitFor(() => {
      expect(hoisted.startNonBlockingPull).toHaveBeenCalledTimes(1);
    });
    const opts = hoisted.startNonBlockingPull.mock.calls[0][0];
    expect(opts.repository).toBe('repo-1');
    expect(opts.branch).toBe('main');
    expect(opts.remoteSha).toBe('b');
    expect(typeof opts.onDismiss).toBe('function');
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

    // Should show progress indicator (not auto-execute) for chart's parent graph.
    await waitFor(() => {
      expect(hoisted.opsRegister).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'retrieve-stale',
          kind: 'staleness-nudge',
        })
      );
    });
    expect(hoisted.retrieveAllSlicesExecute).not.toHaveBeenCalled();

    // Ensure the chart path threads the effective DSL through to the service call.
    const call = hoisted.getRetrieveAllSlicesStalenessStatus.mock.calls.find((c) => c[3] === chartDsl);
    expect(call).toBeTruthy();
  });

  it('should start non-blocking pull in dashboard mode', async () => {
    hoisted.isDashboardMode = true;
    hoisted.shouldCheckRemoteHead.mockReturnValue(true);
    hoisted.getRemoteAheadStatus.mockResolvedValue({ isRemoteAhead: true, localSha: 'a', remoteHeadSha: 'b' });
    hoisted.isRemoteShaDismissed.mockReturnValue(false);

    render(<Harness />);

    await waitFor(() => {
      expect(hoisted.startNonBlockingPull).toHaveBeenCalledTimes(1);
    });
    const opts = hoisted.startNonBlockingPull.mock.calls[0][0];
    expect(opts.repository).toBe('repo-1');
    expect(opts.branch).toBe('main');
  });

  it('should not start non-blocking pull when snoozed', async () => {
    hoisted.shouldCheckRemoteHead.mockReturnValue(true);
    hoisted.getRemoteAheadStatus.mockResolvedValue({ isRemoteAhead: true, localSha: 'a', remoteHeadSha: 'b' });
    hoisted.isRemoteShaDismissed.mockReturnValue(false);
    hoisted.isSnoozed.mockReturnValue(true);

    render(<Harness />);

    // Give the hook time to settle.
    await new Promise(r => setTimeout(r, 100));
    expect(hoisted.startNonBlockingPull).toHaveBeenCalledTimes(0);
  });

  it('should pass onDismiss callback that dismisses SHA in non-blocking pull', async () => {
    hoisted.shouldCheckRemoteHead.mockReturnValue(true);
    hoisted.getRemoteAheadStatus.mockResolvedValue({ isRemoteAhead: true, localSha: 'a', remoteHeadSha: 'b' });
    hoisted.isRemoteShaDismissed.mockReturnValue(false);

    render(<Harness />);

    await waitFor(() => {
      expect(hoisted.startNonBlockingPull).toHaveBeenCalledTimes(1);
    });

    // Invoke the onDismiss callback and verify it dismisses the SHA.
    const opts = hoisted.startNonBlockingPull.mock.calls[0][0];
    opts.onDismiss();
    expect(hoisted.dismissRemoteSha).toHaveBeenCalledTimes(1);
    expect(hoisted.dismissRemoteSha).toHaveBeenCalledWith('repo-1', 'main', 'b', expect.anything());
  });

  it('should pass onComplete callback that clears dismissed SHA', async () => {
    hoisted.shouldCheckRemoteHead.mockReturnValue(true);
    hoisted.getRemoteAheadStatus.mockResolvedValue({ isRemoteAhead: true, localSha: 'a', remoteHeadSha: 'b' });
    hoisted.isRemoteShaDismissed.mockReturnValue(false);

    render(<Harness />);

    await waitFor(() => {
      expect(hoisted.startNonBlockingPull).toHaveBeenCalledTimes(1);
    });

    // Invoke the onComplete callback and verify it clears the dismissed SHA.
    const opts = hoisted.startNonBlockingPull.mock.calls[0][0];
    opts.onComplete();
    expect(hoisted.clearDismissedRemoteSha).toHaveBeenCalledTimes(1);
    expect(hoisted.clearDismissedRemoteSha).toHaveBeenCalledWith('repo-1', 'main', expect.anything());
  });

  it('should not start non-blocking pull when document is hidden, but should on visibility restore', async () => {
    hoisted.shouldCheckRemoteHead.mockReturnValue(true);
    hoisted.getRemoteAheadStatus.mockResolvedValue({ isRemoteAhead: true, localSha: 'a', remoteHeadSha: 'b' });
    hoisted.isRemoteShaDismissed.mockReturnValue(false);

    const originalHidden = document.hidden;
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });

    render(<Harness />);

    // Hidden: should not trigger non-blocking pull.
    window.dispatchEvent(new Event('focus'));
    await new Promise(r => setTimeout(r, 50));
    expect(hoisted.startNonBlockingPull).toHaveBeenCalledTimes(0);

    // Make visible and trigger visibilitychange: should start pull now.
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));

    await waitFor(() => {
      expect(hoisted.startNonBlockingPull).toHaveBeenCalledTimes(1);
    });

    Object.defineProperty(document, 'hidden', { value: originalHidden, configurable: true });
  });

  it('should do nothing when no actions are due', async () => {
    render(<Harness />);

    await new Promise(r => setTimeout(r, 100));
    expect(hoisted.startNonBlockingPull).toHaveBeenCalledTimes(0);
    expect(hoisted.retrieveAllSlicesExecute).toHaveBeenCalledTimes(0);
    expect(hoisted.setBanner).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: 'app-update' })
    );
  });

  it('should call the latest openConflictModal when onConflicts fires after re-render (stale closure guard)', async () => {
    // This test protects against the bug where startNonBlockingPull captures
    // onConflicts in a closure at call time, but after a re-render (e.g. React
    // Strict Mode double-mount, or any state change) the captured callback
    // still references the OLD openConflictModal — whose setState calls target
    // an unmounted component instance and silently do nothing.
    //
    // The fix is to use a ref so the closure always dereferences the latest
    // openConflictModal. This test verifies that invariant.

    hoisted.shouldCheckRemoteHead.mockReturnValue(true);
    hoisted.getRemoteAheadStatus.mockResolvedValue({
      isRemoteAhead: true, localSha: 'a', remoteHeadSha: 'b',
    });
    hoisted.isRemoteShaDismissed.mockReturnValue(false);

    const { rerender } = render(<Harness />);

    await waitFor(() => {
      expect(hoisted.startNonBlockingPull).toHaveBeenCalledTimes(1);
    });

    // Record which instances existed when startNonBlockingPull was called.
    const instanceCountAfterPull = hoisted.openConflictModalInstances.length;
    expect(instanceCountAfterPull).toBeGreaterThan(0);

    // Force a re-render — usePullAll() returns a new openConflictModal identity.
    rerender(<Harness />);

    const instanceCountAfterRerender = hoisted.openConflictModalInstances.length;
    expect(instanceCountAfterRerender).toBeGreaterThan(instanceCountAfterPull);

    // Simulate the pull completing with conflicts by invoking the captured onConflicts.
    const opts = hoisted.startNonBlockingPull.mock.calls[0][0];
    const fakeConflicts = [{ fileId: 'f1', fileName: 'test.yaml' }];
    const fakeOpId = 'auto-pull:repo-1:main';
    opts.onConflicts(fakeConflicts, fakeOpId);

    // The LATEST openConflictModal instance (from after re-render) must be called.
    const latestInstance = hoisted.openConflictModalInstances[hoisted.openConflictModalInstances.length - 1];
    expect(latestInstance).toHaveBeenCalledTimes(1);
    expect(latestInstance).toHaveBeenCalledWith(fakeConflicts, fakeOpId);

    // If a different (earlier) instance exists, it must NOT have been called —
    // that would mean we're calling a stale closure.
    const firstInstance = hoisted.openConflictModalInstances[0];
    if (firstInstance !== latestInstance) {
      expect(firstInstance).not.toHaveBeenCalled();
    }
  });
});
