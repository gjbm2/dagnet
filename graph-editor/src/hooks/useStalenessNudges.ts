import React, { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigatorContext } from '../contexts/NavigatorContext';
import { useTabContext, useFileRegistry } from '../contexts/TabContext';
import { stalenessNudgeService } from '../services/stalenessNudgeService';
import { usePullAll, onOpenConflictModal } from './usePullAll';
import { executeRetrieveAllSlicesWithProgressToast } from '../services/retrieveAllSlicesService';
import { sessionLogService } from '../services/sessionLogService';
import { STALENESS_NUDGE_COUNTDOWN_SECONDS, STALENESS_NUDGE_VISIBLE_POLL_MS } from '../constants/staleness';
import { useShareModeOptional } from '../contexts/ShareModeContext';
import { countdownService } from '../services/countdownService';
import { useCountdown } from './useCountdown';
import { useDashboardMode } from '../contexts/DashboardModeContext';
import { liveShareSyncService } from '../services/liveShareSyncService';
import { repositoryOperationsService } from '../services/repositoryOperationsService';
import { operationRegistryService } from '../services/operationRegistryService';
import toast from 'react-hot-toast';
import { APP_VERSION } from '../version';
import { bannerManagerService } from '../services/bannerManagerService';
import { startNonBlockingPull, cancelNonBlockingPull, isNonBlockingPullActive } from '../services/nonBlockingPullService';

export interface UseStalenessNudgesResult {
  /** Must be rendered somewhere (for pull conflict resolution UI). */
  modals: ReactNode;
}

/**
 * Global safety nudges:
 * - stale page (reload) → persistent banner
 * - stale git pull (check remote HEAD) → non-blocking pull toast
 * - stale "retrieve all slices" for the focused graph tab → persistent banner (user must click)
 *
 * All nudges are non-blocking. No modal is ever shown.
 * IMPORTANT: Retrieve-all is NEVER executed automatically. It is managed by the nightly
 * cron cycle (?retrieveall URL param). Interactive sessions only show a banner nudge.
 *
 * IMPORTANT:
 * - This hook centralises the nudging logic so UI entry points stay access-only.
 */
