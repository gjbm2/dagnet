import React, { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigatorContext } from '../contexts/NavigatorContext';
import { useTabContext, useFileRegistry } from '../contexts/TabContext';
import { stalenessNudgeService } from '../services/stalenessNudgeService';
import { requestRetrieveAllSlices } from './useRetrieveAllSlicesRequestListener';
import { usePullAll } from './usePullAll';
import { StalenessUpdateModal, type StalenessUpdateActionKey } from '../components/modals/StalenessUpdateModal';
import { executeRetrieveAllSlicesWithProgressToast, retrieveAllSlicesService } from '../services/retrieveAllSlicesService';
import { sessionLogService } from '../services/sessionLogService';
import { STALENESS_NUDGE_COUNTDOWN_SECONDS, STALENESS_NUDGE_VISIBLE_POLL_MS } from '../constants/staleness';
import { db } from '../db/appDatabase';
import { useShareModeOptional } from '../contexts/ShareModeContext';
import { useDashboardMode } from '../contexts/DashboardModeContext';
import { liveShareSyncService } from '../services/liveShareSyncService';
import { repositoryOperationsService } from '../services/repositoryOperationsService';
import toast from 'react-hot-toast';
import { APP_VERSION } from '../version';

export interface UseStalenessNudgesResult {
  /** Must be rendered somewhere (for pull conflict resolution UI). */
  modals: ReactNode;
}

/**
 * Global safety nudges:
 * - stale page (reload)
 * - stale git pull (check remote HEAD, nudge pull-all)
 * - stale "retrieve all slices" for the focused graph tab
 *
 * IMPORTANT:
 * - This hook centralises the nudging logic so UI entry points stay access-only.
 */
