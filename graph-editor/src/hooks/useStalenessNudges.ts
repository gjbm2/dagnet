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
import { countdownService } from '../services/countdownService';
import { useCountdown } from './useCountdown';
import { useDashboardMode } from '../contexts/DashboardModeContext';
import { liveShareSyncService } from '../services/liveShareSyncService';
import { repositoryOperationsService } from '../services/repositoryOperationsService';
import toast from 'react-hot-toast';
import { APP_VERSION } from '../version';
import { bannerManagerService } from '../services/bannerManagerService';

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
  const { state: navState, isLoading: navigatorIsLoading } = useNavigatorContext();
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
  const [isModalOpen, setIsModalOpen] = useState(false);
  const isModalOpenRef = useRef<boolean>(false);
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
  const [countdownKey, setCountdownKey] = useState<string | undefined>(undefined);
  const countdownKeyRef = useRef<string | undefined>(undefined);
  const countdownCancelTokenRef = useRef<number>(0);
  const countdownState = useCountdown(countdownKey);
  const countdownSeconds = countdownState?.secondsRemaining;
  // Track the remote SHA that triggered this modal (for dismiss logic)
  const currentRemoteShaRef = useRef<string | null>(null);
  // Share-live dashboard mode: refresh without a blocking modal.
  const [shareAutoRefreshPending, setShareAutoRefreshPending] = useState<boolean>(false);
  const shareAutoRefreshPendingRef = useRef<boolean>(false);

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
    // Cancel by prefix to guarantee we kill the correct timer even if the key changes mid-flight.
    countdownService.cancelCountdownsByPrefix('staleness:auto-pull:');
    countdownCancelTokenRef.current += 1;
    countdownKeyRef.current = undefined;
    setCountdownKey(undefined);
    shareAutoRefreshPendingRef.current = false;
    setShareAutoRefreshPending(false);
  }, []);

  const closeModal = useCallback(() => {
    stopCountdown();
    isModalOpenRef.current = false;
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

  const runSelectedKeys = useCallback(async (selected: Set<StalenessUpdateActionKey>) => {
    const now = Date.now();
    const storage = window.localStorage;

    const isShareLive = shareMode?.isLiveMode ?? false;
    const repo = isShareLive ? shareMode?.identity.repo : navState.selectedRepo;
    const branch = (isShareLive ? shareMode?.identity.branch : navState.selectedBranch) || 'main';
    const shareGraph = isShareLive ? shareMode?.identity.graph : undefined;

    // NOTE: execution orchestration is centralised in the service; the hook only supplies callbacks.
    await stalenessNudgeService.runSelectedStalenessActions({
      selected: selected as any,
      nowMs: now,
      storage,
      localAppVersion: APP_VERSION,
      repository: repo || undefined,
      branch,
      shareGraph,
      graphFileId: retrieveTargetGraphFileId,
      isShareLive,
      automaticMode,

      pullAll: async () => {
        await pullAll();
      },
      refreshLiveShareToLatest: async () => {
        return await liveShareSyncService.refreshToLatest();
      },
      pullLatestRemoteWins: async () => {
        if (!repo) return;
        await repositoryOperationsService.pullLatestRemoteWins(repo, branch);
      },

      requestRetrieveAllSlices,
      executeRetrieveAllSlicesHeadless: async ({ toastId, toastLabel }) => {
        if (!retrieveTargetGraphFileId) return;
        const graphFile = fileRegistry.getFile(retrieveTargetGraphFileId) as any;
        if (!graphFile?.data || graphFile?.type !== 'graph') return;
        if (!tabOperations?.updateTabData) return;

        await executeRetrieveAllSlicesWithProgressToast({
          getGraph: () => (fileRegistry.getFile(retrieveTargetGraphFileId) as any)?.data || null,
          setGraph: (g) => tabOperations.updateTabData(retrieveTargetGraphFileId, g),
          toastId,
          toastLabel,
        });
      },
      openSessionLogTab: () => {
        void sessionLogService.openLogTab();
      },
      getGraphData: () => {
        if (!retrieveTargetGraphFileId) return null;
        const graphAfterPull = (fileRegistry.getFile(retrieveTargetGraphFileId) as any)?.data || null;
        return graphAfterPull as any;
      },
      setGraphData: (g) => {
        if (!retrieveTargetGraphFileId) return;
        if (!tabOperations?.updateTabData) return;
        tabOperations.updateTabData(retrieveTargetGraphFileId, g);
      },

      reloadPage: () => window.location.reload(),
      notify: (kind, message) => {
        if (kind === 'success') toast.success(message);
        else toast.error(message);
      },
    });
  }, [navState.selectedRepo, navState.selectedBranch, activeFileId, pullAll, fileRegistry, tabOperations, automaticMode, shareMode]);

  const onRunSelected = useCallback(async () => {
    const selected = new Set(modalActions.filter(a => a.checked && !a.disabled).map(a => a.key));

    stopCountdown();
    isModalOpenRef.current = false;
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
        if (retrieveTargetGraphFileId) stalenessNudgeService.snooze('retrieve-all-slices', retrieveTargetGraphFileId, now, storage);
      }
    }

    closeModal();
  }, [modalActions, navState.selectedRepo, navState.selectedBranch, retrieveTargetGraphFileId, closeModal, shareMode]);

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

    stopCountdown();
    isModalOpenRef.current = false;
    setIsModalOpen(false);

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
          if (!isModalOpenRef.current && !shareAutoRefreshPendingRef.current) return;
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

  const maybePrompt = useCallback(async () => {
    if (suppressStalenessNudges) return;
    if (inFlightRef.current) return;
    if (!isVisible()) return;
    if (isModalOpen) return;

    inFlightRef.current = true;
    try {
      const now = Date.now();
      const storage = window.localStorage;

      // Boot readiness gate:
      // Nudges should NOT evaluate while app boot is incomplete, otherwise we get noisy "unknown/blocked"
      // states while Navigator/TabContext/file registry are still initialising.
      //
      // We wait for:
      // - TabContext boot completion (credentials/settings loaded + URL tabs opened)
      // - A stable repo/branch identity (workspace mode) OR share identity (share-live)
      if (!isTabContextInitDone()) return;

      // Always stamp this page load (the "last refresh" baseline).
      // We do this in maybePrompt rather than only once so hot reload / re-mounts
      // don't accidentally erase the signal.
      // (It is safe because in a real reload, the value should update anyway.)
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
      // This avoids a modal that nobody can click, and keeps kiosk consoles fresh.
      if (isDashboardMode && isOutdated) {
        const autoFn = (stalenessNudgeService as any).maybeAutoReloadForUpdate;
        if (typeof autoFn === 'function') {
          const didReload = !!autoFn.call(stalenessNudgeService, APP_VERSION, now, storage);
          if (didReload) return;
        }
      }

      // Reload nudge is version-delta driven ONLY.
      // Time-based reload prompts are intentionally not used (they were confusing and error-prone).
      const reloadDue = updateSignal.reloadDue;

      const isShareLive = shareMode?.isLiveMode ?? false;
      const repository: string | undefined = isShareLive ? shareMode?.identity.repo : navState.selectedRepo;
      const selectedBranch: string | undefined = isShareLive ? shareMode?.identity.branch : navState.selectedBranch;
      const branch: string = selectedBranch || 'main';
      const graph: string | undefined = isShareLive ? shareMode?.identity.graph : undefined;

      if (isShareLive) {
        // Share-live boot must provide identity before nudges run.
        if (!repository || !selectedBranch) return;
      } else {
        // Workspace mode: wait for NavigatorContext to finish initialising repo/branch (and stop loading).
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
      const retrieveMostRecentRetrievedAtMs = retrieveSignalCollected.retrieveMostRecentRetrievedAtMs;

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
      const gitPullLastDoneAtMs = gitCollected.gitPullLastDoneAtMs;

      // Build a deterministic cascade plan from the signals we already gathered.
      // NOTE: prompting/snooze/rate-limit decisions still live here for now; Phase 3+ centralises them.
      const remoteAppVersion = updateSignal.remoteAppVersion;
      const scope =
        repository
          ? isShareLive && graph
            ? ({ type: 'share-live', repository, branch, graph } as const)
            : ({ type: 'workspace', repository, branch } as const)
          : undefined;

      // Only include git signal if we actually performed a check in this run (otherwise treat as unknown).
      const gitSignal =
        detectedRemoteSha !== null
          ? ({
              isRemoteAhead: gitPullDue,
              localSha: undefined,
              remoteHeadSha: detectedRemoteSha,
            } as const)
          : undefined;

      const retrieveSignal = retrieveTargetGraphFileId
        ? ({
            isStale: retrieveDue,
            parameterCount: 0,
            staleParameterCount: 0,
            mostRecentRetrievedAtMs: retrieveMostRecentRetrievedAtMs,
          } as const)
        : undefined;

      const planFn = (stalenessNudgeService as any).computeNudgingPlanFromSignals;
      const plan =
        typeof planFn === 'function'
          ? planFn.call(stalenessNudgeService, {
              nowMs: now,
              entity:
                activeFileType === 'chart'
                  ? {
                      type: 'chart',
                      chartFileId: activeFileId,
                      parentGraphFileId: retrieveTargetGraphFileId,
                      effectiveQueryDsl: activeChartEffectiveDsl,
                    }
                  : { type: 'graph', graphFileId: activeFileId },
              scope,
              signals: {
                localAppVersion: APP_VERSION,
                remoteAppVersion,
                git: gitSignal,
                retrieve: retrieveSignal,
              },
            })
          : null;

      const actions: Array<{
        key: StalenessUpdateActionKey;
        label: string;
        description: string;
        due: boolean;
        checked: boolean;
        disabled?: boolean;
        status?: 'due' | 'blocked' | 'unknown' | 'not_due';
        lastDoneAtMs?: number;
      }> = [
        {
          key: 'reload',
          label: 'Reload page',
          description: (() => {
            const s = plan?.steps?.reload;
            if (s?.status === 'due') return `${s.reason}. Reload to update and clear stale in-memory state.`;
            if (s?.status === 'not_due' && s.reason) return s.reason;
            return 'Reload to clear stale in-memory state.';
          })(),
          due: reloadDue,
          checked: plan?.recommendedChecked?.reload ?? reloadDue,
          status: plan?.steps?.reload?.status,
          lastDoneAtMs: stalenessNudgeService.getLastPageLoadAtMs(storage),
        },
        {
          key: 'git-pull',
          label: 'Pull latest from git',
          description: plan?.steps?.['git-pull']?.reason || 'Checks out the latest repository state (recommended if remote has new commits).',
          due: gitPullDue,
          checked: plan?.recommendedChecked?.['git-pull'] ?? gitPullDue,
          status: plan?.steps?.['git-pull']?.status,
          disabled: !repository,
          lastDoneAtMs: gitPullLastDoneAtMs,
        },
        {
          key: 'retrieve-all-slices',
          label: activeFileType === 'chart' ? 'Retrieve all slices (parent graph)' : 'Retrieve all slices (active graph)',
          description: (() => {
            const base = 'Runs the Retrieve All Slices flow for the currently focused graph. Usually handled by daily cron; only due if >24h stale.';
            const s = plan?.steps?.['retrieve-all-slices'];
            if (s?.retrieveWithoutPull) return `${base} (Proceeding without pull: git state unknown.)`;
            if (s?.status === 'blocked' && s.blockedBy === 'git-pull') return `${base} (Blocked until pull completes.)`;
            if (activeFileType === 'chart') return `${base} (From a chart tab: uses the parent graph and this chart’s effective DSL for freshness.)`;
            return base;
          })(),
          due: retrieveDue,
          checked: plan?.recommendedChecked?.['retrieve-all-slices'] ?? false,
          status: plan?.steps?.['retrieve-all-slices']?.status,
          disabled: !retrieveTargetGraphFileId,
          lastDoneAtMs: retrieveMostRecentRetrievedAtMs,
        },
      ];

      setModalActions(actions);

      // Store the remote SHA for dismiss logic
      currentRemoteShaRef.current = detectedRemoteSha;

      // Share-live dashboard mode: non-blocking refresh UX (no modal).
      if (isShareLive && isDashboardMode && gitPullDue && detectedRemoteSha) {
        // If the user snoozed git-pull during this run, do not start a countdown afterwards.
        // (Prevents a race where the modal closes while this async function is still finishing.)
        const pullScope = repository ? `${repository}-${branch}-${graph}` : undefined;
        if (pullScope && stalenessNudgeService.isSnoozed('git-pull', pullScope, Date.now(), storage)) return;
        // Strict cascade: do not auto-pull in unattended mode when an update is due.
        if (plan?.steps?.reload?.status === 'due') return;
        shareAutoRefreshPendingRef.current = true;
        setShareAutoRefreshPending(true);
        const id = shareMode?.identity;
        if (id) {
          startCountdown({ key: `staleness:auto-pull:share:${id.repo}:${id.branch}:${id.graph}` });
        }
        return;
      }

      isModalOpenRef.current = true;
      setIsModalOpen(true);

      // Start countdown if git-pull is due (remote is ahead)
      if (gitPullDue && detectedRemoteSha) {
        // Strict cascade: do not start auto-pull countdown if update is due.
        if (plan?.steps?.reload?.status === 'due') return;
        const pullScope = repository
          ? (isShareLive && graph ? `${repository}-${branch}-${graph}` : `${repository}-${branch}`)
          : undefined;
        if (pullScope && stalenessNudgeService.isSnoozed('git-pull', pullScope, Date.now(), storage)) return;
        if (!isModalOpenRef.current) return;
        startCountdown({ key: `staleness:auto-pull:workspace:${navState.selectedRepo}:${navState.selectedBranch}:${activeFileId ?? 'unknown-graph'}` });
      }
    } finally {
      inFlightRef.current = false;
    }
  }, [suppressStalenessNudges, navState.selectedRepo, navState.selectedBranch, activeFileId, fileRegistry, isModalOpen, shareMode, isDashboardMode]);

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
    const subscribeFileId = retrieveTargetGraphFileId;
    if (!subscribeFileId) return;
    const fr: any = fileRegistry as any;
    if (typeof fr.subscribe !== 'function') return;

    const unsubscribe = fr.subscribe(subscribeFileId, (updatedFile: any) => {
      if (!updatedFile) return;
      if (updatedFile.type !== 'graph') return;
      if (!updatedFile.data) return;

      // Debounce/re-trigger guard: only nudge-check when something meaningful changes.
      const lm = updatedFile.lastModified ?? 0;
      const key = `${subscribeFileId}:${lm}:${updatedFile.isLoaded ? 1 : 0}`;
      if (key === lastGraphTriggerKeyRef.current) return;
      lastGraphTriggerKeyRef.current = key;

      // Fire-and-forget: maybePrompt already rate-limits and won't open multiple modals at once.
      void maybePrompt();
    });

    return unsubscribe;
  }, [retrieveTargetGraphFileId, fileRegistry, maybePrompt]);

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

  // Share-live countdown banner is owned by the central banner manager (not ad-hoc rendering here).
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

  if (suppressStalenessNudges) {
    return {
      modals: React.createElement(React.Fragment, null, conflictModal as any),
    };
  }

  return {
    modals: React.createElement(React.Fragment, null, conflictModal as any, modal),
  };
}


