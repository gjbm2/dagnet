import React, { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigatorContext } from '../contexts/NavigatorContext';
import { useTabContext, useFileRegistry } from '../contexts/TabContext';
import { stalenessNudgeService } from '../services/stalenessNudgeService';
import { requestRetrieveAllSlices } from './useRetrieveAllSlicesRequestListener';
import { usePullAll } from './usePullAll';
import { StalenessUpdateModal, type StalenessUpdateActionKey } from '../components/modals/StalenessUpdateModal';
import { retrieveAllSlicesService } from '../services/retrieveAllSlicesService';
import { sessionLogService } from '../services/sessionLogService';

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

  const closeModal = useCallback(() => setIsModalOpen(false), []);

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

    closeModal();
    await runSelectedKeys(selected);
    // "Automatic mode" only applies to the workflow the user just initiated.
    setAutomaticMode(false);
  }, [modalActions, closeModal, runSelectedKeys]);

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

  const maybePrompt = useCallback(async () => {
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
      if (
        repository &&
        !stalenessNudgeService.isSnoozed('git-pull', `${repository}-${branch}`, now, storage) &&
        stalenessNudgeService.canPrompt('git-pull', now, storage)
      ) {
        const shouldCheck = await stalenessNudgeService.shouldCheckGitPull(repository, branch, now);
        if (shouldCheck) {
          const status = await stalenessNudgeService.getRemoteAheadStatus(repository, branch);
          gitPullDue = status.isRemoteAhead;
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
      }> = [
        {
          key: 'reload',
          label: 'Reload page',
          description: 'Ensures you’re on the latest client version and clears stale in-memory state.',
          due: reloadDue,
          checked: reloadDue,
        },
        {
          key: 'git-pull',
          label: 'Pull latest from git',
          description: 'Checks out the latest repository state (recommended if remote has new commits).',
          due: gitPullDue,
          checked: gitPullDue,
          disabled: !repository,
        },
        {
          key: 'retrieve-all-slices',
          label: 'Retrieve all slices (active graph)',
          description: 'Runs the Retrieve All Slices flow for the currently focused graph.',
          due: retrieveDue,
          checked: retrieveDue,
          disabled: !activeFileId,
        },
      ];

      setModalActions(actions);

      setIsModalOpen(true);
    } finally {
      inFlightRef.current = false;
    }
  }, [navState.selectedRepo, navState.selectedBranch, activeFileId, fileRegistry, isModalOpen, runSelectedKeys]);

  // Record the page load baseline once on mount.
  useEffect(() => {
    stalenessNudgeService.recordPageLoad(Date.now(), window.localStorage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    onClose: closeModal,
  });

  return {
    modals: React.createElement(
      React.Fragment,
      null,
      conflictModal as any,
      modal
    ),
  };
}