export function useStalenessNudges(): UseStalenessNudgesResult {
  const { state: navState } = useNavigatorContext();
  const tabContext = useTabContext() as any;
  const { pullAll, conflictModal } = usePullAll();
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

  const isVisible = () => !document.hidden;

  const inFlightRef = useRef(false);
  const lastGraphTriggerKeyRef = useRef<string>('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  // Safety: "automatic mode" must NEVER persist across refresh. It only applies to a workflow
  // the user explicitly initiates via the staleness nudge modal.
  const [automaticMode, setAutomaticMode] = useState<boolean>(false);
  const [modalActions, setModalActions] = useState<Array<{
    key: StalenessUpdateActionKey;
    due: boolean;
    checked: boolean;
    disabled?: boolean;
    description: string;
    label: string;
  }>>([]);

  // Countdown timer state for auto-pull when remote is ahead
  const [countdownSeconds, setCountdownSeconds] = useState<number | undefined>(undefined);
  const countdownIntervalRef = useRef<number | null>(null);
  // Track the remote SHA that triggered this modal (for dismiss logic)
  const currentRemoteShaRef = useRef<string | null>(null);
  // Share-live dashboard mode: refresh without a blocking modal.
  const [shareAutoRefreshPending, setShareAutoRefreshPending] = useState<boolean>(false);

  // Opt-out: suppress staleness nudges for this session when the URL contains ?nonudge
  // (used by share/embed links for read-only explore flows).
  //
  // IMPORTANT: We do NOT rewrite the URL to remove ?nonudge.
  // - Notion embeds and share links often rely on the URL being stable across reloads.
  // - Rewriting can make behaviour seem “brittle” when an embed cold-starts and the param is gone.
  const suppressStalenessNudges = useMemo(() => {
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
  }, []);

  // Stop countdown timer
  const stopCountdown = useCallback(() => {
    if (countdownIntervalRef.current !== null) {
      window.clearInterval(countdownIntervalRef.current);
      countdownIntervalRef.current = null;
    }
    setCountdownSeconds(undefined);
    setShareAutoRefreshPending(false);
  }, []);

  const closeModal = useCallback(() => {
    stopCountdown();
    setIsModalOpen(false);
  }, [stopCountdown]);

  const toggleAction = useCallback((key: StalenessUpdateActionKey) => {
    setModalActions(prev => prev.map(a => (a.key === key ? { ...a, checked: !a.checked } : a)));
  }, []);

  const toggleAutomaticMode = useCallback((enabled: boolean) => {
    setAutomaticMode(enabled);
  }, []);

  // Clear any persisted nudge state on mount so it can never survive a refresh (F5).
  useEffect(() => {
    stalenessNudgeService.clearVolatileFlags(window.localStorage);
  }, []);

  const runSelectedKeys = useCallback(async (
    selected: Set<StalenessUpdateActionKey>,
    opts?: { headlessRetrieve?: boolean }
  ) => {
    const now = Date.now();
    const storage = window.localStorage;

    const isShareLive = shareMode?.isLiveMode ?? false;
    const repo = isShareLive ? shareMode?.identity.repo : navState.selectedRepo;
    const branch = (isShareLive ? shareMode?.identity.branch : navState.selectedBranch) || 'main';
    const graph = isShareLive ? shareMode?.identity.graph : undefined;
    const graphFileId = activeFileId;

    const wantsReload = selected.has('reload');
    const wantsPull = selected.has('git-pull');
    const wantsRetrieve = selected.has('retrieve-all-slices');

    // SAFETY POLICY:
    // - We do NOT persist pending plans across refresh.
    // - If the user selects "Reload" alongside other actions, we run those actions NOW (explicit user intent),
    //   then reload at the end. Nothing is carried across refresh.
    if (wantsReload && (wantsPull || wantsRetrieve)) {
      sessionLogService.info(
        'session',
        'STALENESS_RUN_THEN_RELOAD',
        'Reload selected alongside other actions; running selected actions now, then reloading (nothing will run automatically after refresh)',
        undefined,
        { repository: repo, branch, fileId: graphFileId, wantsPull, wantsRetrieve }
      );
    }

    if (wantsPull) {
      if (isShareLive && repo && graph) {
        const res = await liveShareSyncService.refreshToLatest();
        if (!res.success) {
          toast.error(res.error || 'Live refresh failed');
        } else {
          toast.success('Updated to latest');
          stalenessNudgeService.clearDismissedShareRemoteSha({ repository: repo, branch, graph }, storage);
        }
      } else {
        await pullAll();
        // Clear dismissed SHA after successful pull so future changes are detected
        if (repo) {
          stalenessNudgeService.clearDismissedRemoteSha(repo, branch, storage);
        }
      }
    }

    if (wantsRetrieve) {
      const mustCompleteBeforeReload = wantsReload;
      if (wantsPull && activeFileId) {
        // Intended behaviour for READ-ONLY users:
        // After pull, decide based solely on repo-backed retrieved_at freshness (staleness/cooloff),
        // not on any additional “planning” logic.
        const graphAfterPull = (fileRegistry.getFile(activeFileId) as any)?.data || null;
        if (!graphAfterPull) return;

        const status = await stalenessNudgeService.getRetrieveAllSlicesStalenessStatus(
          graphAfterPull,
          Date.now(),
          repo ? { repository: repo, branch } : undefined
        );
        if (!status.isStale) {
          sessionLogService.info(
            'data-fetch',
            'RETRIEVE_ALL_SKIPPED_AFTER_PULL',
            'Retrieve All skipped: pull brought fresh retrieval state (within cooloff window)',
            undefined,
            {
              fileId: activeFileId,
              repository: repo,
              branch,
              mostRecentRetrievedAtMs: status.mostRecentRetrievedAtMs,
              parameterCount: status.parameterCount,
              staleParameterCount: status.staleParameterCount,
            }
          );
        } else if (automaticMode || mustCompleteBeforeReload) {
          const graphFile = fileRegistry.getFile(activeFileId) as any;
          if (!graphFile?.data || graphFile?.type !== 'graph') return;
          if (!tabOperations?.updateTabData) return;

          // Headless/automatic retrieve: show Session Log as the primary UX for progress.
          void sessionLogService.openLogTab();

          await executeRetrieveAllSlicesWithProgressToast({
            getGraph: () => (fileRegistry.getFile(activeFileId) as any)?.data || null,
            setGraph: (g) => tabOperations.updateTabData(activeFileId, g),
            toastId: `retrieve-all-automatic:${activeFileId}`,
            toastLabel: 'Retrieve All (automatic)',
          });
        } else {
          requestRetrieveAllSlices();
        }
      } else if (automaticMode || mustCompleteBeforeReload) {
        if (!activeFileId) return;
        const graphFile = fileRegistry.getFile(activeFileId) as any;
        if (!graphFile?.data || graphFile?.type !== 'graph') return;
        if (!tabOperations?.updateTabData) return;

        // Headless/automatic retrieve: show Session Log as the primary UX for progress.
        void sessionLogService.openLogTab();

        await executeRetrieveAllSlicesWithProgressToast({
          getGraph: () => (fileRegistry.getFile(activeFileId) as any)?.data || null,
          setGraph: (g) => tabOperations.updateTabData(activeFileId, g),
          toastId: `retrieve-all-automatic:${activeFileId}`,
          toastLabel: 'Retrieve All (automatic)',
        });
      } else {
        requestRetrieveAllSlices();
      }
    }

    if (wantsReload) {
      window.location.reload();
    }
  }, [navState.selectedRepo, navState.selectedBranch, activeFileId, pullAll, fileRegistry, tabOperations, automaticMode]);

  const onRunSelected = useCallback(async () => {
    const selected = new Set(modalActions.filter(a => a.checked && !a.disabled).map(a => a.key));

    stopCountdown();
    setIsModalOpen(false);
    await runSelectedKeys(selected);
    // "Automatic mode" only applies to the workflow the user just initiated.
    setAutomaticMode(false);
  }, [modalActions, stopCountdown, runSelectedKeys]);

  const onSnoozeAll = useCallback(() => {
    const now = Date.now();
    const storage = window.localStorage;

    const isShareLive = shareMode?.isLiveMode ?? false;
    const repo = isShareLive ? shareMode?.identity.repo : navState.selectedRepo;
    const branch = (isShareLive ? shareMode?.identity.branch : navState.selectedBranch) || 'main';
    const graph = isShareLive ? shareMode?.identity.graph : undefined;
    const pullScope = repo ? (isShareLive && graph ? `${repo}-${branch}-${graph}` : `${repo}-${branch}`) : undefined;

    for (const a of modalActions) {
      if (!a.due) continue;
      if (a.key === 'reload') {
        stalenessNudgeService.snooze('reload', undefined, now, storage);
      } else if (a.key === 'git-pull') {
        if (pullScope) stalenessNudgeService.snooze('git-pull', pullScope, now, storage);
      } else if (a.key === 'retrieve-all-slices') {
        if (activeFileId) stalenessNudgeService.snooze('retrieve-all-slices', activeFileId, now, storage);
      }
    }

    closeModal();
  }, [modalActions, navState.selectedRepo, navState.selectedBranch, activeFileId, closeModal, shareMode]);

  /**
   * Dismiss: records the current remote SHA so user won't be nudged again
   * until the next cron cycle (when remote SHA changes).
   */
  const onDismiss = useCallback(() => {
    const storage = window.localStorage;
    const isShareLive = shareMode?.isLiveMode ?? false;
    const repo = isShareLive ? shareMode?.identity.repo : navState.selectedRepo;
    const branch = (isShareLive ? shareMode?.identity.branch : navState.selectedBranch) || 'main';
    const graph = isShareLive ? shareMode?.identity.graph : undefined;
    const remoteSha = currentRemoteShaRef.current;

    // Record this SHA as dismissed - won't prompt again until new commit appears
    if (repo && remoteSha) {
      if (isShareLive && graph) {
        stalenessNudgeService.dismissShareRemoteSha({ repository: repo, branch, graph }, remoteSha, storage);
      } else {
        stalenessNudgeService.dismissRemoteSha(repo, branch, remoteSha, storage);
      }
      sessionLogService.info(
        'session',
        'STALENESS_DISMISS',
        `Dismissed git-pull nudge for SHA ${remoteSha.slice(0, 7)}; won't prompt again until next remote commit`,
        undefined,
        { repository: repo, branch, remoteSha }
      );
    }

    closeModal();
  }, [navState.selectedRepo, navState.selectedBranch, closeModal, shareMode]);

  /**
   * Auto-pull: called when countdown expires. Pulls from git ONLY (no retrieve-all).
   */
  const onCountdownExpire = useCallback(async () => {
    const isShareLive = shareMode?.isLiveMode ?? false;
    const repo = isShareLive ? shareMode?.identity.repo : navState.selectedRepo;
    const branch = (isShareLive ? shareMode?.identity.branch : navState.selectedBranch) || 'main';
    const graph = isShareLive ? shareMode?.identity.graph : undefined;
    const storage = window.localStorage;

    sessionLogService.info(
      'session',
      'STALENESS_AUTO_PULL',
      isShareLive ? 'Auto-refreshing live share (countdown expired)' : 'Auto-pulling from repository (countdown expired)',
      undefined,
      { repository: repo, branch, graph }
    );

    stopCountdown();
    setIsModalOpen(false);

    if (isShareLive && repo && graph) {
      const res = await liveShareSyncService.refreshToLatest();
      if (!res.success) {
        toast.error(res.error || 'Live refresh failed');
        return;
      }
      toast.success('Updated to latest');
      stalenessNudgeService.clearDismissedShareRemoteSha({ repository: repo, branch, graph }, storage);
      return;
    }

    if (isDashboardMode && repo) {
      // Unattended terminals should prefer "remote wins" to avoid blocking on conflicts.
      await repositoryOperationsService.pullLatestRemoteWins(repo, branch);
    } else {
      // Execute git-pull only (not retrieve-all)
      await pullAll();
    }

    // Clear dismissed SHA after successful pull (so future changes are detected)
    if (repo) {
      stalenessNudgeService.clearDismissedRemoteSha(repo, branch, storage);
    }
  }, [navState.selectedRepo, navState.selectedBranch, stopCountdown, pullAll, shareMode]);

  const maybePrompt = useCallback(async () => {
    if (suppressStalenessNudges) return;
    if (inFlightRef.current) return;
    if (!isVisible()) return;
    if (isModalOpen) return;

    inFlightRef.current = true;
    try {
      const now = Date.now();
      const storage = window.localStorage;

      // Always stamp this page load (the "last refresh" baseline).
      // We do this in maybePrompt rather than only once so hot reload / re-mounts
      // don't accidentally erase the signal.
      // (It is safe because in a real reload, the value should update anyway.)
      if (!storage.getItem('dagnet:staleness:lastPageLoadAtMs')) {
        stalenessNudgeService.recordPageLoad(now, storage);
      }

      // Compute which actions are due (and not snoozed).
      const reloadSnoozed = stalenessNudgeService.isSnoozed('reload', undefined, now, storage);

      // Prefer a deployed-version check over the crude time-based heuristic:
      // - If version.json indicates a newer client is deployed, nudge immediately (subject to canPrompt).
      // - If offline / unavailable, fall back to the existing time-based nudge.
      //
      // NOTE: the `typeof` guards keep this hook resilient to test mocks that stub
      // stalenessNudgeService partially.
      if (!reloadSnoozed) {
        const refreshFn = (stalenessNudgeService as any).refreshRemoteAppVersionIfDue;
        if (typeof refreshFn === 'function') {
          await refreshFn.call(stalenessNudgeService, now, storage);
        }
      }

      let isOutdated = false;
      const newerFn = (stalenessNudgeService as any).isRemoteAppVersionNewerThanLocal;
      if (typeof newerFn === 'function') {
        isOutdated = !!newerFn.call(stalenessNudgeService, APP_VERSION, storage);
      } else {
        // Backwards-compatible fallback for partial mocks / older service shape.
        const diffFn = (stalenessNudgeService as any).isRemoteAppVersionDifferent;
        if (typeof diffFn === 'function') {
          isOutdated = !!diffFn.call(stalenessNudgeService, APP_VERSION, storage);
        }
      }

      // Unattended terminals (dashboard mode): auto-reload when a new client is deployed.
      // This avoids a modal that nobody can click, and keeps kiosk consoles fresh.
      if (isDashboardMode && isOutdated) {
        const autoFn = (stalenessNudgeService as any).maybeAutoReloadForUpdate;
        if (typeof autoFn === 'function') {
          const didReload = !!autoFn.call(stalenessNudgeService, APP_VERSION, now, storage);
          if (didReload) return;
        }
      }

      const reloadDue =
        !reloadSnoozed &&
        ((isOutdated && stalenessNudgeService.canPrompt('reload', now, storage)) ||
          stalenessNudgeService.shouldPromptReload(now, storage));

      const isShareLive = shareMode?.isLiveMode ?? false;
      const repository: string | undefined = isShareLive ? shareMode?.identity.repo : navState.selectedRepo;
      const branch: string | undefined = (isShareLive ? shareMode?.identity.branch : navState.selectedBranch) || 'main';
      const graph: string | undefined = isShareLive ? shareMode?.identity.graph : undefined;

      let gitPullDue = false;
      let detectedRemoteSha: string | null = null;
      if (
        repository &&
        !stalenessNudgeService.isSnoozed(
          'git-pull',
          (isShareLive && graph) ? `${repository}-${branch}-${graph}` : `${repository}-${branch}`,
          now,
          storage
        ) &&
        stalenessNudgeService.canPrompt('git-pull', now, storage)
      ) {
        if (isShareLive && graph) {
          const shouldCheck = stalenessNudgeService.shouldCheckShareRemoteHead({ repository, branch, graph }, now, storage);
          if (shouldCheck) {
            const status = await stalenessNudgeService.getShareRemoteAheadStatus({ repository, branch, graph }, storage);
            if (status.isRemoteAhead && status.remoteHeadSha) {
              if (!stalenessNudgeService.isShareRemoteShaDismissed({ repository, branch, graph }, status.remoteHeadSha, storage)) {
                gitPullDue = true;
                detectedRemoteSha = status.remoteHeadSha;
              }
            }
          }
        } else {
          // Rate-limited remote HEAD check (every 30 mins or on focus)
          const shouldCheck = stalenessNudgeService.shouldCheckRemoteHead(repository, branch, now, storage);
          if (shouldCheck) {
            const status = await stalenessNudgeService.getRemoteAheadStatus(repository, branch, storage);
            if (status.isRemoteAhead && status.remoteHeadSha) {
              // Only nudge if this SHA hasn't been dismissed
              if (!stalenessNudgeService.isRemoteShaDismissed(repository, branch, status.remoteHeadSha, storage)) {
                gitPullDue = true;
                detectedRemoteSha = status.remoteHeadSha;
              }
            }
          }
        }
      }

      let retrieveDue = false;
      let retrieveMostRecentRetrievedAtMs: number | undefined;
      if (activeFileId && !stalenessNudgeService.isSnoozed('retrieve-all-slices', activeFileId, now, storage)) {
        const activeFile = fileRegistry.getFile(activeFileId) as any;
        if (activeFile?.type === 'graph' && activeFile?.data && stalenessNudgeService.canPrompt('retrieve-all-slices', now, storage)) {
          const staleness = await stalenessNudgeService.getRetrieveAllSlicesStalenessStatus(
            activeFile.data,
            now,
            repository ? { repository, branch } : undefined
          );
          retrieveDue = staleness.isStale;
          // Prefer graph-level "last successful run" marker (cross-device), else fall back.
          retrieveMostRecentRetrievedAtMs = staleness.lastSuccessfulRunAtMs ?? staleness.mostRecentRetrievedAtMs;
        }
      }

      if (!reloadDue && !gitPullDue && !retrieveDue) return;

      // Mark prompted for due items so focus/visibility doesn't keep re-opening.
      if (reloadDue) stalenessNudgeService.markPrompted('reload', now, storage);
      if (gitPullDue) stalenessNudgeService.markPrompted('git-pull', now, storage);
      if (retrieveDue) stalenessNudgeService.markPrompted('retrieve-all-slices', now, storage);

      // "Last done" values must be derived from sources of truth:
      // - git pull: IDB workspace metadata (workspace.lastSynced)
      // - retrieve all: data freshness (connected parameters' retrieved_at)
      //
      // Avoid localStorage UI stamps; they lie when actions run via other entry points (scheduler, menus).
      let gitPullLastDoneAtMs: number | undefined;
      if (repository) {
        if (isShareLive && graph) {
          const f = fileRegistry.getFile(`graph-${graph}`) as any;
          gitPullLastDoneAtMs = typeof f?.lastSynced === 'number' ? f.lastSynced : undefined;
        } else {
          try {
            const ws = await db.workspaces.get(`${repository}-${branch}`);
            gitPullLastDoneAtMs = typeof ws?.lastSynced === 'number' ? ws.lastSynced : undefined;
          } catch {
            gitPullLastDoneAtMs = undefined;
          }
        }
      }

      const actions: Array<{
        key: StalenessUpdateActionKey;
        label: string;
        description: string;
        due: boolean;
        checked: boolean;
        disabled?: boolean;
        lastDoneAtMs?: number;
      }> = [
        {
          key: 'reload',
          label: 'Reload page',
          description: 'Ensures you’re on the latest client version and clears stale in-memory state.',
          due: reloadDue,
          checked: reloadDue,
          lastDoneAtMs: stalenessNudgeService.getLastPageLoadAtMs(storage),
        },
        {
          key: 'git-pull',
          label: 'Pull latest from git',
          description: 'Checks out the latest repository state (recommended if remote has new commits).',
          due: gitPullDue,
          checked: gitPullDue,
          disabled: !repository,
          lastDoneAtMs: gitPullLastDoneAtMs,
        },
        {
          key: 'retrieve-all-slices',
          label: 'Retrieve all slices (active graph)',
          description: 'Runs the Retrieve All Slices flow for the currently focused graph. Usually handled by daily cron; only due if >24h stale.',
          due: retrieveDue,
          checked: false,
          disabled: !activeFileId,
          lastDoneAtMs: retrieveMostRecentRetrievedAtMs,
        },
      ];

      setModalActions(actions);

      // Store the remote SHA for dismiss logic
      currentRemoteShaRef.current = detectedRemoteSha;

      // Share-live dashboard mode: non-blocking refresh UX (no modal).
      if (isShareLive && isDashboardMode && gitPullDue && detectedRemoteSha) {
        setShareAutoRefreshPending(true);
        setCountdownSeconds(STALENESS_NUDGE_COUNTDOWN_SECONDS);
        return;
      }

      setIsModalOpen(true);

      // Start countdown if git-pull is due (remote is ahead)
      if (gitPullDue && detectedRemoteSha) {
        setCountdownSeconds(STALENESS_NUDGE_COUNTDOWN_SECONDS);
      }
    } finally {
      inFlightRef.current = false;
    }
  }, [suppressStalenessNudges, navState.selectedRepo, navState.selectedBranch, activeFileId, fileRegistry, isModalOpen, shareMode, isDashboardMode]);

  // Record the page load baseline once on mount.
  useEffect(() => {
    stalenessNudgeService.recordPageLoad(Date.now(), window.localStorage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Countdown interval effect
  useEffect(() => {
    if (countdownSeconds === undefined || countdownSeconds <= 0) {
      return;
    }

    // Start the interval
    countdownIntervalRef.current = window.setInterval(() => {
      setCountdownSeconds(prev => {
        if (prev === undefined || prev <= 1) {
          // Countdown expired - will trigger auto-pull via separate effect
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      if (countdownIntervalRef.current !== null) {
        window.clearInterval(countdownIntervalRef.current);
        countdownIntervalRef.current = null;
      }
    };
  }, [countdownSeconds !== undefined && countdownSeconds > 0]);

  // Effect to handle countdown expiration
  useEffect(() => {
    if (countdownSeconds === 0 && (isModalOpen || shareAutoRefreshPending)) {
      void onCountdownExpire();
    }
  }, [countdownSeconds, isModalOpen, shareAutoRefreshPending, onCountdownExpire]);

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
  // Runs maybePrompt every 30 minutes, but only if tab is visible.
  // This supports dashboards left open but avoids wasting resources on background tabs.
  useEffect(() => {
    const intervalId = window.setInterval(() => {
      // Only poll if tab is visible (respects browser power management)
      if (!document.hidden) {
        void maybePrompt();
      }
    }, STALENESS_NUDGE_VISIBLE_POLL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [maybePrompt]);

  // Also re-check when the active graph file actually loads/changes (not just on focus).
  // This matters because staleness checks depend on graph content + connected parameter files.
  useEffect(() => {
    if (!activeFileId) return;
    const fr: any = fileRegistry as any;
    if (typeof fr.subscribe !== 'function') return;

    const unsubscribe = fr.subscribe(activeFileId, (updatedFile: any) => {
      if (!updatedFile) return;
      if (updatedFile.type !== 'graph') return;
      if (!updatedFile.data) return;

      // Debounce/re-trigger guard: only nudge-check when something meaningful changes.
      const lm = updatedFile.lastModified ?? 0;
      const key = `${activeFileId}:${lm}:${updatedFile.isLoaded ? 1 : 0}`;
      if (key === lastGraphTriggerKeyRef.current) return;
      lastGraphTriggerKeyRef.current = key;

      // Fire-and-forget: maybePrompt already rate-limits and won't open multiple modals at once.
      void maybePrompt();
    });

    return unsubscribe;
  }, [activeFileId, fileRegistry, maybePrompt]);

  const modal = React.createElement(StalenessUpdateModal, {
    isOpen: isModalOpen,
    actions: modalActions,
    automaticMode,
    onToggleAutomaticMode: toggleAutomaticMode,
    onToggle: toggleAction,
    onRun: onRunSelected,
    onSnooze: onSnoozeAll,
    // Backdrop/× close should behave like Snooze (avoid accidental long-lived dismissal).
    onClose: onSnoozeAll,
    // Explicit Dismiss button records SHA; won't prompt until next remote commit.
    onDismiss,
    countdownSeconds,
  });

  const shareLiveCountdown =
    shareAutoRefreshPending && countdownSeconds !== undefined
      ? React.createElement(
          'div',
          {
            style: {
              position: 'fixed',
              right: 12,
              bottom: 12,
              zIndex: 60,
              background: '#111827',
              color: '#fff',
              borderRadius: 10,
              padding: '10px 12px',
              fontSize: 12,
              boxShadow: '0 10px 25px rgba(0,0,0,0.25)',
            },
          },
          `Update pending — refreshing in ${countdownSeconds}s`
        )
      : null;

  if (suppressStalenessNudges) {
    return {
      modals: React.createElement(React.Fragment, null, conflictModal as any),
    };
  }

  return {
    modals: React.createElement(React.Fragment, null, conflictModal as any, shareLiveCountdown, modal),
  };
}