export function useStalenessNudges(): UseStalenessNudgesResult {
  const { state: navState, isLoading: navigatorIsLoading } = useNavigatorContext();
  const tabContext = useTabContext() as any;
  const { pullAll, conflictModal, openConflictModal } = usePullAll();
  const openConflictModalRef = useRef(openConflictModal);
  useEffect(() => { openConflictModalRef.current = openConflictModal; });

  // Listen for conflict modal open requests from ANY usePullAll instance.
  // Context menus unmount before pullAll() completes, so their local state
  // updates fire into the void.  This persistent listener (in AppShell)
  // ensures the modal always opens.
  useEffect(() => onOpenConflictModal(
    (conflicts, opId) => openConflictModalRef.current(conflicts, opId)
  ), []);

  const fileRegistry = useFileRegistry();
  const tabOperations = tabContext.operations;
  const shareMode = useShareModeOptional();
  const { isDashboardMode } = useDashboardMode();

  const activeTabId: string | null = tabContext.activeTabId ?? null;
  const tabs: any[] = tabContext.tabs ?? [];

  const activeTab = useMemo(() => {
    if (!activeTabId) return null;
    return tabs.find(t => t.id === activeTabId) || null;
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

  const isVisible = () => !document.hidden;

  const isTabContextInitDone = useCallback((): boolean => {
    try {
      const w = (typeof window !== 'undefined') ? (window as any) : undefined;
      return w?.__dagnetTabContextInitDone === true;
    } catch {
      return false;
    }
  }, []);

  const inFlightRef = useRef(false);
  const lastGraphTriggerKeyRef = useRef<string>('');

  // Countdown timer state — used only for the share-live dashboard banner path.
  const [countdownKey, setCountdownKey] = useState<string | undefined>(undefined);
  const countdownKeyRef = useRef<string | undefined>(undefined);
  const countdownCancelTokenRef = useRef<number>(0);
  const countdownState = useCountdown(countdownKey);
  const countdownSeconds = countdownState?.secondsRemaining;
  const [shareAutoRefreshPending, setShareAutoRefreshPending] = useState<boolean>(false);
  const shareAutoRefreshPendingRef = useRef<boolean>(false);

  // Opt-out: suppress staleness nudges for this session when the URL contains ?nonudge
  // (used by share/embed links for read-only explore flows).
  //
  // IMPORTANT: We do NOT rewrite the URL to remove ?nonudge.
  // - Notion embeds and share links often rely on the URL being stable across reloads.
  // - Rewriting can make behaviour seem "brittle" when an embed cold-starts and the param is gone.
  const suppressStalenessNudges = useMemo(() => {
    // Static share mode is a read-only snapshot — there is no repo to pull,
    // no running workspace to reload, and no slices to retrieve.
    // Nudging download/update actions is irrelevant and confusing.
    if (shareMode?.isStaticMode) return true;

    try {
      const ss = window.sessionStorage;
      if (ss.getItem('dagnet:nonudge') === '1') return true;

      const url = new URL(window.location.href);
      if (url.searchParams.has('nonudge')) {
        ss.setItem('dagnet:nonudge', '1');
        return true;
      }

      // Autonomous / scheduler-driven runs:
      // If the app is explicitly directed to run daily automation via ?retrieveall=...,
      // it must never be blocked by interactive staleness nudges.
      //
      // IMPORTANT: Persist suppression for this session (even if other code later cleans the URL),
      // so the automation cannot be interrupted mid-run.
      if (url.searchParams.has('retrieveall')) {
        ss.setItem('dagnet:nonudge', '1');
        return true;
      }
    } catch {
      // ignore
    }
    return false;
  }, [shareMode?.isStaticMode]);

  // Stop countdown timer (share-live banner only)
  const stopCountdown = useCallback(() => {
    // Cancel by prefix to guarantee we kill the correct timer even if the key changes mid-flight.
    countdownService.cancelCountdownsByPrefix('staleness:auto-pull:');
    countdownCancelTokenRef.current += 1;
    countdownKeyRef.current = undefined;
    setCountdownKey(undefined);
    shareAutoRefreshPendingRef.current = false;
    setShareAutoRefreshPending(false);
  }, []);

  // Clear any persisted nudge state on mount so it can never survive a refresh (F5).
  useEffect(() => {
    stalenessNudgeService.clearVolatileFlags(window.localStorage);
  }, []);

  /**
   * Auto-pull: called when share-live countdown expires. Pulls from git ONLY (no retrieve-all).
   */
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
      pullAll: async () => {
        await pullAll();
      },
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

  const startCountdown = useCallback(
    (opts: { key: string }) => {
      stopCountdown();
      const tokenAtStart = countdownCancelTokenRef.current;
      countdownKeyRef.current = opts.key;
      setCountdownKey(opts.key);
      countdownService.startCountdown({
        key: opts.key,
        durationSeconds: STALENESS_NUDGE_COUNTDOWN_SECONDS,
        onExpire: async () => {
          // Extra cancellation safety: even if an expiry callback somehow runs after cancel,
          // never execute if the key is no longer the active countdown for this hook.
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

  /**
   * Show a persistent banner when a newer app version is deployed.
   * The banner stays until the user clicks "Reload now" or it's cleared.
   */
  const showReloadBanner = useCallback((remoteAppVersion?: string) => {
    const versionDetail = remoteAppVersion
      ? `Current: ${APP_VERSION} → Available: ${remoteAppVersion}`
      : undefined;

    bannerManagerService.setBanner({
      id: 'app-update',
      priority: 60,
      label: 'New version available — reload to update',
      detail: versionDetail,
      actionLabel: 'Reload now',
      onAction: () => window.location.reload(),
      actionTitle: 'Reload to pick up the latest version',
    });
  }, []);

  /**
   * Fire retrieve-all-slices via progress toast.
   *
   * IMPORTANT: This must ONLY be called from a user-initiated action (e.g. banner click).
   * Never call this automatically — retrieve-all is managed by the nightly cron cycle;
   * interactive sessions should only nudge the user, not execute autonomously.
   */
  const fireRetrieveAllDirect = useCallback(() => {
    if (!retrieveTargetGraphFileId) return;
    if (!tabOperations?.updateTabData) return;
    const graphFile = fileRegistry.getFile(retrieveTargetGraphFileId) as any;
    if (!graphFile?.data || graphFile?.type !== 'graph') return;

    bannerManagerService.clearBanner('retrieve-stale');
    void executeRetrieveAllSlicesWithProgressToast({
      getGraph: () => (fileRegistry.getFile(retrieveTargetGraphFileId) as any)?.data || null,
      setGraph: (g) => tabOperations.updateTabData(retrieveTargetGraphFileId, g),
      toastId: `nudge-retrieve:${retrieveTargetGraphFileId}`,
      toastLabel: 'Retrieve All (stale data)',
    });
  }, [retrieveTargetGraphFileId, fileRegistry, tabOperations]);

  /**
   * Show a persistent banner nudging the user to retrieve stale data.
   * The user must click to initiate — no automatic execution.
   */
  const showRetrieveNudgeBanner = useCallback(() => {
    // Non-blocking progress indicator. Banners are reserved for serious
    // operational alerts (automation cycles, auth expiry). A routine data
    // freshness nudge uses the progress indicator in the status bar.
    operationRegistryService.register({
      id: 'retrieve-stale',
      kind: 'staleness-nudge',
      label: 'Data may be stale — use Data \u203a Retrieve All Slices to refresh',
      status: 'pending',
    });
    // Auto-dismiss after 8 seconds
    setTimeout(() => {
      operationRegistryService.complete('retrieve-stale', 'complete', 'Dismissed');
    }, 8_000);
  }, []);

  /**
   * Start a non-blocking pull with standard callbacks (dismiss, conflicts, cascade).
   */
  const fireNonBlockingPull = useCallback((opts: {
    repository: string;
    branch: string;
    detectedRemoteSha: string;
    retrieveDue: boolean;
    storage: Storage;
  }) => {
    const { repository, branch, detectedRemoteSha, retrieveDue, storage } = opts;
    const pullScope = `${repository}-${branch}`;
    if (stalenessNudgeService.isSnoozed('git-pull', pullScope, Date.now(), storage)) return;
    if (isNonBlockingPullActive()) return;

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
        // Cascade: if retrieve-all is also due, show banner — let user decide.
        // Retrieve-all is managed by the nightly cron; interactive sessions only nudge.
        if (retrieveDue) {
          showRetrieveNudgeBanner();
        }
      },
    });
  }, [showRetrieveNudgeBanner]);

  const maybePrompt = useCallback(async () => {
    if (suppressStalenessNudges) return;
    if (inFlightRef.current) return;
    if (!isVisible()) return;

    inFlightRef.current = true;
    try {
      const now = Date.now();
      const storage = window.localStorage;

      // Boot readiness gate:
      // Nudges should NOT evaluate while app boot is incomplete, otherwise we get noisy "unknown/blocked"
      // states while Navigator/TabContext/file registry are still initialising.
      if (!isTabContextInitDone()) return;

      // Always stamp this page load (the "last refresh" baseline).
      if (!storage.getItem('dagnet:staleness:lastPageLoadAtMs')) {
        stalenessNudgeService.recordPageLoad(now, storage);
      }

      // Compute which actions are due (and not snoozed).
      const reloadSnoozed = stalenessNudgeService.isSnoozed('reload', undefined, now, storage);

      const updateSignal = await stalenessNudgeService.collectUpdateSignal({
        nowMs: now,
        localAppVersion: APP_VERSION,
        storage,
        reloadSnoozed,
      });
      const isOutdated = updateSignal.isOutdated;

      // Unattended terminals (dashboard mode): auto-reload when a new client is deployed.
      if (isDashboardMode && isOutdated) {
        const autoFn = (stalenessNudgeService as any).maybeAutoReloadForUpdate;
        if (typeof autoFn === 'function') {
          const didReload = !!autoFn.call(stalenessNudgeService, APP_VERSION, now, storage);
          if (didReload) return;
        }
      }

      const reloadDue = updateSignal.reloadDue;

      const isShareLive = shareMode?.isLiveMode ?? false;
      const repository: string | undefined = isShareLive ? shareMode?.identity.repo : navState.selectedRepo;
      const selectedBranch: string | undefined = isShareLive ? shareMode?.identity.branch : navState.selectedBranch;
      const branch: string = selectedBranch || 'main';
      const graph: string | undefined = isShareLive ? shareMode?.identity.graph : undefined;

      if (isShareLive) {
        if (!repository || !selectedBranch) return;
      } else {
        if (!navState.selectedRepo || !navState.selectedBranch) return;
        if (navigatorIsLoading) return;
      }

      const gitCollected = await stalenessNudgeService.collectGitSignal({
        nowMs: now,
        storage,
        repository: repository || undefined,
        branch,
        isShareLive,
        shareGraph: graph || undefined,
      });
      const gitPullDue = gitCollected.gitPullDue;
      const detectedRemoteSha = gitCollected.detectedRemoteSha;

      const retrieveSignalCollected = await stalenessNudgeService.collectRetrieveSignal({
        nowMs: now,
        storage,
        retrieveTargetGraphFileId: retrieveTargetGraphFileId || undefined,
        repository: repository || undefined,
        branch,
        targetSliceDsl: activeFileType === 'chart' ? activeChartEffectiveDsl : undefined,
      });
      const retrieveDue = retrieveSignalCollected.retrieveDue;

      if (!reloadDue && !gitPullDue && !retrieveDue) return;

      // Mark prompted for due items so focus/visibility doesn't keep re-triggering.
      if (reloadDue) stalenessNudgeService.markPrompted('reload', now, storage);
      if (gitPullDue) stalenessNudgeService.markPrompted('git-pull', now, storage);
      if (retrieveDue) stalenessNudgeService.markPrompted('retrieve-all-slices', now, storage);

      // ---- Share-live dashboard mode: non-blocking refresh via banner ----
      if (isShareLive && isDashboardMode && gitPullDue && detectedRemoteSha) {
        const pullScope = repository ? `${repository}-${branch}-${graph}` : undefined;
        if (pullScope && stalenessNudgeService.isSnoozed('git-pull', pullScope, Date.now(), storage)) return;
        shareAutoRefreshPendingRef.current = true;
        setShareAutoRefreshPending(true);
        const id = shareMode?.identity;
        if (id) {
          startCountdown({ key: `staleness:auto-pull:share:${id.repo}:${id.branch}:${id.graph}` });
        }
        return;
      }

      // ---- All paths below are non-blocking ----

      // Reload due → persistent banner (user clicks when ready).
      if (reloadDue) {
        showReloadBanner(updateSignal.remoteAppVersion);
      }

      // Git pull due → non-blocking pull toast with countdown.
      // Unlike before, this runs even when reload is also due — they coexist.
      // Pull runs in the background; reload banner persists until user clicks it.
      if (gitPullDue && detectedRemoteSha && repository) {
        fireNonBlockingPull({
          repository,
          branch,
          detectedRemoteSha,
          retrieveDue,
          storage,
        });
      }

      // Retrieve due standalone (no pull cascading into it) → show banner, let user decide.
      // Retrieve-all is managed by the nightly cron; interactive sessions only nudge.
      if (retrieveDue && !gitPullDue) {
        showRetrieveNudgeBanner();
      }
    } finally {
      inFlightRef.current = false;
    }
  }, [suppressStalenessNudges, navState.selectedRepo, navState.selectedBranch, activeFileId, fileRegistry, shareMode, isDashboardMode, showReloadBanner, fireNonBlockingPull, showRetrieveNudgeBanner, startCountdown, retrieveTargetGraphFileId, activeFileType, activeChartEffectiveDsl, isTabContextInitDone, navigatorIsLoading]);

  // Boot completion: when TabContext signals init done, re-run prompt evaluation once.
  useEffect(() => {
    const handler = () => {
      void maybePrompt();
    };
    window.addEventListener('dagnet:tabContextInitDone' as any, handler);
    return () => window.removeEventListener('dagnet:tabContextInitDone' as any, handler);
  }, [maybePrompt]);

  // Record the page load baseline once on mount.
  useEffect(() => {
    stalenessNudgeService.recordPageLoad(Date.now(), window.localStorage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cleanup: ensure countdown timer is cancelled on unmount.
  useEffect(() => stopCountdown, [stopCountdown]);
  useEffect(() => cancelNonBlockingPull, []);

  // Clear banners on unmount.
  useEffect(() => {
    return () => {
      bannerManagerService.clearBanner('app-update');
      bannerManagerService.clearBanner('retrieve-stale');
    };
  }, []);

  // Run on key "user is back" moments.
  useEffect(() => {
    const onFocus = () => void maybePrompt();
    const onVisibility = () => {
      if (!document.hidden) void maybePrompt();
    };

    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);

    // Also check when tab/repo context changes (user navigated internally).
    void maybePrompt();

    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [maybePrompt]);

  // Background polling interval for unattended terminals (e.g. dashboard mode).
  useEffect(() => {
    const intervalId = window.setInterval(() => {
      if (!document.hidden) {
        void maybePrompt();
      }
    }, STALENESS_NUDGE_VISIBLE_POLL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [maybePrompt]);

  // Also re-check when the active graph file actually loads/changes (not just on focus).
  useEffect(() => {
    const subscribeFileId = retrieveTargetGraphFileId;
    if (!subscribeFileId) return;
    const fr: any = fileRegistry as any;
    if (typeof fr.subscribe !== 'function') return;

    const unsubscribe = fr.subscribe(subscribeFileId, (updatedFile: any) => {
      if (!updatedFile) return;
      if (updatedFile.type !== 'graph') return;
      if (!updatedFile.data) return;

      const lm = updatedFile.lastModified ?? 0;
      const key = `${subscribeFileId}:${lm}:${updatedFile.isLoaded ? 1 : 0}`;
      if (key === lastGraphTriggerKeyRef.current) return;
      lastGraphTriggerKeyRef.current = key;

      void maybePrompt();
    });

    return unsubscribe;
  }, [retrieveTargetGraphFileId, fileRegistry, maybePrompt]);

  // Share-live countdown banner is owned by the central banner manager.
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
