import React, { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigatorContext } from '../contexts/NavigatorContext';
import { useTabContext, useFileRegistry } from '../contexts/TabContext';
import { stalenessNudgeService } from '../services/stalenessNudgeService';
import { requestRetrieveAllSlices } from './useRetrieveAllSlicesRequestListener';
import { usePullAll } from './usePullAll';
import { StalenessUpdateModal, type StalenessUpdateActionKey } from '../components/modals/StalenessUpdateModal';
import { retrieveAllSlicesService } from '../services/retrieveAllSlicesService';

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
  const [automaticMode, setAutomaticMode] = useState<boolean>(() =>
    stalenessNudgeService.getAutomaticMode(window.localStorage)
  );
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
    stalenessNudgeService.setAutomaticMode(enabled, window.localStorage);
  }, []);

  const runPendingPlanIfReady = useCallback(async () => {
    const plan = stalenessNudgeService.getPendingPlan(window.localStorage);
    if (!plan) return false;

    const repo = navState.selectedRepo;
    const branch = navState.selectedBranch || 'main';

    // Only run if we appear to be in the same repo/branch context as when scheduled.
    if (plan.repository && repo && plan.repository !== repo) return false;
    if (plan.branch && branch && plan.branch !== branch) return false;

    if (plan.pullAllLatest) {
      if (!repo) return false;
      await pullAll();
    }

    if (plan.retrieveAllSlices) {
      if (!plan.graphFileId) return false;
      const graphFile = fileRegistry.getFile(plan.graphFileId) as any;
      if (!graphFile?.data || graphFile?.type !== 'graph') return false;
      if (!tabOperations?.updateTabData) return false;

      await retrieveAllSlicesService.execute({
        getGraph: () => (fileRegistry.getFile(plan.graphFileId as string) as any)?.data || null,
        setGraph: (g) => tabOperations.updateTabData(plan.graphFileId, g),
      });
    }

    stalenessNudgeService.clearPendingPlan(window.localStorage);
    return true;
  }, [navState.selectedRepo, navState.selectedBranch, pullAll, fileRegistry, tabOperations]);

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

    if (wantsReload && (wantsPull || wantsRetrieve)) {
      stalenessNudgeService.setPendingPlan(
        {
          createdAtMs: now,
          repository: repo,
          branch,
          graphFileId,
          pullAllLatest: wantsPull,
          retrieveAllSlices: wantsRetrieve,
        },
        storage
      );
      window.location.reload();
      return;
    }

    if (wantsPull) {
      await pullAll();
    }

    if (wantsRetrieve) {
      if (opts?.headlessRetrieve) {
        if (!activeFileId) return;
        const graphFile = fileRegistry.getFile(activeFileId) as any;
        if (!graphFile?.data || graphFile?.type !== 'graph') return;
        if (!tabOperations?.updateTabData) return;

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
  }, [navState.selectedRepo, navState.selectedBranch, activeFileId, pullAll, fileRegistry, tabOperations]);

  const onRunSelected = useCallback(async () => {
    const selected = new Set(modalActions.filter(a => a.checked && !a.disabled).map(a => a.key));

    closeModal();
    await runSelectedKeys(selected);
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

      // First: if we have a pending plan (from "reload first"), try to run it.
      const ranPending = await runPendingPlanIfReady();
      if (ranPending) return;

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
          const staleness = stalenessNudgeService.getRetrieveAllSlicesStalenessStatus(activeFile.data, now);
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

      if (automaticMode) {
        const selected = new Set<StalenessUpdateActionKey>(actions.filter(a => a.due && !a.disabled).map(a => a.key));
        // Auto: run due actions without prompting. Conflicts (if any) will show via conflictModal.
        await runSelectedKeys(selected, { headlessRetrieve: true });
        return;
      }

      setIsModalOpen(true);
    } finally {
      inFlightRef.current = false;
    }
  }, [navState.selectedRepo, navState.selectedBranch, activeFileId, fileRegistry, isModalOpen, runPendingPlanIfReady, automaticMode, runSelectedKeys]);

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


