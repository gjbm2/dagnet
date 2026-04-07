import React, { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigatorContext } from '../contexts/NavigatorContext';
import { useTabContext, useFileRegistry } from '../contexts/TabContext';
import { stalenessNudgeService } from '../services/stalenessNudgeService';
import { usePullAll, onOpenConflictModal } from './usePullAll';
import { STALENESS_NUDGE_COUNTDOWN_SECONDS } from '../constants/staleness';
import { useShareModeOptional } from '../contexts/ShareModeContext';
import { countdownService } from '../services/countdownService';
import { useCountdown } from './useCountdown';
import { useDashboardMode } from '../contexts/DashboardModeContext';
import { liveShareSyncService } from '../services/liveShareSyncService';
import { repositoryOperationsService } from '../services/repositoryOperationsService';
import toast from 'react-hot-toast';
import { bannerManagerService } from '../services/bannerManagerService';
import { startNonBlockingPull, cancelNonBlockingPull, isNonBlockingPullActive } from '../services/nonBlockingPullService';
import { registerStalenessNudgeJobs, updateNudgeContext } from '../services/stalenessNudgeJobs';
import { jobSchedulerService } from '../services/jobSchedulerService';

export interface UseStalenessNudgesResult {
  /** Must be rendered somewhere (for pull conflict resolution UI). */
  modals: ReactNode;
}

/**
 * Global safety nudges — thin hook that wires React context to scheduler jobs.
 *
 * Timer management, boot gating, polling, and focus/visibility are owned by
 * jobSchedulerService. This hook:
 *   1. Registers staleness nudge jobs (once)
 *   2. Keeps the nudge context store fresh (every render)
 *   3. Wires pull conflict callbacks
 *   4. Manages share-live dashboard countdown (legacy path, to be migrated later)
 */
