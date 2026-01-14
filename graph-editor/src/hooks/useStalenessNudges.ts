import React, { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigatorContext } from '../contexts/NavigatorContext';
import { useTabContext, useFileRegistry } from '../contexts/TabContext';
import { stalenessNudgeService } from '../services/stalenessNudgeService';
import { requestRetrieveAllSlices } from './useRetrieveAllSlicesRequestListener';
import { usePullAll } from './usePullAll';
import { StalenessUpdateModal, type StalenessUpdateActionKey } from '../components/modals/StalenessUpdateModal';
import { retrieveAllSlicesService } from '../services/retrieveAllSlicesService';
import { sessionLogService } from '../services/sessionLogService';
import { STALENESS_NUDGE_COUNTDOWN_SECONDS } from '../constants/staleness';

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

    const repo = navState.selectedRepo;
    const branch = navState.selectedBranch || 'main';
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
      await pullAll();
      if (repo) {
        stalenessNudgeService.recordDone('git-pull', Date.now(), `${repo}-${branch}`, storage);
      }
      // Clear dismissed SHA after successful pull so future changes are detected
      if (repo) {
        stalenessNudgeService.clearDismissedRemoteSha(repo, branch, storage);
      }
    }

    if (wantsRetrieve) {
      // SAFETY: never default retrieve-all to selected; record when the user explicitly triggers it.
      if (activeFileId) {
        stalenessNudgeService.recordDone('retrieve-all-slices', Date.now(), activeFileId, storage);
      }
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

          await retrieveAllSlicesService.execute({
            getGraph: () => (fileRegistry.getFile(activeFileId) as any)?.data || null,
            setGraph: (g) => tabOperations.updateTabData(activeFileId, g),
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

        await retrieveAllSlicesService.execute({
          getGraph: () => (fileRegistry.getFile(activeFileId) as any)?.data || null,
          setGraph: (g) => tabOperations.updateTabData(activeFileId, g),
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

    const repo = navState.selectedRepo;
    const branch = navState.selectedBranch || 'main';

    for (const a of modalActions) {
      if (!a.due) continue;
      if (a.key === 'reload') {
        stalenessNudgeService.snooze('reload', undefined, now, storage);
      } else if (a.key === 'git-pull') {
        if (repo) stalenessNudgeService.snooze('git-pull', `${repo}-${branch}`, now, storage);
      } else if (a.key === 'retrieve-all-slices') {
        if (activeFileId) stalenessNudgeService.snooze('retrieve-all-slices', activeFileId, now, storage);
      }
    }

    closeModal();
  }, [modalActions, navState.selectedRepo, navState.selectedBranch, activeFileId, closeModal]);

  /**
   * Dismiss: records the current remote SHA so user won't be nudged again
   * until the next cron cycle (when remote SHA changes).
   */
  const onDismiss = useCallback(() => {
    const storage = window.localStorage;
    const repo = navState.selectedRepo;
    const branch = navState.selectedBranch || 'main';
    const remoteSha = currentRemoteShaRef.current;

    // Record this SHA as dismissed - won't prompt again until new commit appears
    if (repo && remoteSha) {
      stalenessNudgeService.dismissRemoteSha(repo, branch, remoteSha, storage);
      sessionLogService.info(
        'session',
        'STALENESS_DISMISS',
        `Dismissed git-pull nudge for SHA ${remoteSha.slice(0, 7)}; won't prompt again until next remote commit`,
        undefined,
        { repository: repo, branch, remoteSha }
      );
    }

    closeModal();
  }, [navState.selectedRepo, navState.selectedBranch, closeModal]);

  /**
   * Auto-pull: called when countdown expires. Pulls from git ONLY (no retrieve-all).
   */
  const onCountdownExpire = useCallback(async () => {
    const repo = navState.selectedRepo;
    const branch = navState.selectedBranch || 'main';
    const storage = window.localStorage;

    sessionLogService.info(
      'session',
      'STALENESS_AUTO_PULL',
      'Auto-pulling from repository (countdown expired)',
      undefined,
      { repository: repo, branch }
    );

    stopCountdown();
    setIsModalOpen(false);

    // Execute git-pull only (not retrieve-all)
    await pullAll();
    if (repo) {
      stalenessNudgeService.recordDone('git-pull', Date.now(), `${repo}-${branch}`, storage);
    }

    // Clear dismissed SHA after successful pull (so future changes are detected)
    if (repo) {
      stalenessNudgeService.clearDismissedRemoteSha(repo, branch, storage);
    }
  }, [navState.selectedRepo, navState.selectedBranch, stopCountdown, pullAll]);

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
      const reloadDue =
        !stalenessNudgeService.isSnoozed('reload', undefined, now, storage) &&
        stalenessNudgeService.shouldPromptReload(now, storage);

      const repository: string | undefined = navState.selectedRepo;
      const branch: string | undefined = navState.selectedBranch || 'main';

      let gitPullDue = false;
      let detectedRemoteSha: string | null = null;
      if (
        repository &&
        !stalenessNudgeService.isSnoozed('git-pull', `${repository}-${branch}`, now, storage) &&
        stalenessNudgeService.canPrompt('git-pull', now, storage)
      ) {
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

      let retrieveDue = false;
      if (activeFileId && !stalenessNudgeService.isSnoozed('retrieve-all-slices', activeFileId, now, storage)) {
        const activeFile = fileRegistry.getFile(activeFileId) as any;
        if (activeFile?.type === 'graph' && activeFile?.data && stalenessNudgeService.canPrompt('retrieve-all-slices', now, storage)) {
          const staleness = await stalenessNudgeService.getRetrieveAllSlicesStalenessStatus(
            activeFile.data,
            now,
            repository ? { repository, branch } : undefined
          );
          retrieveDue = staleness.isStale;
        }
      }

      if (!reloadDue && !gitPullDue && !retrieveDue) return;

      // Mark prompted for due items so focus/visibility doesn't keep re-opening.
      if (reloadDue) stalenessNudgeService.markPrompted('reload', now, storage);
      if (gitPullDue) stalenessNudgeService.markPrompted('git-pull', now, storage);
      if (retrieveDue) stalenessNudgeService.markPrompted('retrieve-all-slices', now, storage);

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
          lastDoneAtMs: repository ? stalenessNudgeService.getLastDoneAtMs('git-pull', `${repository}-${branch}`, storage) : undefined,
        },
        {
          key: 'retrieve-all-slices',
          label: 'Retrieve all slices (active graph)',
          description: 'Runs the Retrieve All Slices flow for the currently focused graph. Usually handled by daily cron; only due if >24h stale.',
          due: retrieveDue,
          checked: false,
          disabled: !activeFileId,
          lastDoneAtMs: activeFileId ? stalenessNudgeService.getLastDoneAtMs('retrieve-all-slices', activeFileId, storage) : undefined,
        },
      ];

      setModalActions(actions);

      // Store the remote SHA for dismiss logic
      currentRemoteShaRef.current = detectedRemoteSha;

      setIsModalOpen(true);

      // Start countdown if git-pull is due (remote is ahead)
      if (gitPullDue && detectedRemoteSha) {
        setCountdownSeconds(STALENESS_NUDGE_COUNTDOWN_SECONDS);
      }
    } finally {
      inFlightRef.current = false;
    }
  }, [suppressStalenessNudges, navState.selectedRepo, navState.selectedBranch, activeFileId, fileRegistry, isModalOpen]);

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
    if (countdownSeconds === 0 && isModalOpen) {
      void onCountdownExpire();
    }
  }, [countdownSeconds, isModalOpen, onCountdownExpire]);

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
    const BACKGROUND_POLL_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

    const intervalId = window.setInterval(() => {
      // Only poll if tab is visible (respects browser power management)
      if (!document.hidden) {
        void maybePrompt();
      }
    }, BACKGROUND_POLL_INTERVAL_MS);

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

  if (suppressStalenessNudges) {
    return {
      modals: React.createElement(React.Fragment, null, conflictModal as any),
    };
  }

  return {
    modals: React.createElement(React.Fragment, null, conflictModal as any, modal),
  };
}