export function useStalenessNudges(): UseStalenessNudgesResult {
  const { state: navState, isLoading: navigatorIsLoading } = useNavigatorContext();
  const tabContext = useTabContext() as any;
  const { pullAll, conflictModal, openConflictModal } = usePullAll();
  const openConflictModalRef = useRef(openConflictModal);
  useEffect(() => { openConflictModalRef.current = openConflictModal; });

  // Listen for conflict modal open requests from ANY usePullAll instance.
  useEffect(() => onOpenConflictModal(
    (conflicts, opId) => openConflictModalRef.current(conflicts, opId)
  ), []);

  const fileRegistry = useFileRegistry();
  const shareMode = useShareModeOptional();
  const { isDashboardMode } = useDashboardMode();

  const activeTabId: string | null = tabContext.activeTabId ?? null;
  const tabs: any[] = tabContext.tabs ?? [];

  const activeTab = useMemo(() => {
    if (!activeTabId) return null;
    return tabs.find((t: any) => t.id === activeTabId) || null;
  }, [tabs, activeTabId]);

  const activeFileId: string | undefined = activeTab?.fileId;
  const activeFile: any = activeFileId ? (fileRegistry.getFile(activeFileId) as any) : null;
  const activeFileType: string | undefined = activeFile?.type;
  const activeChartParentGraphFileId: string | undefined =
    activeFileType === 'chart'
      ? (activeFile?.data?.recipe?.parent?.parent_file_id ?? activeFile?.data?.source?.parent_file_id)
      : undefined;
  const activeChartEffectiveDsl: string | undefined =
    activeFileType === 'chart'
      ? (activeFile?.data?.recipe?.analysis?.query_dsl ?? activeFile?.data?.source?.query_dsl)
      : undefined;

  const retrieveTargetGraphFileId: string | undefined =
    activeFileType === 'chart' ? activeChartParentGraphFileId : activeFileId;

  // ---- Suppression (same logic as before) --------------------------------

  const suppressStalenessNudges = useMemo(() => {
    if (shareMode?.isStaticMode) return true;
    try {
      const ss = window.sessionStorage;
      if (ss.getItem('dagnet:nonudge') === '1') return true;
      const url = new URL(window.location.href);
      if (url.searchParams.has('nonudge')) {
        ss.setItem('dagnet:nonudge', '1');
        return true;
      }
      if (url.searchParams.has('retrieveall')) {
        ss.setItem('dagnet:nonudge', '1');
        return true;
      }
    } catch {
      // ignore
    }
    return false;
  }, [shareMode?.isStaticMode]);

  // ---- Share-live countdown (legacy path — still uses countdownService) ---

  const [countdownKey, setCountdownKey] = useState<string | undefined>(undefined);
  const countdownKeyRef = useRef<string | undefined>(undefined);
  const countdownCancelTokenRef = useRef<number>(0);
  const countdownState = useCountdown(countdownKey);
  const countdownSeconds = countdownState?.secondsRemaining;
  const [shareAutoRefreshPending, setShareAutoRefreshPending] = useState<boolean>(false);
  const shareAutoRefreshPendingRef = useRef<boolean>(false);

  const stopCountdown = useCallback(() => {
    countdownService.cancelCountdownsByPrefix('staleness:auto-pull:');
    countdownCancelTokenRef.current += 1;
    countdownKeyRef.current = undefined;
    setCountdownKey(undefined);
    shareAutoRefreshPendingRef.current = false;
    setShareAutoRefreshPending(false);
  }, []);

  const onCountdownExpire = useCallback(async () => {
    const isShareLive = shareMode?.isLiveMode ?? false;
    const repo = isShareLive ? shareMode?.identity.repo : navState.selectedRepo;
    const branch = (isShareLive ? shareMode?.identity.branch : navState.selectedBranch) || 'main';
    const graph = isShareLive ? shareMode?.identity.graph : undefined;
    const storage = window.localStorage;

    stopCountdown();

    await stalenessNudgeService.handleStalenessAutoPull({
      nowMs: Date.now(),
      storage,
      repository: repo || undefined,
      branch,
      shareGraph: graph,
      isShareLive,
      isDashboardMode,
      pullAll: async () => { await pullAll(); },
      pullLatestRemoteWins: async () => {
        if (!repo) return;
        await repositoryOperationsService.pullLatestRemoteWins(repo, branch);
      },
      refreshLiveShareToLatest: async () => {
        return await liveShareSyncService.refreshToLatest();
      },
      notify: (kind, message) => {
        if (kind === 'success') toast.success(message);
        else toast.error(message);
      },
    });
  }, [navState.selectedRepo, navState.selectedBranch, stopCountdown, pullAll, shareMode, isDashboardMode]);

  const startShareLiveCountdown = useCallback(
    (opts: { key: string }) => {
      stopCountdown();
      const tokenAtStart = countdownCancelTokenRef.current;
      countdownKeyRef.current = opts.key;
      setCountdownKey(opts.key);
      countdownService.startCountdown({
        key: opts.key,
        durationSeconds: STALENESS_NUDGE_COUNTDOWN_SECONDS,
        onExpire: async () => {
          if (!shareAutoRefreshPendingRef.current) return;
          if (countdownCancelTokenRef.current !== tokenAtStart) return;
          if (countdownKeyRef.current !== opts.key) return;
          await onCountdownExpire();
        },
        audit: {
          operationType: 'session',
          startCode: 'STALENESS_AUTO_PULL_COUNTDOWN_START',
          cancelCode: 'STALENESS_AUTO_PULL_COUNTDOWN_CANCEL',
          expireCode: 'STALENESS_AUTO_PULL_COUNTDOWN_EXPIRE',
          message: 'Staleness auto-pull countdown',
          metadata: { key: opts.key },
        },
      });
    },
    [stopCountdown, onCountdownExpire]
  );

  // ---- Pull callback (wired to nonBlockingPullService) -------------------

  const fireNonBlockingPull = useCallback((opts: {
    repository: string;
    branch: string;
    detectedRemoteSha: string;
    retrieveDue: boolean;
  }) => {
    const { repository, branch, detectedRemoteSha, retrieveDue } = opts;
    const storage = window.localStorage;
    const pullScope = `${repository}-${branch}`;
    if (stalenessNudgeService.isSnoozed('git-pull', pullScope, Date.now(), storage)) return;
    if (isNonBlockingPullActive()) return;

    // Dashboard mode: use remote-wins pull to avoid surfacing conflicts
    // on an unattended terminal. Same strategy as handleStalenessAutoPull.
    if (isDashboardMode) {
      repositoryOperationsService.pullLatestRemoteWins(repository, branch).then(() => {
        stalenessNudgeService.clearDismissedRemoteSha(repository, branch, storage);
        if (retrieveDue) {
          jobSchedulerService.run('retrieve-nudge');
        }
      }).catch((err) => {
        console.warn('[useStalenessNudges] dashboard remote-wins pull failed:', err);
      });
      return;
    }

    startNonBlockingPull({
      repository,
      branch,
      remoteSha: detectedRemoteSha,
      onConflicts: (conflicts, opId) => openConflictModalRef.current(conflicts, opId),
      onDismiss: () => {
        if (detectedRemoteSha) {
          stalenessNudgeService.dismissRemoteSha(repository, branch, detectedRemoteSha, storage);
        }
      },
      onComplete: () => {
        stalenessNudgeService.clearDismissedRemoteSha(repository, branch, storage);
        if (retrieveDue) {
          jobSchedulerService.run('retrieve-nudge');
        }
      },
    });
  }, [isDashboardMode]);

  // ---- Register scheduler jobs (once) and update context (every render) --

  const isShareLive = shareMode?.isLiveMode ?? false;
  const repository: string | undefined = isShareLive ? shareMode?.identity.repo : navState.selectedRepo;
  const selectedBranch: string | undefined = isShareLive ? shareMode?.identity.branch : navState.selectedBranch;

  // Update context store every render so scheduler jobs see fresh values.
  updateNudgeContext({
    repository,
    branch: selectedBranch || 'main',
    isShareLive,
    shareGraph: isShareLive ? shareMode?.identity.graph : undefined,
    isDashboardMode,
    navigatorIsLoading,
    retrieveTargetGraphFileId,
    activeFileType,
    activeChartEffectiveDsl,
    suppressed: suppressStalenessNudges,
    onPullNeeded: fireNonBlockingPull,
  });

  // Register jobs once on mount.
  useEffect(() => {
    registerStalenessNudgeJobs();
  }, []);

  // ---- Lifecycle cleanup -------------------------------------------------

  // Clear volatile nudge flags on mount (same as before).
  useEffect(() => {
    stalenessNudgeService.clearVolatileFlags(window.localStorage);
  }, []);

  // Cleanup countdown on unmount.
  useEffect(() => stopCountdown, [stopCountdown]);
  useEffect(() => cancelNonBlockingPull, []);

  // Clear banners on unmount.
  useEffect(() => {
    return () => {
      bannerManagerService.clearBanner('app-update');
      bannerManagerService.clearBanner('retrieve-stale');
    };
  }, []);

  // ---- Share-live countdown banner (legacy — to be migrated later) -------

  useEffect(() => {
    const shouldShow = shareAutoRefreshPending && typeof countdownSeconds === 'number';
    if (!shouldShow) {
      bannerManagerService.clearBanner('share-live-refresh');
      return;
    }

    const repo = shareMode?.identity?.repo;
    const branch = shareMode?.identity?.branch;
    const graph = shareMode?.identity?.graph;
    const detail =
      repo && branch && graph
        ? `Repo: ${repo}/${branch} • Graph: ${graph}`
        : undefined;

    bannerManagerService.setBanner({
      id: 'share-live-refresh',
      priority: 50,
      label: `Update pending — refreshing in ${countdownSeconds ?? 0}s…`,
      detail,
      actionLabel: 'Snooze 1 hour',
      onAction: () => {
        try {
          if (repo && branch && graph) {
            const scopeKey = `${repo}-${branch}-${graph}`;
            stalenessNudgeService.snooze('git-pull', scopeKey, Date.now(), window.localStorage);
          }
        } catch {
          // ignore
        }
        stopCountdown();
      },
      actionTitle: 'Snooze auto-refresh for 1 hour',
    });

    return () => bannerManagerService.clearBanner('share-live-refresh');
  }, [shareAutoRefreshPending, countdownSeconds, shareMode, stopCountdown]);

  return {
    modals: React.createElement(React.Fragment, null, conflictModal as any),
  };
}
